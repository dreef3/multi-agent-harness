# Task Index and Supersession Guide

**Date:** 2026-03-28
**Branch:** docs/comprehensive-audit

---

## Introduction

This document is the master index for all 34 implementation plans in the multi-agent-harness project. Plans come from two source sets:

- **Audit findings** — a ground-up code audit identifying quality, security, and reliability gaps in the current codebase. These were the original set of tasks.
- **Enterprise migration specs** — a structured set of phased plans (Phase 0 through Phase 5) that covers everything needed to take the system from a developer tool to an enterprise-grade deployment. These were written after the audit.

Because the enterprise specs were written with the audit findings in mind, there is significant overlap. Several audit tasks are directly superseded by enterprise plans that solve the same problem with a more complete design. Others were out of scope for the enterprise specs and remain standalone. This document maps that relationship and gives the recommended order for working through all 34 plans.

---

## Supersession Analysis

The table below covers every audit finding and its status relative to the enterprise plans.

| Audit Finding | Status | Covered By |
|---|---|---|
| Remove dead code (5 items) | Superseded | `phase0-dead-code-cleanup` |
| Fix dynamic import in hot path | Superseded | `phase0-dead-code-cleanup` |
| Add frontend tests to CI | Superseded | `phase0-frontend-ci` |
| Add basic auth middleware | Superseded (improved — JWT + RBAC replaces basic auth) | `phase1-jwt-middleware` + `phase1-auth-schema` |
| Add input validation with TypeBox | Superseded | `phase0-input-validation` |
| Add security headers | Superseded | `phase0-security-headers` |
| Add graceful shutdown | Superseded | `phase0-graceful-shutdown` |
| Pin pi-coding-agent SDK | Superseded | `phase0-pin-sdk-and-webhook-fix` |
| Fix webhook raw body | Superseded | `phase0-pin-sdk-and-webhook-fix` |
| Use Docker events for container exit | **Standalone** | `audit-docker-events` |
| Add webhook tests | **Standalone** | `audit-webhook-tests` |
| Test untested frontend pages | **Standalone** | `audit-frontend-page-tests` |
| Harden container security | **Standalone** | `audit-container-hardening` |
| Restrict Docker socket proxy | **Standalone** | `audit-docker-socket-proxy` |
| Replace singleton pattern with DI | **Partially superseded** — Phase 3 introduces a proper runtime interface with DI | `phase3-container-interface` |
| Add structured logging | **Not covered** — defer to post-Phase 1 | — |
| Write README | **Not covered** — defer | — |
| Migrate to PostgreSQL | **Enterprise Phase 2** | `phase2-db-adapter` + `phase2-postgresql-adapter` |
| Container orchestration (Kubernetes) | **Enterprise Phase 3** | `phase3-kubernetes-runtime` |

**Summary counts:**

| Status | Count |
|---|---|
| Fully superseded by enterprise plans | 9 |
| Partially superseded | 1 |
| Standalone audit tasks | 5 |
| Not covered (deferred) | 2 |
| New enterprise-only scope | 17 |

---

## All 34 Plans by Phase

### Phase 0 — Foundation Hardening (10 plans)

| # | Filename | Description |
|---|---|---|
| 1 | `2026-03-28-phase0-dead-code-cleanup.md` | Remove 5 dead items, fix dynamic import in hot path |
| 2 | `2026-03-28-phase0-input-validation.md` | TypeBox validation on projects + repositories APIs |
| 3 | `2026-03-28-phase0-security-headers.md` | helmet + nginx security headers |
| 4 | `2026-03-28-phase0-graceful-shutdown.md` | SIGTERM/SIGINT handler in index.ts |
| 5 | `2026-03-28-phase0-pin-sdk-and-webhook-fix.md` | Pin SDK versions + fix webhook raw body HMAC |
| 6 | `2026-03-28-phase0-frontend-ci.md` | Add vitest run step to GitHub Actions frontend job |
| 7 | `2026-03-28-phase0-traceability.md` | Guard hooks + TraceBuilder + lifecycle event wiring |
| 8 | `2026-03-28-phase0-git-clone-cache.md` | Bare repo cache volume, save 20–55s per task |
| 9 | `2026-03-28-phase0-extension-preinstall.md` | Pre-install SDK extensions in Dockerfiles |
| 10 | `2026-03-28-phase0-sqlite-queue.md` | SQLite-backed persistent task queue with priority |

### Audit-Only Plans — Not Covered by Enterprise Specs (5 plans)

These address gaps that fall outside the scope of the phased enterprise migration. They can be worked in parallel with Phase 0.

| # | Filename | Description |
|---|---|---|
| 11 | `2026-03-28-audit-docker-events.md` | Replace 5s polling with Docker die event for container exit |
| 12 | `2026-03-28-audit-webhook-tests.md` | First tests for webhook handler (signature, routing, raw body) |
| 13 | `2026-03-28-audit-frontend-page-tests.md` | Tests for PlanApproval, PrOverview, Settings pages |
| 14 | `2026-03-28-audit-container-hardening.md` | cap_drop ALL + no-new-privileges + opt-in ReadonlyRootfs |
| 15 | `2026-03-28-audit-docker-socket-proxy.md` | Restrict proxy permissions, add EVENTS, remove NETWORKS |

### Phase 1 — Authentication & RBAC (6 plans)

| # | Filename | Description |
|---|---|---|
| 16 | `2026-03-28-phase1-auth-schema.md` | Add users + audit_log tables, created_by column |
| 17 | `2026-03-28-phase1-jwt-middleware.md` | jose JWT verification, AUTH_ENABLED toggle, role middleware |
| 18 | `2026-03-28-phase1-frontend-oidc.md` | oidc-client-ts AuthProvider, PKCE flow, role-gated UI |
| 19 | `2026-03-28-phase1-audit-logging.md` | Audit logging middleware wired into all mutations |
| 20 | `2026-03-28-phase1-websocket-auth.md` | JWT validation on WebSocket upgrade via ?token= param |
| 21 | `2026-03-28-phase1-pr-approval.md` | Replace LGTM comment scanning with PR approval API |

### Phase 2 — PostgreSQL (3 plans)

| # | Filename | Description |
|---|---|---|
| 22 | `2026-03-28-phase2-db-adapter.md` | Database adapter interface + SQLite adapter refactor |
| 23 | `2026-03-28-phase2-postgresql-adapter.md` | PostgreSQL adapter with postgres.js |
| 24 | `2026-03-28-phase2-schema-migrations.md` | Versioned migration system replacing ad-hoc schema |

### Phase 3 — Container Runtime Abstraction (2 plans)

| # | Filename | Description |
|---|---|---|
| 25 | `2026-03-28-phase3-container-interface.md` | ContainerRuntime interface + DockerContainerRuntime |
| 26 | `2026-03-28-phase3-kubernetes-runtime.md` | KubernetesContainerRuntime using K8s Jobs |

### Phase 4 — Deployment Packaging (3 plans)

| # | Filename | Description |
|---|---|---|
| 27 | `2026-03-28-phase4-helm-chart.md` | Full Helm chart with GKE + OpenShift overlays |
| 28 | `2026-03-28-phase4-alt-dockerfiles.md` | UBI 8 + Wolfi Dockerfiles for all 4 images |
| 29 | `2026-03-28-phase4-enterprise-config.md` | CA certs, proxy, Artifactory, docker-compose.corp.yaml |

### Phase 5 — CI/CD Pipelines (5 plans)

| # | Filename | Description |
|---|---|---|
| 30 | `2026-03-28-phase5-github-actions.md` | release.yml + helm-publish.yml + release-please |
| 31 | `2026-03-28-phase5-jenkins-teamcity.md` | Jenkinsfile + TeamCity Kotlin DSL |
| 32 | `2026-03-28-phase5-vcs-ci-extensions.md` | getBuildStatus + getPrApprovals + getBuildLogs |
| 33 | `2026-03-28-phase5-agent-ci-tools.md` | CI tools description in planning agent context |
| 34 | `2026-03-28-phase5-ci-aware-completion.md` | WAIT_FOR_CI flag + CI poll after task completion |

---

## Recommended Implementation Order

The dependency graph below drives this order. Plans with no dependency on each other are called out as parallelizable.

1. **Phase 0 + Audit-only in parallel** — All 10 Phase 0 plans are independent of each other and can be executed concurrently. The 5 audit-only plans touch different parts of the codebase (Docker runtime, tests, container config) and can run in parallel with Phase 0 work. Complete all 15 before moving to Phase 1.

2. **Phase 1 after Phase 0** — Authentication builds directly on the security hardening (headers, input validation) and the webhook fix delivered in Phase 0. The 6 Phase 1 plans can be worked in parallel with each other once Phase 0 is done.

3. **Phase 2 in parallel with Phase 1** — The database adapter refactor and PostgreSQL migration touch different code areas from the auth work. Phase 2 can start immediately after Phase 0 completes, in parallel with Phase 1.

4. **Phase 3 after Phase 2** — The Kubernetes runtime benefits from the async DB interface introduced in Phase 2. Start Phase 3 once Phase 2 is complete. The two Phase 3 plans are sequential (interface first, then K8s implementation).

5. **Phase 4 in parallel with Phase 3** — The Helm chart and Dockerfile work has no code dependency on the container runtime abstraction. Phase 4 can proceed in parallel with Phase 3.

6. **Phase 5 after Phase 4 Dockerfiles** — The CI/CD pipeline plans depend on stable Dockerfiles (Phase 4). The 5 Phase 5 plans can be worked in parallel once Phase 4 Dockerfiles are ready.

### Dependency Summary Table

| Wave | Plans | Prerequisite |
|---|---|---|
| Wave 1 (parallel) | Phase 0 (plans 1–10) + Audit-only (plans 11–15) | None |
| Wave 2 (parallel) | Phase 1 (plans 16–21) + Phase 2 (plans 22–24) | Wave 1 complete |
| Wave 3 (sequential) | Phase 3 (plans 25–26) | Phase 2 complete |
| Wave 4 (parallel) | Phase 4 (plans 27–29) + Phase 5 (plans 30–34) | Phase 3 complete; Phase 4 Dockerfiles before Phase 5 pipelines |
