# Enterprise: Build, Release, CI/CD & Artifactory

## Current State

- CI: GitHub Actions (`ci.yml`) — runs backend type check + vitest, frontend type check + build (no frontend tests in CI)
- E2E: GitHub Actions (`e2e.yml`) — builds all images, runs Playwright tests
- No release pipeline, no image tagging, no registry push
- No npm registry configuration (packages installed from public npm)
- No versioning strategy
- Images built locally via `docker compose build`

## Target State

Dual CI/CD stack: GitHub Actions for open-source/local use, Jenkins or TeamCity for corporate. All artifacts (Docker images, npm packages) flow through Artifactory. Semantic versioning with automated releases.

---

## 1. Artifactory Integration

### Docker Images

All four images published to Artifactory Docker registry:

```
corp-artifactory.example.com/docker-local/multi-agent-harness/backend:1.2.3
corp-artifactory.example.com/docker-local/multi-agent-harness/frontend:1.2.3
corp-artifactory.example.com/docker-local/multi-agent-harness/planning-agent:1.2.3
corp-artifactory.example.com/docker-local/multi-agent-harness/sub-agent:1.2.3
```

**Tagging strategy:**
- `x.y.z` — release versions (immutable)
- `x.y.z-rc.N` — release candidates from CI
- `latest` — latest release
- `sha-<commit>` — every CI build (for traceability)

**Configuration:**
```
DOCKER_REGISTRY=corp-artifactory.example.com/docker-local
IMAGE_PREFIX=multi-agent-harness
```

Docker Compose and Helm values reference these:
```yaml
# values.yaml
image:
  registry: corp-artifactory.example.com/docker-local
  prefix: multi-agent-harness
  tag: "1.2.3"
  pullPolicy: IfNotPresent
  pullSecrets:
    - name: artifactory-pull-secret
```

### npm Registry

Artifactory as npm remote proxy (caches public packages) + local npm registry for internal packages.

**.npmrc for CI builds:**
```
registry=https://corp-artifactory.example.com/api/npm/npm-remote/
//corp-artifactory.example.com/api/npm/npm-remote/:_authToken=${ARTIFACTORY_NPM_TOKEN}
```

**bunfig.toml for Bun:**
```toml
[install]
registry = "https://corp-artifactory.example.com/api/npm/npm-remote/"
```

This ensures all dependency resolution goes through Artifactory — required for corporate network compliance and vulnerability scanning.

### Helm Charts

Helm charts published to Artifactory Helm repository:

```
corp-artifactory.example.com/helm-local/multi-agent-harness-1.2.3.tgz
```

Consumed by corporate deployment:
```bash
helm repo add harness https://corp-artifactory.example.com/api/helm/helm-local
helm install harness harness/multi-agent-harness -f values-corp.yaml
```

---

## 2. Dual VCS Support

### GitHub + GitHub Actions (Default)

Current CI lives here. Extended with:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push, PR | Type check, unit tests (backend + frontend), lint |
| `e2e.yml` | Push to main, PR, manual | Build images, E2E tests |
| `release.yml` | Tag `v*` | Build images, push to GHCR + optionally Artifactory, create GitHub Release |
| `helm-publish.yml` | Tag `v*` | Package and push Helm chart |

**Image registries for GitHub mode:**
- Primary: `ghcr.io/dreef3/multi-agent-harness/*` (GitHub Container Registry)
- Optional: Push to Artifactory too (for corporate environments that source from GitHub but deploy via Artifactory)

### Bitbucket Server + Jenkins

**Jenkinsfile** (Declarative Pipeline) at repo root:

```groovy
pipeline {
    agent { label 'docker' }

    environment {
        REGISTRY = credentials('artifactory-docker-registry')
        NPM_TOKEN = credentials('artifactory-npm-token')
    }

    stages {
        stage('Install & Test') {
            parallel {
                stage('Backend') {
                    steps {
                        dir('backend') {
                            sh 'bun install'
                            sh 'bunx tsc --noEmit'
                            sh 'bun run test'
                        }
                    }
                }
                stage('Frontend') {
                    steps {
                        dir('frontend') {
                            sh 'bun install'
                            sh 'bunx tsc --noEmit'
                            sh 'bun run test'
                            sh 'bun run build'
                        }
                    }
                }
            }
        }

        stage('Build Images') {
            steps {
                sh "docker build -t ${REGISTRY}/backend:${BUILD_TAG} ./backend"
                sh "docker build -t ${REGISTRY}/frontend:${BUILD_TAG} ./frontend"
                sh "docker build -t ${REGISTRY}/planning-agent:${BUILD_TAG} -f planning-agent/Dockerfile ."
                sh "docker build -t ${REGISTRY}/sub-agent:${BUILD_TAG} -f sub-agent/Dockerfile ."
            }
        }

        stage('Push Images') {
            when { branch 'main' }
            steps {
                sh "docker push ${REGISTRY}/backend:${BUILD_TAG}"
                sh "docker push ${REGISTRY}/frontend:${BUILD_TAG}"
                sh "docker push ${REGISTRY}/planning-agent:${BUILD_TAG}"
                sh "docker push ${REGISTRY}/sub-agent:${BUILD_TAG}"
            }
        }

        stage('E2E Tests') {
            when { branch 'main' }
            steps {
                sh 'docker compose up -d'
                dir('e2e-tests') {
                    sh 'bunx playwright test'
                }
            }
            post {
                always { sh 'docker compose down' }
            }
        }
    }
}
```

### Bitbucket Server + TeamCity

**`.teamcity/settings.kts`** (Kotlin DSL):

TeamCity build configuration with the same stages as Jenkins but in TeamCity's native format. Build steps reference shared templates for Docker build, test, and push.

Key difference: TeamCity uses build configurations and VCS triggers rather than a Jenkinsfile. The `.teamcity/` directory contains Kotlin DSL that TeamCity syncs from the repo.

---

## 3. CI/CD Pipeline Design

### Build Matrix

Every CI run builds and tests against all configured base image targets:

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐
│ Test         │    │ Build Images │    │ Push          │
│              │    │              │    │              │
│ Backend unit │───▶│ Debian (dev) │───▶│ GHCR         │
│ Frontend unit│    │ UBI8 (corp)  │    │ Artifactory  │
│ Lint/typecheck│   │ Wolfi (corp) │    │              │
└─────────────┘    └──────────────┘    └──────────────┘
                          │
                          ▼
                   ┌──────────────┐    ┌──────────────┐
                   │ E2E Tests    │    │ Helm Package  │
                   │ (Debian imgs)│    │ & Publish     │
                   └──────────────┘    └──────────────┘
```

Corporate CI (Jenkins/TeamCity) only builds UBI or Wolfi targets. GitHub Actions builds all three for validation but only publishes Debian to GHCR.

### Release Flow

```
1. Developer merges PR to main
2. CI runs tests, builds images, pushes sha-tagged images
3. Release manager creates tag: git tag v1.2.3 && git push --tags
4. Release pipeline:
   a. Builds final images with version tag
   b. Pushes to Artifactory (UBI + Wolfi) and GHCR (Debian)
   c. Packages Helm chart with appVersion=1.2.3
   d. Publishes Helm chart to Artifactory
   e. Creates GitHub Release with changelog (GitHub mode only)
```

---

## 4. Versioning

### Semantic Versioning

```
MAJOR.MINOR.PATCH
```

- **MAJOR**: Breaking API changes, database schema changes requiring migration, incompatible config changes
- **MINOR**: New features, new API endpoints, new config options with defaults
- **PATCH**: Bug fixes, security patches, dependency updates

### Version Source

Single source of truth: `package.json` at repo root. The version field is read by:
- Docker image tags
- Helm chart `appVersion`
- Backend `/api/health` endpoint (for deployment verification)
- `HARNESS_VERSION` env var injected into containers

### Changelog

Conventional commits (`feat:`, `fix:`, `chore:`) parsed by `conventional-changelog` or `release-please` to auto-generate `CHANGELOG.md`.

---

## 5. Artifact Bill of Materials

For corporate compliance, each release publishes:

| Artifact | Format | Location |
|----------|--------|----------|
| Docker images (4) | OCI | Artifactory docker-local |
| Helm chart | .tgz | Artifactory helm-local |
| SBOM per image | SPDX JSON | Attached to Artifactory image manifest |
| Vulnerability scan | Sarif/JSON | Artifactory Xray (if enabled) |
| Source archive | .tar.gz | GitHub Release or Artifactory generic-local |

**SBOM generation** (added to Dockerfile builds):
```bash
# After docker build:
docker sbom multi-agent-harness/backend:1.2.3 --format spdx-json > sbom-backend.json
# Or use syft:
syft multi-agent-harness/backend:1.2.3 -o spdx-json > sbom-backend.json
```

---

## 6. Local Development Pipeline

For developers running locally, the existing workflow is preserved:

```bash
# Build all images locally (Debian base, no registry)
docker compose build

# Run everything
docker compose up

# Run tests
bun run test          # backend
bun run --cwd frontend test  # frontend
bun run e2e           # e2e
```

No Artifactory, no registry push, no Helm. Just Docker Compose.

To use corporate images locally:
```bash
# Pull from Artifactory
docker compose -f docker-compose.yml -f docker-compose.corp.yaml up
```

Where `docker-compose.corp.yaml` overrides image names to Artifactory paths.
