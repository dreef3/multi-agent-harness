# Enterprise: Migration Roadmap & Gap Analysis

## Gap Analysis

### Current State vs Enterprise Requirements

| Requirement | Current State | Gap Severity | Effort |
|-------------|--------------|--------------|--------|
| **Authentication (OIDC)** | None | Critical | Medium — standard passport-openidconnect integration |
| **RBAC (4 roles)** | None | Critical | Medium — middleware + DB schema + frontend gating |
| **Audit trail** | None | High | Low — new table + middleware logging |
| **Multi-user WebSocket** | Works (broadcasts to all project connections) | Low | Auth validation on WS upgrade needed (see Phase 1) |
| **PostgreSQL** | SQLite | High | Medium — query migration, connection pooling |
| **Kubernetes runtime** | Docker only (Dockerode) | High | High — new `ContainerRuntime` abstraction + K8s client |
| **Helm chart** | None | High | Medium — templates, values, RBAC, secrets |
| **RHEL 8 / Wolfi images** | Debian-based | Medium | Medium — alt Dockerfiles, package manager changes |
| **Custom CA certs** | Not handled | Medium | Low — env var + mount + `NODE_EXTRA_CA_CERTS` |
| **Proxy support** | Not handled | Medium | Low — env var forwarding to containers |
| **Artifactory integration** | None | Medium | Low — registry config, `.npmrc`, Helm publish |
| **Jenkins/TeamCity pipelines** | GitHub Actions only | Medium | Medium — Jenkinsfile + TeamCity Kotlin DSL |
| **Bitbucket Server VCS** | Connector exists, under-tested | Low | Low — additional E2E coverage |
| **SBOM / compliance artifacts** | None | Low | Low — syft in CI pipeline |
| **Versioning / changelog** | No versioning | Low | Low — conventional-commits + release workflow |
| **Agent traceability** | Raw `.harness/logs/` dumps in repos, no requirement-to-code chain | High | Medium — TraceBuilder, guard hooks, remove legacy commits (see `enterprise-traceability.md`) |
| **Agent CI visibility** | Agents cannot see PR build status or CI logs | High | Medium — VCS connector extensions, agent tools, CI-aware completion (see `enterprise-cicd.md` §6) |
| **Task queue persistence** | In-memory semaphore waiters lost on restart | High | Low — persistent queue table, priority dispatch (see `enterprise-agent-architecture.md`) |
| **Agent bootstrap overhead** | 25-90s per task (full git clone + framework init) | Medium | Low — bare repo cache volume saves 20-55s/task (see `enterprise-agent-architecture.md`) |
| **Frontend tests in CI** | Not run | Low | Trivial — add `bun run test` step |

---

## Migration Phases

### Phase 0: Foundation Hardening, Traceability & Dispatch (4-5 weeks)

**Goal:** Fix issues from the audit that are prerequisites for enterprise work. No new features — just quality and correctness.

| Task | Files | Rationale |
|------|-------|-----------|
| Remove dead code (5 items: `activeTasks` Map, `getActiveTaskCount()`, `DebounceStrategy` type, `defaultDebounceConfig`, `preInitAgent()` — see `audit-2026-03-28.md` §3) | `taskDispatcher.ts`, `strategies.ts`, `websocket.ts` | Clean codebase before adding enterprise features |
| Fix dynamic import in hot path (`await import("../store/agents.js")` inside polling loop) | `taskDispatcher.ts` | Performance/correctness |
| Add frontend tests to CI | `.github/workflows/ci.yml` | Quality gate before further work |
| Add input validation with TypeBox | `api/projects.ts`, `api/repositories.ts` | Prerequisite for multi-user (untrusted input) |
| Add graceful shutdown | `index.ts` | Required for Kubernetes (SIGTERM on pod eviction) |
| Pin pi-coding-agent to current version (`^0.61.1` → exact) | All `package.json` files | Stability for enterprise |
| Webhook raw body signature fix | `webhooks.ts` | Security correctness |
| Add `helmet` security headers | `index.ts`, `nginx.conf` | Security baseline |
| Add `.harness/` guard hook to both agent runners | `planning-agent/runner.mjs`, `sub-agent/runner.mjs` | Tamper protection — agents cannot read/modify audit trail |
| Remove `.harness/logs/` commit logic from agents | `sub-agent/runner.mjs`, `planningTool.ts`, `planningAgentManager.ts` | Replace raw dumps with structured trace (see `enterprise-traceability.md`) |
| Add `TraceBuilder` module + wire into lifecycle events | New: `backend/src/orchestrator/traceBuilder.ts`, wire into `taskDispatcher.ts`, `polling.ts` | Structured requirement-to-code traceability |
| Add requirements extraction to spec handler | `backend/src/agents/planningTool.ts` | Populate requirements array for trace file |
| Replace in-memory semaphore waiters with persistent task queue | `recoveryService.ts`, `store/db.ts` | Queue survives backend restart, enables priority dispatch (see `enterprise-agent-architecture.md`) |
| Add git clone cache via shared bare repo volume | `sub-agent/runner.mjs`, `containerManager.ts`, `docker-compose.yml` | Saves 20-55s per task — `git fetch` instead of full `git clone` (see `enterprise-agent-architecture.md`) |

**Exit criteria:** All existing tests pass. CI runs backend + frontend tests. No dead code. Graceful shutdown works. Agents blocked from `.harness/`. `trace.json` committed on task completion with correct schema. Task queue persistent. Second+ tasks per repo use cached clone.

---

### Phase 1: Authentication & RBAC (3-4 weeks)

**Goal:** Multi-user access with OIDC and role-based permissions. Local mode unchanged.

| Task | Depends On | Details |
|------|-----------|---------|
| Add `users` table, `audit_log` table | Phase 0 | Schema migration in `db.ts` (no sessions table — stateless JWT auth) |
| Add JWT verification middleware (`jose` library) | Users table | Validate access token signature, claims (iss, aud, exp). JWKS fetched from IdP at startup, cached. |
| Add `AUTH_ENABLED` toggle | JWT middleware | Conditionally load auth middleware; skip when false |
| Add `upsertUser()` middleware | JWT middleware | Create/update user record from JWT claims on each request |
| Implement `requireRole()` middleware | JWT middleware | Map JWT role/group claims to harness roles. Applied per-route in `routes.ts` |
| Add `created_by` to projects | Users table | Migration + API attribution |
| Frontend OIDC client | JWT middleware | `oidc-client-ts`, authorization code + PKCE flow, token storage in localStorage, silent refresh, `AuthProvider` context, role-gated UI |
| Audit logging middleware | Auth + DB | Log all mutations with user, action, resource |
| WebSocket auth | JWT middleware | Validate JWT from `?token=` query param on upgrade |
| Replace LGTM comment detection with PR approval detection | Auth + VCS connectors | `polling.ts` and VCS connectors: use PR review/approval API instead of scanning comments for "LGTM". Both GitHub (`GET /pulls/{id}/reviews`) and Bitbucket Server (`GET /pull-requests/{id}/participants`) support approval status. Backwards compatible: local mode can retain LGTM as fallback. |
| Tests for auth + RBAC | All above | Unit tests for JWT verification, role middleware. E2E with Keycloak in Docker |

**Exit criteria:** OIDC login works against a test IdP (Keycloak in Docker). JWT validated on all endpoints. Roles enforced. PR approvals detected instead of LGTM comments. Local mode works without auth. Audit log populated.

---

### Phase 2: Database Migration to PostgreSQL (2-3 weeks)

**Goal:** Replace SQLite with PostgreSQL for concurrent multi-user access and horizontal scaling.

| Task | Details |
|------|---------|
| Add PostgreSQL support alongside SQLite | `better-sqlite3` → `pg` (node-postgres) with connection pooling |
| Database adapter interface | Thin query wrapper abstracting `better-sqlite3` sync API vs `pg` async API. Each store module's functions are updated to call the adapter instead of SQLite directly. |
| Migrate all store modules (including Phase 1 tables) | `store/db.ts`, `store/projects.ts`, `store/agents.ts`, `users`, `audit_log` — parameterized queries |
| Schema migration system | Versioned migrations (1-N) with `schema_migrations` table tracking |
| PostgreSQL in Docker Compose | Add `postgres` service to `docker-compose.yml` (optional, behind profile) |
| PostgreSQL in Helm chart | StatefulSet or external DB reference in `values.yaml` |
| Connection string config | `DATABASE_URL=postgresql://...` or `DATABASE_TYPE=sqlite` (default) |
| Performance testing | Concurrent project creation, task dispatch, polling under load |

**Database selection:**
```
DATABASE_TYPE=sqlite     # Default — local mode, single-writer
DATABASE_TYPE=postgresql # Enterprise — multi-writer, connection pooling
DATABASE_URL=postgresql://user:pass@host:5432/harness
```

**Exit criteria:** All existing tests pass against both SQLite and PostgreSQL. E2E tests run with PostgreSQL. Local mode defaults to SQLite.

---

### Phase 3: Container Runtime Abstraction (3-4 weeks)

**Goal:** Support Kubernetes as a container runtime alongside Docker.

| Task | Details |
|------|---------|
| Define `ContainerRuntime` interface | `createAgent`, `startAgent`, `stopAgent`, `getStatus`, `watchExit`, `streamLogs` |
| Extract `DockerContainerRuntime` | Refactor existing Dockerode calls into the interface |
| Implement `KubernetesContainerRuntime` | `@kubernetes/client-node` — create Jobs, watch Pods, stream logs |
| Pod template configuration | Helm values for agent pod specs (resources, tolerations, affinity) |
| TCP RPC in Kubernetes | Backend connects to planning agent Pod IP on port 3333 |
| Service account RBAC | Helm template for ServiceAccount with Jobs/Pods CRUD in namespace |
| `CONTAINER_RUNTIME` config switch | `docker` (default) or `kubernetes` |
| Integration tests | Mock K8s API for unit tests, real cluster for E2E |

**Exit criteria:** Backend can run agents as either Docker containers or K8s Jobs. Switching is a single env var. Planning agent TCP RPC works in both modes.

---

### Phase 4: Deployment Packaging (2-3 weeks)

**Goal:** Helm chart, alternative Dockerfiles, Artifactory integration.

| Task | Details |
|------|---------|
| Helm chart (`charts/multi-agent-harness/`) | All templates: deployments, services, ingress, PVC, secrets, RBAC, configmap |
| `values-gke.yaml` overlay | GKE-specific: Ingress class, SSD PVC, GCR |
| `values-openshift.yaml` overlay | Routes, SCC, arbitrary UID |
| UBI 8 Dockerfiles | `Dockerfile.ubi` for each image (dnf-based) |
| Wolfi Dockerfiles | `Dockerfile.wolfi` for each image (apk-based) |
| Custom CA cert injection | `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, Helm ConfigMap mount |
| Proxy env var propagation | Backend config → agent container env |
| Artifactory Docker registry config | Image name prefix in Helm values, Docker Compose override |
| Artifactory npm/Helm publish | CI pipeline steps |
| `docker-compose.corp.yaml` override | Corporate image names, PostgreSQL, OIDC config |

**Exit criteria:** `helm install` works on GKE and OpenShift 4. Docker Compose works on RHEL 8 VM. All images build on UBI and Wolfi bases. CA certs and proxy work end-to-end.

---

### Phase 5: CI/CD Pipelines (2 weeks)

**Goal:** Complete build and release automation for both VCS stacks.

| Task | Details |
|------|---------|
| Enhance GitHub Actions `ci.yml` | Add frontend test step, lint step |
| Add `release.yml` workflow | Tag-triggered: build, tag, push to GHCR + Artifactory, GitHub Release |
| Add `helm-publish.yml` workflow | Package and push Helm chart to Artifactory |
| Create `Jenkinsfile` | Parallel test, build matrix (Debian/UBI/Wolfi), push to Artifactory |
| Create TeamCity `.teamcity/settings.kts` | Equivalent build configurations in Kotlin DSL |
| SBOM generation in CI | `syft` scan per image, attach to Artifactory manifest |
| Versioning automation | `release-please` for automated version bumps and release PRs (see `enterprise-cicd.md` §4) |
| Branch protection / PR rules | Require CI pass, require review, no force push to main |
| Add `getBuildStatus`, `getPrApprovals`, `getBuildLogs` to VCS connector | GitHub: check-runs + reviews API. Bitbucket: build-status + participants API. `CiProvider` abstraction for Jenkins/TeamCity log retrieval. |
| Add `get_build_status` + `get_build_logs` agent tools | Planning agent + sub-agent tools calling new backend API endpoints (`/api/pull-requests/:id/build-status`, `/api/builds/:id/logs`) |
| CI-aware task completion | `WAIT_FOR_CI` flag in taskDispatcher — poll PR build status after sub-agent exits, mark task failed if CI fails (see `enterprise-cicd.md` §6) |
| Add CI status to trace.json | TraceBuilder records `ci` block per attempt after build status is resolved |

**Exit criteria:** A git tag `v1.2.3` triggers automated release on both GitHub Actions and Jenkins/TeamCity. Images, Helm chart, and SBOM published to Artifactory. Changelog auto-generated. Agents can query PR build status and read CI logs.

---

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **pi-coding-agent breaking change** | Agent containers fail to start | Medium | Pin exact version, test upgrades in staging before rollout |
| **SQLite → PostgreSQL data loss** | Loss of project history | High | Write migration script with rollback, test on production snapshot |
| **K8s runtime introduces latency** | Slow agent startup (pod scheduling) | Medium | Pre-pull images on nodes, use pod priority classes |
| **OIDC token expiry during long sessions** | User disconnected mid-operation | Medium | Refresh token handling, session renewal endpoint |
| **Corporate proxy blocks AI provider** | Agents fail with connection errors | High | Test all providers through proxy in staging; allowlist domains |
| **UBI base image missing dependencies** | Build failures for agent containers | Medium | JDK, Maven, build-essential equivalents documented; tested in CI |
| **OpenShift arbitrary UID** | File permission errors in containers | Medium | Test with `runAsUser: 1000670000`, ensure writable dirs via `chmod g+w` |
| **Artifactory npm proxy slow** | CI build times increase | Low | Enable Artifactory remote cache, pre-warm popular packages |

---

## Backwards Compatibility Guarantees

Every phase maintains the following invariant:

> **A developer with Docker installed can run `docker compose up` and use the harness locally with no external dependencies, no auth, no corporate infrastructure.**

This is achieved through:

1. **`AUTH_ENABLED=false`** (default) — no OIDC middleware loaded
2. **`DATABASE_TYPE=sqlite`** (default) — no PostgreSQL required
3. **`CONTAINER_RUNTIME=docker`** (default) — no Kubernetes required
4. **Default `Dockerfile`** (Debian) — no UBI/Wolfi required
5. **Default `docker-compose.yml`** — no Artifactory, no registry prefix
6. **Images build from source** — `docker compose build` works offline

Corporate features are purely additive, activated by configuration.

---

## Timeline Summary

| Phase | Duration | Cumulative |
|-------|----------|------------|
| Phase 0: Foundation Hardening, Traceability & Dispatch | 4-5 weeks | 4-5 weeks |
| Phase 1: Authentication & RBAC | 3-4 weeks | 7-9 weeks |
| Phase 2: PostgreSQL Migration | 2-3 weeks | 9-12 weeks |
| Phase 3: Container Runtime Abstraction | 3-4 weeks | 12-16 weeks |
| Phase 4: Deployment Packaging | 2-3 weeks | 14-19 weeks |
| Phase 5: CI/CD Pipelines | 2-3 weeks | 16-22 weeks |

**Total estimated: 16-22 weeks** (~4-5.5 months) with a single developer. Parallelizable: Phases 4 and 5 can overlap with Phase 3. Phase 2 can start alongside Phase 1 (different code areas).

With 2-3 developers working in parallel on independent phases: **~10-13 weeks** (~2.5-3 months).

**Note on Podman**: RHEL 8 VM target uses Podman by default. Podman socket compatibility is covered in `enterprise-deployment.md` §1C. No code changes needed — Dockerode connects to Podman's Docker-compatible API via `DOCKER_HOST` env var.
