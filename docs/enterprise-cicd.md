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
- Optional: Push to Artifactory too, enabled via `PUSH_TO_ARTIFACTORY=true` repository secret in GitHub Actions (for corporate environments that source from GitHub but deploy via Artifactory)

### Bitbucket Server + Jenkins

**Jenkinsfile** (Declarative Pipeline) at repo root:

```groovy
pipeline {
    agent { label 'docker' }

    environment {
        REGISTRY = credentials('artifactory-docker-registry')
        NPM_TOKEN = credentials('artifactory-npm-token')
        IMAGE_TAG = "sha-${env.GIT_COMMIT.take(12)}"
        // BASE_IMAGE_FAMILY: 'ubi' or 'wolfi' — selects Dockerfile.<family> for all image builds
        BASE_IMAGE_FAMILY = "${env.BASE_IMAGE_FAMILY ?: 'ubi'}"
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
                sh "docker build -t ${REGISTRY}/backend:${IMAGE_TAG} -f backend/Dockerfile.${BASE_IMAGE_FAMILY} ./backend"
                sh "docker build -t ${REGISTRY}/frontend:${IMAGE_TAG} -f frontend/Dockerfile.${BASE_IMAGE_FAMILY} ./frontend"
                sh "docker build -t ${REGISTRY}/planning-agent:${IMAGE_TAG} -f planning-agent/Dockerfile.${BASE_IMAGE_FAMILY} ."
                sh "docker build -t ${REGISTRY}/sub-agent:${IMAGE_TAG} -f sub-agent/Dockerfile.${BASE_IMAGE_FAMILY} ."
            }
        }

        stage('Push Images') {
            when { branch 'main' }
            steps {
                sh "docker push ${REGISTRY}/backend:${IMAGE_TAG}"
                sh "docker push ${REGISTRY}/frontend:${IMAGE_TAG}"
                sh "docker push ${REGISTRY}/planning-agent:${IMAGE_TAG}"
                sh "docker push ${REGISTRY}/sub-agent:${IMAGE_TAG}"
            }
        }

        stage('E2E Tests') {
            when { branch 'main' }
            steps {
                sh "IMAGE_TAG=${IMAGE_TAG} docker compose -f docker-compose.yml -f docker-compose.corp.yaml up -d"
                dir('e2e-tests') {
                    sh 'bunx playwright test'
                }
            }
            post {
                always { sh 'docker compose -f docker-compose.yml -f docker-compose.corp.yaml down' }
            }
        }
    }
}
```

### Bitbucket Server + TeamCity

**`.teamcity/settings.kts`** (Kotlin DSL):

```kotlin
import jetbrains.buildServer.configs.kotlin.v2019_2.*
import jetbrains.buildServer.configs.kotlin.v2019_2.buildSteps.script
import jetbrains.buildServer.configs.kotlin.v2019_2.triggers.vcs

version = "2024.03"

project {
    buildType(TestAndBuild)
    buildType(PushImages)
}

object TestAndBuild : BuildType({
    name = "Test & Build"
    vcs { root(DslContext.settingsRoot) }
    triggers { vcs {} }

    steps {
        script {
            name = "Backend Tests"
            scriptContent = """
                cd backend && bun install && bunx tsc --noEmit && bun run test
            """.trimIndent()
        }
        script {
            name = "Frontend Tests"
            scriptContent = """
                cd frontend && bun install && bunx tsc --noEmit && bun run test && bun run build
            """.trimIndent()
        }
        script {
            name = "Build Images"
            scriptContent = """
                IMAGE_TAG="sha-${'$'}{BUILD_VCS_NUMBER:0:12}"
                FAMILY="${'$'}{BASE_IMAGE_FAMILY:-ubi}"
                docker build -t %REGISTRY%/backend:${'$'}IMAGE_TAG -f backend/Dockerfile.${'$'}FAMILY ./backend
                docker build -t %REGISTRY%/frontend:${'$'}IMAGE_TAG -f frontend/Dockerfile.${'$'}FAMILY ./frontend
                docker build -t %REGISTRY%/planning-agent:${'$'}IMAGE_TAG -f planning-agent/Dockerfile.${'$'}FAMILY .
                docker build -t %REGISTRY%/sub-agent:${'$'}IMAGE_TAG -f sub-agent/Dockerfile.${'$'}FAMILY .
            """.trimIndent()
        }
    }

    params {
        password("REGISTRY", "credentialsJSON:artifactory-docker-registry")
        text("BASE_IMAGE_FAMILY", "ubi", display = ParameterDisplay.PROMPT,
            description = "Base image family: 'ubi' or 'wolfi'")
    }
})

object PushImages : BuildType({
    name = "Push Images"
    vcs { root(DslContext.settingsRoot) }

    dependencies {
        snapshot(TestAndBuild) { onDependencyFailure = FailureAction.FAIL_TO_START }
    }

    steps {
        script {
            name = "Push to Artifactory"
            scriptContent = """
                IMAGE_TAG="sha-${'$'}{BUILD_VCS_NUMBER:0:12}"
                docker push %REGISTRY%/backend:${'$'}IMAGE_TAG
                docker push %REGISTRY%/frontend:${'$'}IMAGE_TAG
                docker push %REGISTRY%/planning-agent:${'$'}IMAGE_TAG
                docker push %REGISTRY%/sub-agent:${'$'}IMAGE_TAG
            """.trimIndent()
        }
    }
})
```

Key difference from Jenkins: TeamCity uses build configurations with snapshot dependencies (not pipeline stages). The `.teamcity/` directory contains Kotlin DSL that TeamCity syncs from the repo via VCS root.

---

## 3. CI/CD Pipeline Design

### Build Matrix

Every CI run builds against the configured base image targets. Each deployment chooses **one** base image family (Debian for local, UBI8 or Wolfi for corporate). GitHub Actions builds all three for validation; corporate CI (Jenkins/TeamCity) builds only the selected corporate base:

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

Single source of truth: `package.json` at repo root. All four images share the same version (**lockstep versioning** — the repo is deployed as a unit, not as independent services). The version field is read by:
- Docker image tags
- Helm chart `appVersion`
- Backend `/api/health` endpoint (for deployment verification)
- `HARNESS_VERSION` env var injected into containers

### Changelog

Conventional commits (`feat:`, `fix:`, `chore:`) parsed by `release-please` to auto-generate `CHANGELOG.md`. `release-please` is preferred over `conventional-changelog` because it also automates version bumps and creates release PRs, reducing manual steps in the release flow.

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

## 6. Agent CI Integration

Agents need visibility into CI build results to make informed decisions: the planning agent must know whether implementation PRs are passing CI, and sub-agents should verify their changes pass before declaring a task complete.

### VCS Connector Extensions

Add three methods to the `VcsConnector` interface:

```typescript
interface VcsConnector {
  // ... existing methods ...

  /**
   * Get the combined CI build status for a commit or PR.
   * Returns the overall status and individual check runs.
   */
  getBuildStatus(repo: Repository, ref: string): Promise<BuildStatus>;

  /**
   * Get the approval status of a pull request.
   * Returns list of reviewers and their approval state.
   */
  getPrApprovals(repo: Repository, prId: string): Promise<PrApproval[]>;

  /**
   * Get logs for a specific CI build/check run.
   * Returns plain text log output.
   */
  getBuildLogs(repo: Repository, buildId: string): Promise<string>;
}

interface BuildStatus {
  state: "success" | "failure" | "pending" | "unknown";
  checks: Array<{
    name: string;           // e.g., "ci / test-backend", "Build Images"
    status: "success" | "failure" | "pending" | "skipped";
    url: string;            // Link to CI run
    buildId: string;        // ID for getBuildLogs()
    startedAt?: string;
    completedAt?: string;
  }>;
}

interface PrApproval {
  user: string;             // Email or username
  state: "approved" | "changes_requested" | "pending";
  submittedAt: string;
}
```

### Provider-Specific Implementations

| Method | GitHub | Bitbucket Server | Jenkins | TeamCity |
|--------|--------|-------------------|---------|----------|
| `getBuildStatus` | `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` | `GET /rest/build-status/1.0/commits/{sha}` | Status reported via Bitbucket Build Status API | Status reported via Bitbucket Build Status API |
| `getPrApprovals` | `GET /repos/{owner}/{repo}/pulls/{id}/reviews` | `GET /rest/api/1.0/projects/{key}/repos/{slug}/pull-requests/{id}/participants` | N/A (VCS-level) | N/A (VCS-level) |
| `getBuildLogs` | `GET /repos/{owner}/{repo}/actions/runs/{id}/logs` (zip) | Build URL from status → scrape or CI API | `GET /job/{name}/{id}/consoleText` | `GET /app/rest/builds/id:{id}/log` |

**Note on `getBuildLogs`**: GitHub Actions returns logs as a zip archive that must be extracted. Jenkins and TeamCity have direct log endpoints. For Bitbucket Server, the build status includes a URL to the CI system — `getBuildLogs` follows that URL and calls the appropriate CI API (Jenkins or TeamCity). The connector needs a `CiProvider` abstraction for log retrieval:

```typescript
interface CiProvider {
  getBuildLogs(buildUrl: string): Promise<string>;
}
```

Implementations: `JenkinsCiProvider` (calls `/consoleText`), `TeamCityCiProvider` (calls `/app/rest/builds/...`), `GitHubActionsCiProvider` (downloads and extracts log zip).

### Agent Tools

**Planning agent** — two new tools:

| Tool | Description | Use Case |
|------|-------------|----------|
| `get_build_status` | Get CI build status for a PR or commit. Returns pass/fail state and individual check names. | Planning agent checks if implementation PRs are green before considering tasks complete. Can also identify which specific check failed. |
| `get_build_logs` | Get CI build logs for a specific check run. Returns plain text output (truncated to last 500 lines if large). | Planning agent reads failure details to provide context when retrying a failed task or reporting to the user. |

These call the backend API, which proxies to the VCS connector:

```
GET /api/pull-requests/:prId/build-status   → connector.getBuildStatus()
GET /api/builds/:buildId/logs               → connector.getBuildLogs() (via CiProvider)
GET /api/pull-requests/:prId/approvals      → connector.getPrApprovals()
```

**Sub-agent** — one new tool:

| Tool | Description | Use Case |
|------|-------------|----------|
| `get_build_status` | Same as planning agent — get CI status for the current PR/branch. | Sub-agent pushes changes, waits for CI, and reads results. If CI fails, the sub-agent can read logs and attempt a fix before declaring the task complete. |

### CI-Aware Task Completion

Currently, `taskDispatcher.ts` considers a task complete when the sub-agent container exits with code 0. With CI integration, the completion flow becomes:

```
Sub-agent exits (code 0)
  → taskDispatcher checks PR build status via connector
  → If CI pending: poll every 30s until terminal (success/failure), up to 15 min
  → If CI success: task marked completed
  → If CI failure: task marked failed with CI error context
     → Planning agent can retry with CI failure details
  → If CI timeout: task marked completed with warning (CI may be slow)
```

This is optional behavior controlled by `WAIT_FOR_CI=true|false` (default: `false` for local mode, `true` for enterprise). When disabled, task completion works as it does today.

### Trace File Integration

Build status is recorded in `trace.json` (see `enterprise-traceability.md`):

```json
{
  "tasks": [{
    "attempts": [{
      "ci": {
        "state": "success",
        "checks": [
          { "name": "test-backend", "status": "success" },
          { "name": "test-frontend", "status": "success" }
        ],
        "checkedAt": "2026-03-28T15:00:00Z"
      }
    }]
  }]
}
```

---

## 7. Local Development Pipeline

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
