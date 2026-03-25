# Agent Workflow Optimization — Design Spec

**Date:** 2026-03-25
**Status:** Draft

---

## Problem Statement

The agent calling workflow has four concrete pain points:

1. **Token waste** — pi-coding-agent sessions accumulate large tool results (verbose bash output, big file reads) in the model's active context, burning tokens and triggering compaction unnecessarily.
2. **No per-project concurrency limit** — the global semaphore (`MAX_CONCURRENT_SUB_AGENTS`) limits total containers, but a single project can monopolize all slots, starving others. There is no guard preventing multiple implementation agents from running concurrently for the same project.
3. **Duplicate task dispatch** — the planning agent's `dispatch_tasks` tool creates a new task entry with a fresh UUID on every call, regardless of whether identical tasks already exist. Re-calling `dispatch_tasks` (e.g., after a network hiccup or model confusion) accumulates duplicates that all get dispatched.
4. **No observability** — the harness has no metrics or distributed tracing. Diagnosing performance, token budgets, or task failure patterns requires manual log-grepping.

---

## Goals

- Reduce token usage in pi sub-agent sessions by filtering large tool results before they enter the model context.
- Enforce two-tier concurrency: global cap + per-project cap (default: 1 impl agent at a time per project).
- Guarantee idempotent task dispatch: repeated `dispatch_tasks` calls for the same task are safe upserts, not accumulating duplicates.
- Emit OpenTelemetry traces and metrics from the backend; export via OTLP HTTP to an OTEL Collector on the host, which forwards to Grafana Cloud.

---

## Non-Goals

- Token filtering inside the planning agent's bash execution. The planning agent is long-running and conversational; aggressive truncation of its tool results would lose important context.
- Modifying the `@mariozechner/pi-coding-agent` library itself.
- Adding any metric collection inside sub-agent containers.

---

## Feature 1: Tool Output Token Filter (Pi Extension)

### Overview

A pi extension hooks the `tool_result` event and truncates oversized results before they are added to the model's active context. It is applied to sub-agents only (not the planning agent; see Non-Goals).

### Extension API

Pi extensions are registered via the `extensionFactories` option in `DefaultResourceLoader`. Each factory is a function `(session: AgentSession) => Extension`. The `Extension` interface includes a `tool_result` handler:

```typescript
toolResult?: (event: ToolResultEvent) => ToolResultEventResult | undefined;
```

- Returning `undefined` passes the original result through unchanged.
- Returning `{ content: ContentPart[] }` replaces the result's content with the new array.
- The handler must never throw — any exception must be caught and `undefined` returned (passthrough).

### Truncation Logic

The handler concatenates all `TextContent` parts from `event.content` into a single string (non-text content is preserved unmodified). If total length exceeds the threshold for the tool, it truncates and appends a notice:

```
[truncated: N chars removed]
```

**Per-tool thresholds:**

| Tool | Threshold | Strategy |
|------|-----------|----------|
| `bash` | 8 000 chars | Keep first 6 000 + last 2 000 (preserves error tail) |
| `read` | 12 000 chars | Keep first 12 000 |
| `find` | 4 000 chars | Keep first 4 000 |
| All others | 4 000 chars | Keep first 4 000 |

Error results (`event.isError === true`) are also truncated — stack traces are large and the threshold is generous enough to preserve the full error message in most cases.

Non-text content parts (images, etc.) are passed through unmodified regardless of size.

### File Location and Build Context Strategy

The extension source lives in a new top-level `shared/` directory:

```
shared/
  extensions/
    output-filter.mjs
    output-filter.test.mjs
```

Both images need access to `shared/`, which is outside their current per-service build contexts. The build context for both must be widened to the **repo root**:

**`docker-compose.yml` — planning-agent service** (currently `build: ./planning-agent`):

```yaml
build:
  context: .
  dockerfile: planning-agent/Dockerfile
```

**Sub-agent** — currently built manually with `docker build -t multi-agent-harness/sub-agent:latest ./sub-agent`. The command becomes:

```bash
docker build -t multi-agent-harness/sub-agent:latest -f sub-agent/Dockerfile .
```

Update the error message in `backend/src/orchestrator/imageBuilder.ts` to reflect the new command.

With repo-root context, both Dockerfiles add:

```dockerfile
COPY shared/extensions/ /app/shared/extensions/
```

`sub-agent/runner.mjs` imports the extension and passes it to `DefaultResourceLoader`:

```javascript
import { createOutputFilterExtension } from '/app/shared/extensions/output-filter.mjs';

const resourceLoader = new DefaultResourceLoader({
  settingsManager,
  extensionFactories: [createOutputFilterExtension],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  // noExtensions removed
});
```

The planning agent runner is **not** changed — it retains `noExtensions: true` and does not use this extension (see Non-Goals).

### Error Handling

- All truncation logic is wrapped in `try/catch`. On any exception, the handler returns `undefined` (original result passes through). The extension never blocks agent execution.
- If the `extensionFactories` option is not recognised by an older version of the SDK, the runner startup will fail — this is acceptable (fail-fast is preferable to silent token blowup). The SDK version must be ≥ the version that introduced `extensionFactories`.

### Test Cases

`shared/extensions/output-filter.test.mjs` (using Node.js built-in test runner or vitest):

1. Bash result with 10 000 chars → output is ≤ 8 001 chars (threshold + notice); first 6 000 and last 2 000 chars are preserved; notice is appended.
2. Bash result with 5 000 chars → output is unchanged.
3. Read result with 20 000 chars → truncated to ≤ 12 001 chars; first 12 000 chars preserved.
4. Unknown tool result with 6 000 chars → truncated at 4 000.
5. Result with `isError: true` and 10 000-char bash output → truncated (error results are not exempt).
6. Result with no text content parts (e.g., image only) → returned unchanged.
7. Exception thrown during truncation (e.g., malformed content) → handler returns `undefined` (passthrough); no exception propagates.

---

## Feature 2: Two-Tier Concurrency

### Overview

Add a per-project concurrency semaphore in `RecoveryService`, layered inside the existing global semaphore. By default, at most 1 implementation agent runs at a time per project (tasks within a project are serialized). Tasks across different projects still run in parallel up to the global limit.

### New Config

```
MAX_IMPL_AGENTS_PER_PROJECT   (default: 1)
```

Added to `backend/src/config.ts` as `maxImplAgentsPerProject`.

### Semaphore Design

`RecoveryService` gains:

```typescript
private projectSlots = new Map<string, { slots: number; waiters: Array<() => void> }>();
```

Entries are created lazily on first access. An entry is removed from the map when `slots === config.maxImplAgentsPerProject` and `waiters.length === 0` — i.e., when the project has no in-flight tasks and no queued waiters. This prevents unbounded map growth.

Two new private methods follow the same pattern as the existing global semaphore:

```typescript
private acquireProjectSlot(projectId: string): Promise<void>
private releaseProjectSlot(projectId: string): void
```

### Acquisition Order in `dispatchWithRetry`

The per-project slot is acquired **outside** the retry loop (at the top of `dispatchWithRetry`, before the `while` loop). This means the project slot is held for the entire task lifecycle including all retry attempts. This is intentional: a retrying task should block new tasks for the same project until the retry sequence concludes.

```
1. activeTaskIds guard (existing, synchronous)
2. acquireProjectSlot(project.id)   ← new, outside retry loop
3. [retry loop begins]
4.   acquireSlot()                  ← existing global, inside retry loop
5.   run container
6.   releaseSlot()
7. [retry loop ends]
8. releaseProjectSlot(project.id)   ← new, in outer finally
```

### Deadlock Prevention

The ordering — **project slot first, then global slot** — prevents deadlock. A task holding a project slot waits for a global slot; it never holds a global slot while waiting for a project slot. The converse order (global first, then project) would allow a scenario where all global slots are taken by tasks waiting for project slots, with none able to make progress.

### Error Handling

`releaseProjectSlot` is called in the outermost `finally` block of `dispatchWithRetry`. No slot can be leaked regardless of whether the task succeeds, fails, times out, or throws.

### Test Cases

`backend/src/__tests__/recoveryService.test.ts` additions:

1. Dispatch 3 tasks for the same project with `MAX_IMPL_AGENTS_PER_PROJECT=1`: assert that at most 1 task is running at any point in time (mock `runTask` to be async with a delay; track concurrent invocations).
2. Dispatch 2 tasks each for 2 different projects with `MAX_IMPL_AGENTS_PER_PROJECT=1` and `MAX_CONCURRENT_SUB_AGENTS=4`: assert both projects' first tasks start before either first task finishes (parallel across projects).
3. Set `MAX_IMPL_AGENTS_PER_PROJECT=2`, dispatch 3 tasks for same project: assert 2 run in parallel, 3rd queues.
4. Global semaphore still limits total: set `MAX_CONCURRENT_SUB_AGENTS=2`, `MAX_IMPL_AGENTS_PER_PROJECT=3`, dispatch 5 tasks across 2 projects; assert at most 2 containers run simultaneously.

---

## Feature 3: Idempotent Task Dispatch

### Root Cause

`POST /api/projects/:id/tasks` in `backend/src/api/projects.ts` inserts a new task record with `randomUUID()` whenever `incoming.id` is absent — regardless of whether an identical task already exists. The planning agent's `dispatch_tasks` tool does not include IDs for new tasks. Repeated calls create duplicate pending tasks that all get dispatched.

### Two-Part Fix

**Part B is the primary fix; Part A is defense-in-depth.**

**Part B — Stable task IDs in planning agent (`planning-agent/runner.mjs`):**

The `dispatch_tasks` tool `execute` handler computes a stable deterministic ID for each task when the planning agent omits `id`:

```javascript
import { createHash } from 'node:crypto';
const stableId = createHash('sha256')
  .update(task.repositoryId + ':' + task.description.trim())
  .digest('hex')
  .slice(0, 32);
```

This `stableId` is injected into the request body as `id` before POSTing to the backend. The backend then treats it as an upsert (existing task reset to `pending`) rather than a new insert — all repeated `dispatch_tasks` calls for the same task are fully idempotent.

**Fallback:** If hash computation throws, fall back to `randomUUID()` — no regression vs. current behavior.

**Stability requirement:** Idempotency relies on the planning agent passing the same `repositoryId` and `description` text on re-dispatch. If the model rephrases the task description, a new task ID is generated and a new task entry is created. This is acceptable behavior (rephrased task = intentionally different task). The `dispatch_tasks` tool description should advise the planning agent to preserve the original text when re-dispatching failed tasks.

**Part A — API-level dedup (`backend/src/api/projects.ts`):**

This guard catches any caller that does not include `id` (e.g., future tools, direct API calls, or a Part B fallback to `randomUUID`). Before pushing a new task (no `id` provided), compute a content key:

```
key = repositoryId + ":" + description.trim()
```

Scan `updatedTasks` for any existing task with the same key whose status is **not** `completed`, `failed`, or `cancelled`. If found, skip the incoming task and log a warning. The `dispatched` count in the response reflects only net-new or reset tasks. The response status remains 200 (transparent idempotency — the planning agent does not need to handle a distinct status code).

This guard does **not** apply to the `id`-present path (explicit upserts are always processed).

### Error Handling

- The dedup check is synchronous with no external dependencies. A scan of `updatedTasks` (typically ≤ 10 items) cannot fail.
- Part B hash failure → `randomUUID()` fallback, Part A catches the duplicate on next call.

### Test Cases

`backend/src/__tests__/projects.test.ts` additions:

1. POST same tasks twice (no `id`): assert `project.plan.tasks.length` does not change on second call; second response has `dispatched: 0`.
2. POST same task but different `repositoryId`: treated as distinct task — both are created.
3. POST task with explicit `id` (re-dispatch of failed task): upserts correctly (resets to pending); task list length unchanged (existing behavior preserved).
4. POST task that already exists as `completed`: a new task entry IS created (completed tasks are terminal; re-dispatching is intentional). Assert a new UUID is assigned.
5. Stable ID computation: given `repositoryId="repo-1"` and `description="  fix bug  "`, assert hash is deterministic across calls; assert `description.trim()` is used (leading/trailing spaces don't affect the ID).

---

## Feature 4: OpenTelemetry Integration

### Architecture

```
backend (Node.js, Docker container)
  └─ @opentelemetry/sdk-node
       └─ OTLP HTTP exporters (traces + metrics)
            └─ OTEL Collector (Docker host, port 4318)
                 └─ Grafana Cloud (Tempo / Mimir)
```

**Protocol: HTTP/protobuf on port 4318** (not gRPC/4317). The backend uses `@opentelemetry/exporter-trace-otlp-http` and `@opentelemetry/exporter-metrics-otlp-http`. Port 4318 is the standard OTLP HTTP port; port 4317 is gRPC only.

The backend container reaches the host collector via `host.docker.internal`. On Linux, Docker does not resolve this hostname by default — the backend service in `docker-compose.yml` must add:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

(This is valid `extra_hosts` YAML — a list of `"hostname:ip"` strings.)

### New File: `backend/src/telemetry.ts`

**Must be the first import in `backend/src/index.ts`**, before Express, before any other module. The reason: the OTEL SDK patches Node.js HTTP and Express internals at import time. If any instrumented library is imported before the SDK initialises, its methods are not patched and auto-instrumentation does not apply.

Exports:
- `tracer` — `opentelemetry.trace.getTracer('harness')`
- `meter` — `opentelemetry.metrics.getMeter('harness')`

When `OTEL_ENABLED=false`, `telemetry.ts` exports no-op tracer and meter with zero overhead (the SDK is not initialised, no exporter is created, no network connections are made).

Graceful shutdown is registered on `SIGTERM` and `SIGINT` to flush pending spans/metrics before process exit.

### New Config

```
OTEL_EXPORTER_OTLP_ENDPOINT   (default: http://host.docker.internal:4318)
OTEL_SERVICE_NAME              (default: multi-agent-harness)
OTEL_ENABLED                   (default: true; set to "false" to disable)
```

Added to `backend/src/config.ts`.

### Instrumentation Points

**Traces**

| Span name | Location | Key attributes |
|-----------|----------|----------------|
| `task.dispatch` | `RecoveryService.dispatchWithRetry` | `project.id`, `task.id`, `task.attempt`, `task.status` (success/failed/timeout) |
| `container.run` | `TaskDispatcher.runTask` | `container.id`, `branch.name`, `session.id` |

`container.run` is a child span of `task.dispatch`. Both spans record the exception message on failure.

**Metrics**

| Metric | Type | Location | Labels |
|--------|------|----------|--------|
| `harness.tasks.dispatched` | Counter | `dispatchWithRetry` (on completion) | `project.id`, `status` (success/failed/timeout) |
| `harness.agents.active` | UpDownCounter | `acquireSlot` (+1) / `releaseSlot` (-1) | — |
| `harness.agents.active_per_project` | UpDownCounter | `acquireProjectSlot` (+1) / `releaseProjectSlot` (-1) | `project.id` |
| `harness.tool_calls.total` | Counter | `PlanningAgentManager.handleRpcLine` on `tool_execution_start` | `tool.name`, `project.id` |
| `harness.tool_calls.duration_ms` | Histogram | `PlanningAgentManager.handleRpcLine` on `tool_execution_end` (paired with start timestamp stored in a `Map<toolCallId, number>`) | `tool.name` |

**Token usage:** The `message_end` event from pi's RPC protocol does not carry token usage data in the current SDK version. The `harness.tokens.context` gauge is **deferred** — it will be added once pi exposes usage in a live event (e.g., `turn_end`). The OTEL scaffolding should make it trivial to add when available.

### Error Handling

- All `tracer.startActiveSpan` calls use `try/finally`; spans always end in the `finally` block regardless of outcome.
- SDK initialisation failure (e.g., missing dependency, misconfigured endpoint) is caught and logged as a warning; the app continues with no-op tracer/meter.
- A failed OTLP export (collector unreachable) is handled by the SDK's internal retry/drop logic and does not affect the application.

### Test Cases

`backend/src/__tests__/telemetry.test.ts`:

1. `OTEL_ENABLED=false`: importing `telemetry.ts` does not initialise the SDK; `tracer` is a no-op tracer; `meter` is a no-op meter.
2. Span attributes: mock the tracer; call `dispatchWithRetry` with a successful task; assert `task.dispatch` span was started with attributes `project.id`, `task.id`, `task.attempt=1`, and ended with `task.status=success`.
3. Span on failure: mock the tracer; make `runTask` throw; assert `task.dispatch` span ends with `task.status=failed` and exception recorded.
4. Counter increment: mock the meter; dispatch and complete a task; assert `harness.tasks.dispatched` was incremented once with labels `{ project.id: "...", status: "success" }`.
5. Tool call counter: mock meter; simulate `tool_execution_start` RPC event for tool `bash`; assert `harness.tool_calls.total` incremented with `{ tool.name: "bash", project.id: "..." }`.
6. Tool call duration: simulate paired `tool_execution_start` + `tool_execution_end` events; assert `harness.tool_calls.duration_ms` histogram was recorded with a non-negative value.

---

## Implementation Order

Features are independent and can be implemented in parallel. Suggested single-developer sequence (lowest to highest rebuild cost):

1. **Feature 3** (dedup) — backend TypeScript + planning-agent JS only, no Docker rebuild required. Highest immediate risk reduction.
2. **Feature 2** (concurrency) — backend TypeScript only, no Docker rebuild.
3. **Feature 4** (OTEL) — backend TypeScript + `docker-compose.yml`. No image rebuild, but `docker compose up --build` required for new env vars.
4. **Feature 1** (extension) — requires creating `shared/` directory, updating both Dockerfiles, and rebuilding both images.

---

## New Dependencies

| Package | Feature | Where |
|---------|---------|-------|
| `@opentelemetry/sdk-node` | 4 | backend |
| `@opentelemetry/exporter-trace-otlp-http` | 4 | backend |
| `@opentelemetry/exporter-metrics-otlp-http` | 4 | backend |
| `@opentelemetry/auto-instrumentations-node` | 4 | backend |

Features 1–3 require no new runtime dependencies.
