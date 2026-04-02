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
