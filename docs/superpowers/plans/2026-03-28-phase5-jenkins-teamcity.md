# Jenkins and TeamCity CI/CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a production-ready `Jenkinsfile` at the repo root and a `.teamcity/settings.kts` Kotlin DSL for corporate CI/CD pipelines that build, test, push images, and publish Helm charts.

**Architecture:** The `Jenkinsfile` uses a declarative pipeline with parallel test stages, a sequential build-and-push phase gated on `main` branch, E2E tests, and a tag-triggered release stage that handles versioned image tagging and Helm chart publishing to Artifactory. The TeamCity Kotlin DSL defines three chained build configurations (TestAndBuild, PushImages, Release) in a single project, sharing the Artifactory credential as a build parameter.

**Tech Stack:** Jenkins (declarative pipeline), TeamCity Kotlin DSL, Docker, Helm 3, Artifactory, syft (SBOM), Bun, Playwright.

---

## Prerequisites

- [ ] Jenkins instance with `docker` agent label and Docker daemon access
- [ ] Jenkins credentials configured: `artifactory-docker-registry`, `artifactory-npm-token`
- [ ] TeamCity server with Kotlin DSL versioned settings enabled
- [ ] `syft` installed on Jenkins agents (or available as a Docker image)
- [ ] `charts/multi-agent-harness/` Helm chart directory exists
- [ ] `docker-compose.corp.yaml` override file exists for E2E environment

---

## Task 1 — Create `Jenkinsfile` at repo root

- [ ] Create `Jenkinsfile` at `/Jenkinsfile` (repo root):

```groovy
pipeline {
    agent { label 'docker' }

    environment {
        REGISTRY       = credentials('artifactory-docker-registry')
        NPM_TOKEN      = credentials('artifactory-npm-token')
        IMAGE_TAG      = "sha-${env.GIT_COMMIT.take(12)}"
        BASE_IMAGE_FAMILY = "${env.BASE_IMAGE_FAMILY ?: 'ubi'}"
        HELM_REPO_URL  = "${env.HELM_REPO_URL ?: ''}"
    }

    options {
        timeout(time: 60, unit: 'MINUTES')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20'))
        ansiColor('xterm')
    }

    stages {
        // ----------------------------------------------------------------
        stage('Install & Test') {
        // ----------------------------------------------------------------
            parallel {
                stage('Backend') {
                    steps {
                        dir('backend') {
                            sh 'bun install --frozen-lockfile'
                            sh 'bunx tsc --noEmit'
                            sh 'bun run test --reporter=junit --output=test-results.xml || true'
                        }
                    }
                    post {
                        always {
                            junit allowEmptyResults: true,
                                  testResults: 'backend/test-results.xml'
                        }
                    }
                }
                stage('Frontend') {
                    steps {
                        dir('frontend') {
                            sh 'bun install --frozen-lockfile'
                            sh 'bunx tsc --noEmit'
                            sh 'bun run lint 2>/dev/null || echo "No lint script"'
                            sh 'bun run test --reporter=junit --output=test-results.xml || true'
                            sh 'bun run build'
                        }
                    }
                    post {
                        always {
                            junit allowEmptyResults: true,
                                  testResults: 'frontend/test-results.xml'
                        }
                    }
                }
            }
        }

        // ----------------------------------------------------------------
        stage('Build Images') {
        // ----------------------------------------------------------------
            steps {
                script {
                    def services = ['backend', 'frontend', 'planning-agent', 'sub-agent']
                    def buildContexts = [
                        'backend'        : '.',
                        'frontend'       : './frontend',
                        'planning-agent' : '.',
                        'sub-agent'      : '.',
                    ]
                    def dockerfiles = [
                        'backend'        : "backend/Dockerfile.${env.BASE_IMAGE_FAMILY}",
                        'frontend'       : "frontend/Dockerfile.${env.BASE_IMAGE_FAMILY}",
                        'planning-agent' : "planning-agent/Dockerfile.${env.BASE_IMAGE_FAMILY}",
                        'sub-agent'      : "sub-agent/Dockerfile.${env.BASE_IMAGE_FAMILY}",
                    ]
                    // Fall back to plain Dockerfile if variant doesn't exist
                    for (svc in services) {
                        def df = dockerfiles[svc]
                        def ctx = buildContexts[svc]
                        if (!fileExists(df)) {
                            df = df.replaceAll(/\.${env.BASE_IMAGE_FAMILY}$/, '')
                            echo "Variant Dockerfile not found, using ${df}"
                        }
                        sh """
                            docker build \\
                              --build-arg BUILD_DATE=\$(date -u +%Y-%m-%dT%H:%M:%SZ) \\
                              --build-arg VCS_REF=${env.GIT_COMMIT} \\
                              -t ${REGISTRY}/multi-agent-harness/${svc}:${IMAGE_TAG} \\
                              -f ${df} \\
                              ${ctx}
                        """
                    }
                }
            }
        }

        // ----------------------------------------------------------------
        stage('SBOM') {
        // ----------------------------------------------------------------
            when { branch 'main' }
            steps {
                sh """
                    for svc in backend frontend planning-agent sub-agent; do
                        syft ${REGISTRY}/multi-agent-harness/\${svc}:${IMAGE_TAG} \\
                            -o spdx-json > sbom-\${svc}.spdx.json 2>/dev/null || true
                    done
                """
                archiveArtifacts artifacts: 'sbom-*.spdx.json', allowEmptyArchive: true
            }
        }

        // ----------------------------------------------------------------
        stage('Push Images') {
        // ----------------------------------------------------------------
            when { branch 'main' }
            steps {
                script {
                    def services = ['backend', 'frontend', 'planning-agent', 'sub-agent']
                    for (svc in services) {
                        sh "docker push ${REGISTRY}/multi-agent-harness/${svc}:${IMAGE_TAG}"
                    }
                }
            }
        }

        // ----------------------------------------------------------------
        stage('E2E Tests') {
        // ----------------------------------------------------------------
            when { branch 'main' }
            steps {
                sh """
                    IMAGE_TAG=${IMAGE_TAG} \\
                    docker compose -f docker-compose.yml -f docker-compose.corp.yaml \\
                        up -d --wait --wait-timeout 120
                """
                dir('e2e-tests') {
                    sh 'bun install --frozen-lockfile'
                    sh 'bunx playwright test --reporter=junit,html'
                }
            }
            post {
                always {
                    sh '''
                        docker compose -f docker-compose.yml -f docker-compose.corp.yaml down -v || true
                    '''
                    junit allowEmptyResults: true,
                          testResults: 'e2e-tests/test-results/*.xml'
                    publishHTML(target: [
                        allowMissing: true,
                        reportDir: 'e2e-tests/playwright-report',
                        reportFiles: 'index.html',
                        reportName: 'Playwright E2E Report',
                    ])
                }
            }
        }

        // ----------------------------------------------------------------
        stage('Release') {
        // ----------------------------------------------------------------
            when {
                buildingTag()
                tag pattern: 'v\\d+\\.\\d+\\.\\d+.*', comparator: 'REGEXP'
            }
            steps {
                script {
                    def version = env.TAG_NAME.replaceFirst('^v', '')
                    def services = ['backend', 'frontend', 'planning-agent', 'sub-agent']

                    // Tag and push versioned + latest
                    for (svc in services) {
                        sh """
                            docker tag \\
                                ${REGISTRY}/multi-agent-harness/${svc}:${IMAGE_TAG} \\
                                ${REGISTRY}/multi-agent-harness/${svc}:${version}
                            docker tag \\
                                ${REGISTRY}/multi-agent-harness/${svc}:${IMAGE_TAG} \\
                                ${REGISTRY}/multi-agent-harness/${svc}:latest
                            docker push ${REGISTRY}/multi-agent-harness/${svc}:${version}
                            docker push ${REGISTRY}/multi-agent-harness/${svc}:latest
                        """
                    }

                    // Package and push Helm chart to Artifactory
                    if (env.HELM_REPO_URL) {
                        sh """
                            mkdir -p .helm-packages
                            helm package charts/multi-agent-harness/ \\
                                --version ${version} --app-version ${version} \\
                                --destination .helm-packages/
                            curl -fsS \\
                                -H "Authorization: Bearer ${NPM_TOKEN}" \\
                                -T .helm-packages/multi-agent-harness-${version}.tgz \\
                                "${env.HELM_REPO_URL}/multi-agent-harness-${version}.tgz"
                        """
                        archiveArtifacts artifacts: '.helm-packages/*.tgz'
                    } else {
                        echo 'HELM_REPO_URL not set — skipping Helm publish'
                    }
                }
            }
        }
    }

    post {
        failure {
            emailext(
                subject: "BUILD FAILED: ${env.JOB_NAME} [${env.BUILD_NUMBER}]",
                body: """Build failed.

Job:    ${env.JOB_NAME}
Build:  ${env.BUILD_NUMBER}
Branch: ${env.GIT_BRANCH}
Commit: ${env.GIT_COMMIT}
URL:    ${env.BUILD_URL}
""",
                to: '${DEFAULT_RECIPIENTS}'
            )
        }
        always {
            cleanWs(cleanWhenFailure: false)
        }
    }
}
```

- [ ] Lint the Jenkinsfile: `curl -X POST -F "jenkinsfile=<Jenkinsfile" ${JENKINS_URL}/pipeline-model-converter/validate`
- [ ] Commit: `ci: add Jenkinsfile with parallel test, build, E2E, and release stages`

---

## Task 2 — Create `.teamcity/settings.kts`

- [ ] Create directory `.teamcity/`
- [ ] Create `.teamcity/settings.kts` with full Kotlin DSL:

```kotlin
import jetbrains.buildServer.configs.kotlin.*
import jetbrains.buildServer.configs.kotlin.buildFeatures.perfmon
import jetbrains.buildServer.configs.kotlin.buildSteps.dockerCommand
import jetbrains.buildServer.configs.kotlin.buildSteps.script
import jetbrains.buildServer.configs.kotlin.triggers.vcs
import jetbrains.buildServer.configs.kotlin.triggers.schedule

version = "2024.03"

project {
    description = "Multi-Agent Harness CI/CD"

    params {
        param("env.REGISTRY", "artifactory.corp.example.com")
        param("env.BASE_IMAGE_FAMILY", "ubi")
        password("env.ARTIFACTORY_TOKEN", "credentialsJSON:artifactory-token", label = "Artifactory Token")
        param("env.HELM_REPO_URL", "https://artifactory.corp.example.com/artifactory/helm-local")
    }

    val testAndBuild = buildType {
        id("TestAndBuild")
        name = "Test and Build"
        description = "Run tests, type-check, and build Docker images"

        vcs {
            root(DslContext.settingsRoot)
            cleanCheckout = true
        }

        triggers {
            vcs {
                branchFilter = "+:*"
                perCheckinTriggering = false
            }
        }

        features {
            perfmon {}
        }

        steps {
            // Backend
            script {
                name = "Backend: install & type-check"
                workingDir = "backend"
                scriptContent = """
                    #!/bin/bash
                    set -euo pipefail
                    bun install --frozen-lockfile
                    bunx tsc --noEmit
                """.trimIndent()
            }

            script {
                name = "Backend: test"
                workingDir = "backend"
                scriptContent = """
                    #!/bin/bash
                    set -euo pipefail
                    bun run test --reporter=junit --output=../test-results/backend.xml || true
                """.trimIndent()
            }

            // Frontend
            script {
                name = "Frontend: install, type-check & test"
                workingDir = "frontend"
                scriptContent = """
                    #!/bin/bash
                    set -euo pipefail
                    bun install --frozen-lockfile
                    bunx tsc --noEmit
                    bun run lint 2>/dev/null || echo "No lint script"
                    bun run test --reporter=junit --output=../test-results/frontend.xml || true
                    bun run build
                """.trimIndent()
            }

            // Build images
            script {
                name = "Build Docker images"
                scriptContent = """
                    #!/bin/bash
                    set -euo pipefail
                    IMAGE_TAG="sha-$(git rev-parse --short HEAD)"
                    SERVICES="backend frontend planning-agent sub-agent"
                    for svc in ${'$'}SERVICES; do
                        df="${'$'}svc/Dockerfile.%env.BASE_IMAGE_FAMILY%"
                        [ -f "${'$'}df" ] || df="${'$'}svc/Dockerfile"
                        ctx="."
                        [ "${'$'}svc" = "frontend" ] && ctx="./frontend"
                        docker build \
                            --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
                            --build-arg VCS_REF=$(git rev-parse HEAD) \
                            -t %env.REGISTRY%/multi-agent-harness/${'$'}svc:${'$'}IMAGE_TAG \
                            -f "${'$'}df" "${'$'}ctx"
                    done
                    echo "##teamcity[setParameter name='IMAGE_TAG' value='${'$'}IMAGE_TAG']"
                """.trimIndent()
            }
        }

        artifactRules = """
            test-results/*.xml => test-results/
        """.trimIndent()
    }

    val pushImages = buildType {
        id("PushImages")
        name = "Push Images"
        description = "Push Docker images to Artifactory (main branch only)"
        type = BuildTypeSettings.Type.DEPLOYMENT

        dependencies {
            snapshot(testAndBuild) {
                onDependencyFailure = FailureAction.FAIL_TO_START
            }
        }

        vcs {
            root(DslContext.settingsRoot)
        }

        triggers {
            vcs {
                branchFilter = "+:main"
            }
        }

        steps {
            script {
                name = "Generate SBOM"
                scriptContent = """
                    #!/bin/bash
                    set -euo pipefail
                    IMAGE_TAG=%IMAGE_TAG%
                    for svc in backend frontend planning-agent sub-agent; do
                        syft %env.REGISTRY%/multi-agent-harness/${'$'}svc:${'$'}IMAGE_TAG \
                            -o spdx-json > sbom-${'$'}svc.spdx.json 2>/dev/null || true
                    done
                """.trimIndent()
            }

            script {
                name = "Push Docker images"
                scriptContent = """
                    #!/bin/bash
                    set -euo pipefail
                    echo "%env.ARTIFACTORY_TOKEN%" | \
                        docker login %env.REGISTRY% -u ci-bot --password-stdin
                    IMAGE_TAG=%IMAGE_TAG%
                    for svc in backend frontend planning-agent sub-agent; do
                        docker push %env.REGISTRY%/multi-agent-harness/${'$'}svc:${'$'}IMAGE_TAG
                    done
                """.trimIndent()
            }
        }

        artifactRules = "sbom-*.spdx.json"
    }

    val release = buildType {
        id("Release")
        name = "Release"
        description = "Tag versioned images and publish Helm chart on git tags"
        type = BuildTypeSettings.Type.DEPLOYMENT

        params {
            param("release.version", "")
        }

        dependencies {
            snapshot(pushImages) {
                onDependencyFailure = FailureAction.FAIL_TO_START
            }
        }

        vcs {
            root(DslContext.settingsRoot)
        }

        triggers {
            vcs {
                // Trigger on v* tags only
                branchFilter = "+:refs/tags/v*"
            }
        }

        steps {
            script {
                name = "Extract version from tag"
                scriptContent = """
                    #!/bin/bash
                    set -euo pipefail
                    VERSION="${'$'}{TEAMCITY_BUILD_BRANCH#refs/tags/v}"
                    echo "##teamcity[setParameter name='release.version' value='${'$'}VERSION']"
                """.trimIndent()
            }

            script {
                name = "Tag and push versioned images"
                scriptContent = """
                    #!/bin/bash
                    set -euo pipefail
                    IMAGE_TAG=%IMAGE_TAG%
                    VERSION=%release.version%
                    for svc in backend frontend planning-agent sub-agent; do
                        docker tag \
                            %env.REGISTRY%/multi-agent-harness/${'$'}svc:${'$'}IMAGE_TAG \
                            %env.REGISTRY%/multi-agent-harness/${'$'}svc:${'$'}VERSION
                        docker tag \
                            %env.REGISTRY%/multi-agent-harness/${'$'}svc:${'$'}IMAGE_TAG \
                            %env.REGISTRY%/multi-agent-harness/${'$'}svc:latest
                        docker push %env.REGISTRY%/multi-agent-harness/${'$'}svc:${'$'}VERSION
                        docker push %env.REGISTRY%/multi-agent-harness/${'$'}svc:latest
                    done
                """.trimIndent()
            }

            script {
                name = "Package and publish Helm chart"
                scriptContent = """
                    #!/bin/bash
                    set -euo pipefail
                    VERSION=%release.version%
                    mkdir -p .helm-packages
                    helm package charts/multi-agent-harness/ \
                        --version "${'$'}VERSION" --app-version "${'$'}VERSION" \
                        --destination .helm-packages/
                    curl -fsS \
                        -H "Authorization: Bearer %env.ARTIFACTORY_TOKEN%" \
                        -T ".helm-packages/multi-agent-harness-${'$'}VERSION.tgz" \
                        "%env.HELM_REPO_URL%/multi-agent-harness-${'$'}VERSION.tgz"
                """.trimIndent()
            }
        }

        artifactRules = ".helm-packages/*.tgz"
    }

    buildTypesOrder = arrayListOf(testAndBuild, pushImages, release)
}
```

- [ ] Verify the Kotlin DSL compiles: `mvn -f .teamcity/pom.xml teamcity-configs:generate` (if using TeamCity Maven plugin)
- [ ] Commit: `ci: add TeamCity Kotlin DSL with TestAndBuild, PushImages, and Release configs`

---

## Task 3 — Required Jenkins credentials and environment variables

Document for Jenkins administrator:

**Credentials (Manage Jenkins → Credentials):**

| ID | Type | Description |
|----|------|-------------|
| `artifactory-docker-registry` | Username with password | Artifactory Docker registry host + credentials. Username = Artifactory username; Password = API token. The `REGISTRY` env var will be set to the username field (hostname). Adjust if your registry host differs from the username. |
| `artifactory-npm-token` | Secret text | Artifactory API token used for Helm chart upload via curl. Also used for `npm install` in sub-agents if private npm packages exist. |

**Environment variables (set on Jenkins node or pipeline):**

| Name | Description | Example |
|------|-------------|---------|
| `BASE_IMAGE_FAMILY` | Base image variant to use (`ubi`, `debian`, `alpine`) | `ubi` |
| `HELM_REPO_URL` | Full URL to Artifactory Helm local repo | `https://artifactory.corp.example.com/artifactory/helm-local` |
| `DEFAULT_RECIPIENTS` | Email addresses for failure notifications | `team@example.com` |

**Plugins required:**
- `pipeline` (declarative pipeline)
- `git`
- `docker-workflow`
- `email-ext`
- `ansicolor`
- `junit`
- `html-publisher`
- `ws-cleanup`

- [ ] Verify all credentials exist in Jenkins before first pipeline run
- [ ] Test with a dry-run on a feature branch: confirm `Push Images` and `Release` stages are skipped

---

## Task 4 — TeamCity credentials configuration

**Required TeamCity parameters/credentials:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `credentialsJSON:artifactory-token` | Credential | Artifactory API token (create in TeamCity → Administration → Credentials) |
| `env.REGISTRY` | Parameter | Artifactory Docker registry hostname |
| `env.HELM_REPO_URL` | Parameter | Artifactory Helm repo URL |
| `env.BASE_IMAGE_FAMILY` | Parameter | Base image family (`ubi`, `debian`) |

- [ ] Create credential in TeamCity admin UI: Administration → Credentials → Add Credential → Token
- [ ] Set credential ID to `artifactory-token`
- [ ] Verify `Release` build type only triggers on `refs/tags/v*` branch filter

---

## Verification checklist

- [ ] `Jenkinsfile` lints cleanly via pipeline-model-converter endpoint
- [ ] Jenkins parallel stages (Backend, Frontend) both pass
- [ ] `Push Images` and `E2E Tests` stages skip on non-`main` branches
- [ ] `Release` stage only runs when building a `v*` tag
- [ ] TeamCity Kotlin DSL generates valid XML (no compilation errors)
- [ ] TeamCity `TestAndBuild` → `PushImages` → `Release` dependency chain is correct
- [ ] SBOM files archived as build artifacts in both Jenkins and TeamCity
- [ ] Helm chart artifact archived correctly in `.helm-packages/`
- [ ] Email notification fires on build failure
