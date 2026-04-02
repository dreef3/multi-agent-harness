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
