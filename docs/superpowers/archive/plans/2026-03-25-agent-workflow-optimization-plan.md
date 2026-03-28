# Agent Workflow Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement four improvements to the agent workflow: RTK-based token filtering in both agents, per-project concurrency with session ID retention, idempotent task dispatch via stable IDs, and OpenTelemetry observability.

**Architecture:** Token filtering applies at two layers — the bash `spawnHook` routes commands through the RTK binary, while a pi extension truncates oversized `read`/`find` results. Concurrency adds a per-project semaphore inside the existing global one. Dispatch deduplication uses SHA-256 task IDs. OTEL is initialised as the first import in `index.ts` and instruments task/container lifecycle.

**Tech Stack:** TypeScript/Bun (backend), Node.js ESM (agent runners), Vitest (backend tests), node:test (extension tests), OpenTelemetry Node SDK, RTK static binary (linux/amd64).

**Spec:** `docs/superpowers/specs/2026-03-25-agent-workflow-optimization-design.md`

---

## File Map

**New files:**
- `shared/bin/rtk` — static RTK binary (committed, binary attribute)
- `shared/config/rtk-config.toml` — disables RTK tracking + telemetry in containers
- `shared/extensions/output-filter.mjs` — pi extension: truncates read/find tool results
- `shared/extensions/output-filter.test.mjs` — node:test unit tests
- `.gitattributes` — marks `shared/bin/rtk` as binary
- `backend/src/telemetry.ts` — OTEL SDK init, exports `tracer` + `meter`
- `backend/src/__tests__/telemetry.test.ts` — OTEL no-op and span tests

**Modified files:**
- `backend/src/config.ts` — add `maxImplAgentsPerProject`, OTEL config keys
- `backend/src/orchestrator/recoveryService.ts` — per-project semaphore, session ID retention
- `backend/src/orchestrator/taskDispatcher.ts` — `existingSessionId` param on `runTask`
- `backend/src/api/projects.ts` — content-key dedup for id-absent tasks
- `backend/src/index.ts` — import `telemetry.ts` first
- `backend/src/__tests__/recoveryService.test.ts` — concurrency + session ID tests
- `backend/src/__tests__/projects.test.ts` — dedup tests
- `backend/package.json` — OTEL dependencies
- `planning-agent/runner.mjs` — stable task IDs, `extensionFactories`
- `planning-agent/tools.mjs` — RTK `spawnHook` enhancement
- `planning-agent/Dockerfile` — copy `shared/`, widen build context
- `sub-agent/runner.mjs` — `extensionFactories`
- `sub-agent/tools.mjs` — RTK `spawnHook` enhancement
- `sub-agent/Dockerfile` — copy `shared/`, widen build context
- `backend/src/orchestrator/imageBuilder.ts` — update build command message
- `docker-compose.yml` — widen planning-agent build context, OTEL env + `extra_hosts`

---

## Task 1: Feature 3A — API-level task dedup

**Files:**
- Modify: `backend/src/api/projects.ts` (route `POST /:id/tasks`, lines 172–219)
- Modify: `backend/src/__tests__/projects.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `backend/src/__tests__/projects.test.ts`:

```typescript
describe("POST /:id/tasks dedup", () => {
  it("does not create duplicate tasks when same tasks posted twice", async () => {
    // set up project with plan
    const project = createTestProject();
    project.plan = { id: "plan-1", projectId: project.id, content: "", tasks: [] };
    insertProject(project);

    const tasks = [{ repositoryId: "repo-1", description: "fix the bug" }];

    const res1 = await request(app).post(`/api/projects/${project.id}/tasks`).send({ tasks });
    expect(res1.status).toBe(200);
    expect(res1.body.dispatched).toBe(1);

    const res2 = await request(app).post(`/api/projects/${project.id}/tasks`).send({ tasks });
    expect(res2.status).toBe(200);
    expect(res2.body.dispatched).toBe(0);

    const updated = getProject(project.id)!;
    expect(updated.plan!.tasks).toHaveLength(1);
  });

  it("treats same description with different repositoryId as distinct tasks", async () => {
    const project = createTestProject();
    project.plan = { id: "plan-1", projectId: project.id, content: "", tasks: [] };
    insertProject(project);

    await request(app).post(`/api/projects/${project.id}/tasks`).send({
      tasks: [{ repositoryId: "repo-1", description: "fix bug" }],
    });
    const res = await request(app).post(`/api/projects/${project.id}/tasks`).send({
      tasks: [{ repositoryId: "repo-2", description: "fix bug" }],
    });

    expect(res.body.dispatched).toBe(1);
    expect(getProject(project.id)!.plan!.tasks).toHaveLength(2);
  });

  it("allows re-posting a completed task (terminal tasks not blocked)", async () => {
    const project = createTestProject();
    insertProject(project);
    // seed a completed task
    updateProject(project.id, {
      plan: {
        id: "plan-1", projectId: project.id, content: "",
        tasks: [{ id: "t1", repositoryId: "repo-1", description: "done task", status: "completed" }],
      },
    });

    const res = await request(app).post(`/api/projects/${project.id}/tasks`).send({
      tasks: [{ repositoryId: "repo-1", description: "done task" }],
    });
    expect(res.body.dispatched).toBe(1);
    expect(getProject(project.id)!.plan!.tasks).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd backend && npx vitest run src/__tests__/projects.test.ts --reporter=verbose 2>&1 | grep -E "FAIL|PASS|✓|✗|dedup"
```

Expected: 3 failures.

- [ ] **Step 3: Implement dedup in `projects.ts`**

In `POST /:id/tasks` handler, replace the `else` branch (new task insertion, ~line 196) with:

```typescript
} else {
  // Content-key dedup: skip if a non-terminal task with the same repositoryId+description exists
  const terminal = new Set(["completed", "failed", "cancelled"]);
  const contentKey = `${incoming.repositoryId}:${incoming.description.trim()}`;
  const isDuplicate = updatedTasks.some(
    t => !terminal.has(t.status) && `${t.repositoryId}:${t.description.trim()}` === contentKey
  );
  if (isDuplicate) {
    console.warn(`[projects] Skipping duplicate task (non-terminal match): ${incoming.description.slice(0, 60)}`);
    continue;
  }
  // New task
  updatedTasks.push({
    id: incoming.id ?? randomUUID(),
    repositoryId: incoming.repositoryId,
    description: incoming.description,
    status: "pending",
  });
}
```

Also update `dispatched` count to only count net-new or reset tasks (not skipped):

Replace:
```typescript
res.json({ dispatched: tasks.length });
```
With:
```typescript
const netNew = updatedTasks.length - existingTasks.length;
const reset = tasks.filter(t => t.id && existingTasks.some(e => e.id === t.id)).length;
res.json({ dispatched: netNew + reset });
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd backend && npx vitest run src/__tests__/projects.test.ts --reporter=verbose 2>&1 | grep -E "FAIL|PASS|✓|✗|dedup"
```

Expected: all 3 new tests pass, no regressions.

- [ ] **Step 5: Run full backend test suite**

```bash
cd backend && npx vitest run 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/api/projects.ts backend/src/__tests__/projects.test.ts
git commit -m "fix(dispatch): add content-key dedup to prevent duplicate task creation"
```

---

## Task 2: Feature 3B — Stable task IDs in planning agent

**Files:**
- Modify: `planning-agent/runner.mjs` (the `dispatch_tasks` tool `execute` function)

- [ ] **Step 1: Add `stableTaskId` helper and update `dispatch_tasks` execute**

At the top of `planning-agent/runner.mjs`, after existing imports, add:

```javascript
import { createHash } from 'node:crypto';

function stableTaskId(repositoryId, description) {
  try {
    return createHash('sha256')
      .update(repositoryId + ':' + description.trim())
      .digest('hex')
      .slice(0, 32);
  } catch {
    return null; // null means server will assign randomUUID (fallback)
  }
}
```

In the `dispatch_tasks` tool's `execute` function, change the `body` to inject stable IDs:

```javascript
execute: async (_toolCallId, params) => {
  const tasksWithIds = params.tasks.map(t => ({
    ...t,
    id: t.id ?? stableTaskId(t.repositoryId, t.description) ?? undefined,
  }));
  const res = await fetch(`${BACKEND_URL}/api/projects/${PROJECT_ID}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tasks: tasksWithIds }),
  });
  // ... rest unchanged
```

Also update the tool description to add: `"When re-dispatching a failed task, pass the original id to ensure idempotent dispatch."`

- [ ] **Step 2: Verify syntax**

```bash
node --check planning-agent/runner.mjs && echo "OK"
```

Expected: `OK` (no syntax errors).

- [ ] **Step 3: Commit**

```bash
git add planning-agent/runner.mjs
git commit -m "fix(dispatch): inject stable SHA-256 task IDs from planning agent to prevent re-dispatch duplicates"
```

---

## Task 3: Feature 2A — Per-project concurrency semaphore

**Files:**
- Modify: `backend/src/config.ts`
- Modify: `backend/src/orchestrator/recoveryService.ts`
- Modify: `backend/src/__tests__/recoveryService.test.ts`

- [ ] **Step 1: Add config key**

In `backend/src/config.ts`, add to the exported `config` object:

```typescript
// Maximum number of impl agents allowed to run simultaneously for a single project
maxImplAgentsPerProject: parseInt(process.env.MAX_IMPL_AGENTS_PER_PROJECT ?? "1", 10),
```

- [ ] **Step 2: Write failing tests**

Add to `backend/src/__tests__/recoveryService.test.ts`:

```typescript
describe("per-project concurrency", () => {
  it("serialises tasks within a project when MAX_IMPL_AGENTS_PER_PROJECT=1", async () => {
    // Override config
    (config as any).maxImplAgentsPerProject = 1;
    (config as any).maxConcurrentSubAgents = 10;

    const running: string[] = [];
    let maxConcurrent = 0;

    const mockRunTask = vi.fn(async (_docker: unknown, _project: unknown, task: { id: string }) => {
      running.push(task.id);
      maxConcurrent = Math.max(maxConcurrent, running.length);
      await new Promise(r => setTimeout(r, 50));
      running.splice(running.indexOf(task.id), 1);
      return { taskId: task.id, success: true };
    });

    // Wire mock dispatcher
    const svc = getRecoveryService();
    (svc as any).dispatcher.runTask = mockRunTask;

    const project = makeProject("p1");
    project.plan = {
      id: "plan-1", projectId: "p1", content: "",
      tasks: [
        { id: "t1", repositoryId: "r1", description: "task 1", status: "pending" },
        { id: "t2", repositoryId: "r1", description: "task 2", status: "pending" },
        { id: "t3", repositoryId: "r1", description: "task 3", status: "pending" },
      ],
    };
    insertProject(project);

    await svc.dispatchTasksForProject("p1");
    expect(maxConcurrent).toBe(1);
  });

  it("runs tasks from different projects in parallel", async () => {
    (config as any).maxImplAgentsPerProject = 1;
    (config as any).maxConcurrentSubAgents = 10;

    const startTimes: Record<string, number> = {};
    const endTimes: Record<string, number> = {};

    const mockRunTask = vi.fn(async (_docker: unknown, _project: { id: string }, task: { id: string }) => {
      startTimes[task.id] = Date.now();
      await new Promise(r => setTimeout(r, 60));
      endTimes[task.id] = Date.now();
      return { taskId: task.id, success: true };
    });

    const svc = getRecoveryService();
    (svc as any).dispatcher.runTask = mockRunTask;

    for (const pid of ["proj-a", "proj-b"]) {
      const p = makeProject(pid);
      p.plan = {
        id: `plan-${pid}`, projectId: pid, content: "",
        tasks: [{ id: `${pid}-t1`, repositoryId: "r1", description: "task", status: "pending" }],
      };
      insertProject(p);
    }

    await Promise.all([
      svc.dispatchTasksForProject("proj-a"),
      svc.dispatchTasksForProject("proj-b"),
    ]);

    // Both started before either ended
    expect(startTimes["proj-a-t1"]).toBeLessThan(endTimes["proj-b-t1"]);
    expect(startTimes["proj-b-t1"]).toBeLessThan(endTimes["proj-a-t1"]);
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
cd backend && npx vitest run src/__tests__/recoveryService.test.ts --reporter=verbose 2>&1 | grep -E "per-project|FAIL|PASS"
```

Expected: 2 new failures.

- [ ] **Step 4: Add per-project semaphore to `RecoveryService`**

After the existing `waiters` field declaration, add:

```typescript
private projectSlots = new Map<string, { slots: number; waiters: Array<() => void> }>();
```

Add two new private methods after `releaseSlot`:

```typescript
private acquireProjectSlot(projectId: string): Promise<void> {
  let entry = this.projectSlots.get(projectId);
  if (!entry) {
    entry = { slots: config.maxImplAgentsPerProject, waiters: [] };
    this.projectSlots.set(projectId, entry);
  }
  if (entry.slots > 0) {
    entry.slots--;
    return Promise.resolve();
  }
  return new Promise(resolve => entry!.waiters.push(resolve));
}

private releaseProjectSlot(projectId: string): void {
  const entry = this.projectSlots.get(projectId);
  if (!entry) return;
  const next = entry.waiters.shift();
  if (next) {
    next();
  } else {
    entry.slots++;
    if (entry.slots === config.maxImplAgentsPerProject && entry.waiters.length === 0) {
      this.projectSlots.delete(projectId);
    }
  }
}
```

- [ ] **Step 5: Wire per-project slot into `dispatchWithRetry`**

In `dispatchWithRetry`, after the `activeTaskIds` guard and `this.activeTaskIds.add(task.id)`, add:

```typescript
await this.acquireProjectSlot(project.id);
```

In the outer `finally` block (after `this.activeTaskIds.delete(task.id)`), add:

```typescript
this.releaseProjectSlot(project.id);
```

The per-project slot is acquired **outside** the retry loop and released in the outermost finally.

- [ ] **Step 6: Run tests**

```bash
cd backend && npx vitest run src/__tests__/recoveryService.test.ts --reporter=verbose 2>&1 | grep -E "per-project|FAIL|PASS|✓|✗"
```

Expected: 2 new tests pass.

- [ ] **Step 7: Run full backend test suite**

```bash
cd backend && npx vitest run 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add backend/src/config.ts backend/src/orchestrator/recoveryService.ts backend/src/__tests__/recoveryService.test.ts
git commit -m "feat(concurrency): add per-project semaphore (MAX_IMPL_AGENTS_PER_PROJECT, default 1)"
```

---

## Task 4: Feature 2B — Session ID retention on retry

**Files:**
- Modify: `backend/src/orchestrator/recoveryService.ts` (dispatchWithRetry)
- Modify: `backend/src/orchestrator/taskDispatcher.ts` (runTask signature)
- Modify: `backend/src/__tests__/recoveryService.test.ts`

- [ ] **Step 1: Write failing test**

Add to `backend/src/__tests__/recoveryService.test.ts`:

```typescript
describe("session ID retention on retry", () => {
  it("creates exactly one session record across multiple retry attempts", async () => {
    (config as any).subAgentMaxRetries = 2;
    (config as any).maxConcurrentSubAgents = 10;
    (config as any).maxImplAgentsPerProject = 10;

    let attempt = 0;
    const mockRunTask = vi.fn(async (_docker: unknown, _project: unknown, task: { id: string }, existingSessionId?: string) => {
      attempt++;
      if (attempt < 3) return { taskId: task.id, success: false, error: "container failed" };
      return { taskId: task.id, success: true };
    });

    const svc = getRecoveryService();
    (svc as any).dispatcher.runTask = mockRunTask;

    const project = makeProject("p-retry");
    project.plan = {
      id: "plan-retry", projectId: "p-retry", content: "",
      tasks: [{ id: "t-retry", repositoryId: "r1", description: "retry task", status: "pending" }],
    };
    insertProject(project);

    await svc.dispatchTasksForProject("p-retry");

    // runTask called 3 times (2 failures + 1 success)
    expect(mockRunTask).toHaveBeenCalledTimes(3);
    // First call: no existingSessionId
    expect(mockRunTask.mock.calls[0][3]).toBeUndefined();
    // Subsequent calls: same non-undefined sessionId
    const sessionId = mockRunTask.mock.calls[1][3];
    expect(sessionId).toBeDefined();
    expect(mockRunTask.mock.calls[2][3]).toBe(sessionId);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd backend && npx vitest run src/__tests__/recoveryService.test.ts --reporter=verbose 2>&1 | grep -E "session ID|FAIL|PASS"
```

Expected: 1 failure.

- [ ] **Step 3: Update `dispatchWithRetry` to generate sessionId once**

In `backend/src/orchestrator/recoveryService.ts`, in `dispatchWithRetry`, before the `while` loop:

```typescript
const sessionId = randomUUID();  // add this import: import { randomUUID } from "crypto";
let isFirstAttempt = true;
```

Change the `runTask` call inside the loop from:
```typescript
result = await this.dispatcher.runTask(this.docker, freshProject, taskForRun);
```
To:
```typescript
result = await this.dispatcher.runTask(
  this.docker, freshProject, taskForRun,
  isFirstAttempt ? undefined : sessionId,
);
isFirstAttempt = false;
```

Add `import { randomUUID } from "crypto";` at the top of the file if not already present.

- [ ] **Step 4: Update `TaskDispatcher.runTask` signature**

In `backend/src/orchestrator/taskDispatcher.ts`, change the `runTask` signature:

```typescript
public async runTask(
  docker: Dockerode,
  project: Project,
  task: PlanTask,
  existingSessionId?: string,
): Promise<TaskResult>
```

Inside `runTask`, replace:
```typescript
const sessionId = randomUUID();
// ...
insertAgentSession(agentSession);
```
With:
```typescript
const sessionId = existingSessionId ?? randomUUID();
const isRetry = !!existingSessionId;
// ...
if (isRetry) {
  updateAgentSession(sessionId, {
    status: "starting",
    containerId: undefined as unknown as string,
    updatedAt: new Date().toISOString(),
  });
} else {
  insertAgentSession(agentSession);
}
```

Note: `updateAgentSession` is already imported. Check the store function accepts `containerId: undefined` — if the type requires a string, pass `undefined as unknown as string` or update the `AgentSession` type to allow `containerId?: string`.

- [ ] **Step 5: Run tests**

```bash
cd backend && npx vitest run src/__tests__/recoveryService.test.ts --reporter=verbose 2>&1 | grep -E "session ID|FAIL|PASS|✓|✗"
```

Expected: new test passes.

- [ ] **Step 6: Run full suite**

```bash
cd backend && npx vitest run 2>&1 | tail -10
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/orchestrator/recoveryService.ts backend/src/orchestrator/taskDispatcher.ts backend/src/__tests__/recoveryService.test.ts
git commit -m "fix(retry): reuse session ID on retry so each task shows one session record in UI"
```

---

## Task 5: Feature 4A — OTEL telemetry module

**Files:**
- Modify: `backend/package.json`
- Create: `backend/src/telemetry.ts`
- Create: `backend/src/__tests__/telemetry.test.ts`
- Modify: `backend/src/index.ts` (first import)

- [ ] **Step 1: Install OTEL packages**

```bash
cd backend && bun add @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http @opentelemetry/auto-instrumentations-node @opentelemetry/api
```

- [ ] **Step 2: Write failing telemetry tests**

Create `backend/src/__tests__/telemetry.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("telemetry module", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exports no-op tracer and meter when OTEL_ENABLED=false", async () => {
    process.env.OTEL_ENABLED = "false";
    const { tracer, meter } = await import("../telemetry.js");
    // No-op tracer: startSpan returns a valid (no-op) span
    const span = tracer.startSpan("test");
    expect(span).toBeDefined();
    span.end();
    // No-op meter: createCounter does not throw
    const counter = meter.createCounter("test.counter");
    expect(counter).toBeDefined();
    delete process.env.OTEL_ENABLED;
  });

  it("exports tracer and meter regardless of OTEL_ENABLED value", async () => {
    process.env.OTEL_ENABLED = "false";
    const mod = await import("../telemetry.js");
    expect(mod.tracer).toBeDefined();
    expect(mod.meter).toBeDefined();
    delete process.env.OTEL_ENABLED;
  });
});
```

- [ ] **Step 3: Run to confirm failure**

```bash
cd backend && npx vitest run src/__tests__/telemetry.test.ts 2>&1 | tail -10
```

Expected: module not found error.

- [ ] **Step 4: Create `backend/src/telemetry.ts`**

```typescript
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { trace, metrics } from "@opentelemetry/api";

const enabled = process.env.OTEL_ENABLED !== "false";
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://host.docker.internal:4318";
const serviceName = process.env.OTEL_SERVICE_NAME ?? "multi-agent-harness";

if (enabled) {
  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 10_000,
    }),
    instrumentations: [getNodeAutoInstrumentations({ "@opentelemetry/instrumentation-fs": { enabled: false } })],
  });

  try {
    sdk.start();
    console.log(`[telemetry] OTEL SDK started (endpoint=${endpoint} service=${serviceName})`);
  } catch (err) {
    console.warn("[telemetry] OTEL SDK failed to start (non-fatal):", err);
  }

  const shutdown = () => sdk.shutdown().catch(e => console.warn("[telemetry] shutdown error:", e));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export const tracer = trace.getTracer("harness");
export const meter = metrics.getMeter("harness");
```

- [ ] **Step 5: Add `telemetry.ts` as first import in `backend/src/index.ts`**

The OTEL SDK must be imported before Express and all other modules to patch HTTP internals. Open `backend/src/index.ts` and prepend:

```typescript
import "./telemetry.js"; // MUST be first — patches Node.js HTTP before any other import
```

This must be the absolute first line (before `import express`, `import { initDb }`, etc.).

- [ ] **Step 6: Run telemetry tests**

```bash
cd backend && npx vitest run src/__tests__/telemetry.test.ts --reporter=verbose 2>&1 | tail -15
```

Expected: both tests pass.

- [ ] **Step 7: Run full suite**

```bash
cd backend && npx vitest run 2>&1 | tail -10
```

- [ ] **Step 8: Commit**

```bash
git add backend/src/telemetry.ts backend/src/__tests__/telemetry.test.ts backend/src/index.ts backend/package.json bun.lockb 2>/dev/null; git add -u
git commit -m "feat(otel): add OpenTelemetry SDK module with OTLP HTTP export"
```

---

## Task 6: Feature 4B — Instrument task dispatch spans and metrics

**Files:**
- Modify: `backend/src/orchestrator/recoveryService.ts`
- Modify: `backend/src/orchestrator/taskDispatcher.ts`
- Modify: `backend/src/config.ts` (OTEL config keys)

- [ ] **Step 1: Add OTEL config keys to `config.ts`**

```typescript
otelEnabled: process.env.OTEL_ENABLED !== "false",
otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://host.docker.internal:4318",
otelServiceName: process.env.OTEL_SERVICE_NAME ?? "multi-agent-harness",
```

- [ ] **Step 2: Instrument `RecoveryService.dispatchWithRetry` with span + counters**

At top of `recoveryService.ts`:
```typescript
import { tracer, meter } from "../telemetry.js";
import { SpanStatusCode } from "@opentelemetry/api";

const taskCounter = meter.createCounter("harness.tasks.dispatched", {
  description: "Number of tasks dispatched",
});
const activeAgents = meter.createUpDownCounter("harness.agents.active", {
  description: "Currently running sub-agent containers",
});
const activeAgentsPerProject = meter.createUpDownCounter("harness.agents.active_per_project", {
  description: "Running sub-agent containers per project",
});
```

Wrap the body of `dispatchWithRetry` in a span. Replace the try/finally with:

```typescript
await tracer.startActiveSpan("task.dispatch", async (span) => {
  span.setAttributes({
    "project.id": project.id,
    "task.id": task.id,
    "task.attempt": localRetryCount + 1,
  });
  try {
    // existing body here
    // on success: span.setAttributes({ "task.status": "success" });
    // on failure: span.setAttributes({ "task.status": "failed" });
    //             span.setStatus({ code: SpanStatusCode.ERROR, message: lastError });
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    span.setAttributes({ "task.status": "error" });
    throw err;
  } finally {
    span.end();
  }
});
```

Also increment `taskCounter` on completion, `activeAgents` on acquire/release, `activeAgentsPerProject` on project slot acquire/release.

Specifically in `acquireSlot`: `activeAgents.add(1);`
In `releaseSlot`: `activeAgents.add(-1);`
In `acquireProjectSlot`: `activeAgentsPerProject.add(1, { "project.id": projectId });`
In `releaseProjectSlot`: `activeAgentsPerProject.add(-1, { "project.id": projectId });`

On task success: `taskCounter.add(1, { "project.id": project.id, status: "success" });`
On permanent failure: `taskCounter.add(1, { "project.id": project.id, status: "failed" });`

- [ ] **Step 3: Instrument `TaskDispatcher.runTask` with child span**

At top of `taskDispatcher.ts`:
```typescript
import { tracer } from "../telemetry.js";
import { SpanStatusCode, context } from "@opentelemetry/api";
```

Wrap the core of `runTask` in a child span:

```typescript
return tracer.startActiveSpan("container.run", async (span) => {
  try {
    // existing implementation
    // after container starts: span.setAttributes({ "container.id": containerId, "branch.name": branchName, "session.id": sessionId });
    // on success: span.setStatus({ code: SpanStatusCode.OK });
    // on error: span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage }); span.recordException(error);
    return result;
  } finally {
    span.end();
  }
});
```

- [ ] **Step 4: Run full backend test suite**

```bash
cd backend && npx vitest run 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/orchestrator/recoveryService.ts backend/src/orchestrator/taskDispatcher.ts backend/src/config.ts
git commit -m "feat(otel): instrument task dispatch and container run spans + active agent metrics"
```

---

## Task 7: Feature 4C — Instrument planning agent tool call metrics

**Files:**
- Modify: `backend/src/orchestrator/planningAgentManager.ts`

- [ ] **Step 1: Add tool call counter and duration histogram**

At top of `planningAgentManager.ts`:
```typescript
import { meter } from "../telemetry.js";

const toolCallCounter = meter.createCounter("harness.tool_calls.total", {
  description: "Total tool calls made by the planning agent",
});
const toolCallDuration = meter.createHistogram("harness.tool_calls.duration_ms", {
  description: "Duration of planning agent tool calls in milliseconds",
  unit: "ms",
});
```

- [ ] **Step 2: Track tool call start times**

Add a private field to `PlanningAgentManager`:
```typescript
private toolCallStartTimes = new Map<string, number>(); // toolCallId → start timestamp
```

(The pi RPC `tool_execution_start` event includes a `toolCallId` — check the actual event shape in `handleRpcLine`. If no `toolCallId`, use `toolName` as a fallback key.)

- [ ] **Step 3: Record metrics in `handleRpcLine`**

In the `tool_execution_start` handler:
```typescript
if (type === "tool_execution_start") {
  const toolName = obj.toolName as string;
  const toolCallId = (obj.toolCallId as string | undefined) ?? toolName;
  this.toolCallStartTimes.set(toolCallId, Date.now());
  toolCallCounter.add(1, { "tool.name": toolName, "project.id": projectId });
  // existing emit...
}
```

In the `tool_execution_end` handler:
```typescript
if (type === "tool_execution_end") {
  const toolCallId = (obj.toolCallId as string | undefined) ?? (obj.toolName as string);
  const start = this.toolCallStartTimes.get(toolCallId);
  if (start !== undefined) {
    toolCallDuration.record(Date.now() - start, { "tool.name": obj.toolName as string });
    this.toolCallStartTimes.delete(toolCallId);
  }
  // existing emit...
}
```

- [ ] **Step 4: Run full test suite**

```bash
cd backend && npx vitest run 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/orchestrator/planningAgentManager.ts
git commit -m "feat(otel): add tool call counter and duration histogram for planning agent"
```

---

## Task 8: Feature 4D — docker-compose OTEL and extra_hosts

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Update `docker-compose.yml`**

Add `extra_hosts` and OTEL environment variables to the `backend` service:

```yaml
  backend:
    build: ./backend
    image: multi-agent-harness/backend:latest
    ports:
      - "3000:3000"
    volumes:
      - harness-data:/app/data
      - harness-pi-auth:/pi-agent
    env_file:
      - .env
    environment:
      DOCKER_PROXY_URL: http://docker-proxy:2375
      OTEL_EXPORTER_OTLP_ENDPOINT: http://host.docker.internal:4318
      OTEL_SERVICE_NAME: multi-agent-harness
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      - docker-proxy
    networks:
      - default
      - harness-agents
```

- [ ] **Step 2: Validate compose file**

```bash
docker compose config --quiet && echo "OK"
```

Expected: `OK` (no YAML errors).

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(otel): add OTEL env vars and host.docker.internal extra_hosts to backend service"
```

---

## Task 9: Feature 1A — shared/ directory setup

**Files:**
- Create: `shared/bin/rtk` (binary copy)
- Create: `shared/config/rtk-config.toml`
- Modify: `.gitattributes`

- [ ] **Step 1: Create shared directory structure**

```bash
mkdir -p shared/bin shared/config shared/extensions
```

- [ ] **Step 2: Copy RTK binary**

```bash
cp /home/ae/.local/bin/rtk shared/bin/rtk
```

- [ ] **Step 3: Add .gitattributes**

Create or append `.gitattributes` at repo root:

```
shared/bin/rtk binary
```

- [ ] **Step 4: Create RTK config (telemetry disabled)**

Create `shared/config/rtk-config.toml`:

```toml
[tracking]
enabled = false

[telemetry]
enabled = false
```

- [ ] **Step 5: Verify binary**

```bash
file shared/bin/rtk && ls -lh shared/bin/rtk
```

Expected: `ELF 64-bit LSB` and ~9 MB size.

- [ ] **Step 6: Commit**

```bash
git add shared/bin/rtk shared/config/rtk-config.toml .gitattributes
git commit -m "chore: add shared/ directory with RTK binary (linux/amd64) and telemetry-disabled config"
```

---

## Task 10: Feature 1B — output-filter.mjs pi extension

**Files:**
- Create: `shared/extensions/output-filter.mjs`
- Create: `shared/extensions/output-filter.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `shared/extensions/output-filter.test.mjs`:

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOutputFilterExtension } from "./output-filter.mjs";

function makeEvent(toolName, text, isError = false) {
  return {
    toolName,
    isError,
    content: [{ type: "text", text }],
  };
}

const ext = createOutputFilterExtension(null);

describe("output-filter extension", () => {
  it("truncates read result over 12000 chars", () => {
    const bigText = "x".repeat(15000);
    const event = makeEvent("read", bigText);
    const result = ext.toolResult(event);
    assert.ok(result !== undefined, "should return a result");
    const out = result.content[0].text;
    assert.ok(out.length <= 12001 + 100, "should be under threshold + notice");
    assert.ok(out.includes("[truncated:"), "should include truncation notice");
    assert.equal(out.slice(0, 12000), bigText.slice(0, 12000), "first 12000 chars preserved");
  });

  it("passes through read result under 12000 chars unchanged", () => {
    const text = "x".repeat(5000);
    const result = ext.toolResult(makeEvent("read", text));
    assert.equal(result, undefined, "should return undefined (passthrough)");
  });

  it("truncates find result over 4000 chars", () => {
    const big = "x".repeat(6000);
    const result = ext.toolResult(makeEvent("find", big));
    assert.ok(result !== undefined);
    assert.ok(result.content[0].text.length <= 4001 + 100);
  });

  it("does NOT truncate bash result (RTK handles bash)", () => {
    const big = "x".repeat(20000);
    const result = ext.toolResult(makeEvent("bash", big));
    assert.equal(result, undefined, "bash should pass through unchanged");
  });

  it("truncates isError read result", () => {
    const big = "x".repeat(15000);
    const result = ext.toolResult(makeEvent("read", big, true));
    assert.ok(result !== undefined);
    assert.ok(result.content[0].text.includes("[truncated:"));
  });

  it("passes through non-text content unchanged", () => {
    const event = { toolName: "read", isError: false, content: [{ type: "image", data: "abc" }] };
    const result = ext.toolResult(event);
    assert.equal(result, undefined, "non-text content should pass through");
  });

  it("returns undefined (passthrough) on exception", () => {
    const badEvent = { toolName: "read", isError: false, content: null };
    const result = ext.toolResult(badEvent);
    assert.equal(result, undefined, "should not throw on malformed event");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test shared/extensions/output-filter.test.mjs 2>&1 | tail -15
```

Expected: module not found or all tests failing.

- [ ] **Step 3: Create `shared/extensions/output-filter.mjs`**

```javascript
/**
 * Pi coding-agent extension: truncates oversized read/find tool results
 * to reduce token usage. Bash results are handled by RTK via spawnHook.
 */

const THRESHOLDS = {
  read: 12_000,
  find: 4_000,
};
const DEFAULT_THRESHOLD = 4_000;

function truncateText(text, threshold) {
  if (text.length <= threshold) return null; // no truncation needed
  const removed = text.length - threshold;
  return text.slice(0, threshold) + `\n[truncated: ${removed} chars removed]`;
}

function filterToolResult(event) {
  try {
    const { toolName, content } = event;
    if (!Array.isArray(content)) return undefined;

    // RTK handles bash; extension only covers read/find/others
    if (toolName === "bash") return undefined;

    const threshold = THRESHOLDS[toolName] ?? DEFAULT_THRESHOLD;

    const textParts = content.filter(c => c.type === "text");
    if (textParts.length === 0) return undefined; // no text content

    const fullText = textParts.map(c => c.text ?? "").join("");
    const truncated = truncateText(fullText, threshold);
    if (truncated === null) return undefined; // under threshold, no change

    // Rebuild content: replace text parts with single truncated part, keep non-text
    const newContent = [
      ...content.filter(c => c.type !== "text"),
      { type: "text", text: truncated },
    ];
    return { content: newContent };
  } catch {
    return undefined; // always passthrough on error
  }
}

export function createOutputFilterExtension(_session) {
  return {
    toolResult: filterToolResult,
  };
}
```

- [ ] **Step 4: Run tests**

```bash
node --test shared/extensions/output-filter.test.mjs 2>&1 | tail -15
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add shared/extensions/output-filter.mjs shared/extensions/output-filter.test.mjs
git commit -m "feat(token-filter): add pi extension to truncate oversized read/find tool results"
```

---

## Task 11: Feature 1C — RTK spawnHook enhancement

**Files:**
- Modify: `sub-agent/tools.mjs`
- Modify: `planning-agent/tools.mjs`

- [ ] **Step 1: Enhance `sub-agent/tools.mjs`**

Add RTK availability check at module level (top of file, after imports):

```javascript
import { spawnSync } from "node:child_process";

// Check once at module load whether RTK is runnable on this architecture
const isRtkAvailable = (() => {
  try {
    const result = spawnSync("/usr/local/bin/rtk", ["--version"], { timeout: 3000 });
    return result.status === 0;
  } catch {
    return false;
  }
})();

if (!isRtkAvailable) {
  console.warn("[tools] RTK not available — bash output will not be filtered");
}
```

In `createGuardHook`, after the block-list loop returns `context`, prepend RTK:

```javascript
// After all block-list checks pass:
if (isRtkAvailable) {
  return { ...context, command: "rtk " + context.command };
}
return context;
```

Full updated function end:

```javascript
    // No block matched
    if (isRtkAvailable) {
      return { ...context, command: "rtk " + context.command };
    }
    return context;
  };
}
```

- [ ] **Step 2: Apply same changes to `planning-agent/tools.mjs`**

Add the same `isRtkAvailable` block and the same RTK prepend at the end of `createPlanningAgentGuardHook`.

- [ ] **Step 3: Verify syntax of both files**

```bash
node --check sub-agent/tools.mjs && node --check planning-agent/tools.mjs && echo "OK"
```

Expected: `OK`.

- [ ] **Step 4: Run sub-agent tool tests**

```bash
cd sub-agent && node --test tools.test.mjs 2>&1 | tail -15
```

Review results — existing tests should still pass. If any use the guard hook's return value, they may need updating to account for RTK prefix (when RTK is absent in test environment, behaviour is unchanged).

- [ ] **Step 5: Commit**

```bash
git add sub-agent/tools.mjs planning-agent/tools.mjs
git commit -m "feat(token-filter): prepend rtk to bash commands via spawnHook in both agent runners"
```

---

## Task 12: Feature 1D — Dockerfile updates and build context changes

**Files:**
- Modify: `sub-agent/Dockerfile`
- Modify: `planning-agent/Dockerfile`
- Modify: `docker-compose.yml` (planning-agent build context)
- Modify: `backend/src/orchestrator/imageBuilder.ts`
- Modify: `sub-agent/runner.mjs` (add extensionFactories)
- Modify: `planning-agent/runner.mjs` (add extensionFactories)

- [ ] **Step 1: Update `sub-agent/Dockerfile`**

Add after the `COPY tools.mjs .` line:

```dockerfile
# shared/ is at repo root; build context must be repo root (see docker-compose / build docs)
COPY shared/bin/rtk /usr/local/bin/rtk
RUN chmod +x /usr/local/bin/rtk && \
    /usr/local/bin/rtk --version || echo "[warn] rtk not runnable on this arch; bash output unfiltered"
COPY shared/config/rtk-config.toml /root/.config/rtk/config.toml
COPY shared/extensions/ /app/shared/extensions/
```

Note: in the sub-agent Dockerfile the user is `bun`. Place the COPY lines before the `USER bun` directive so `/root/.config` is accessible during build (the runtime user can still read `/usr/local/bin/rtk`). Alternatively, copy to `/home/bun/.config/rtk/config.toml` if the runtime user is `bun`.

Check the Dockerfile's USER — adjust the config destination:
- If `USER bun`: `COPY shared/config/rtk-config.toml /home/bun/.config/rtk/config.toml`
- If `USER root` at that point: `/root/.config/rtk/config.toml`

- [ ] **Step 2: Update `planning-agent/Dockerfile`**

Add after `COPY --chown=node:node tools.mjs .`:

```dockerfile
COPY shared/bin/rtk /usr/local/bin/rtk
RUN chmod +x /usr/local/bin/rtk && \
    /usr/local/bin/rtk --version || echo "[warn] rtk not runnable on this arch"
COPY shared/config/rtk-config.toml /home/node/.config/rtk/config.toml
COPY shared/extensions/ /app/shared/extensions/
```

(planning-agent user is `node` → config goes to `/home/node/.config/rtk/config.toml`)

- [ ] **Step 3: Update docker-compose.yml planning-agent build context**

Change:
```yaml
  planning-agent:
    build: ./planning-agent
```
To:
```yaml
  planning-agent:
    build:
      context: .
      dockerfile: planning-agent/Dockerfile
```

- [ ] **Step 4: Update `imageBuilder.ts` error message**

Change the error message in `backend/src/orchestrator/imageBuilder.ts`:

```typescript
throw new Error(
  `[imageBuilder] Sub-agent image "${imageName}" not found. ` +
  `Build it with repo root as context: docker build -t ${imageName} -f sub-agent/Dockerfile .`
);
```

- [ ] **Step 5: Add `extensionFactories` to `sub-agent/runner.mjs`**

At the top of the file, add import:
```javascript
import { createOutputFilterExtension } from '/app/shared/extensions/output-filter.mjs';
```

In `createAgentSession`, change `DefaultResourceLoader` options:
```javascript
const resourceLoader = new DefaultResourceLoader({
  settingsManager,
  extensionFactories: [createOutputFilterExtension],  // add this
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  // noExtensions removed
});
```

- [ ] **Step 6: Add `extensionFactories` to `planning-agent/runner.mjs`**

Same as sub-agent: import `createOutputFilterExtension`, add to `DefaultResourceLoader` options, remove `noExtensions: true`.

- [ ] **Step 7: Build sub-agent image from repo root to verify**

```bash
docker build -t multi-agent-harness/sub-agent:latest -f sub-agent/Dockerfile . 2>&1 | tail -20
```

Expected: build succeeds, RTK version line visible in output.

- [ ] **Step 8: Build planning-agent image via compose**

```bash
docker compose build planning-agent 2>&1 | tail -20
```

Expected: build succeeds.

- [ ] **Step 9: Commit**

```bash
git add sub-agent/Dockerfile planning-agent/Dockerfile docker-compose.yml \
        backend/src/orchestrator/imageBuilder.ts \
        sub-agent/runner.mjs planning-agent/runner.mjs
git commit -m "feat(token-filter): install RTK + output-filter extension in both agent images; widen build contexts to repo root"
```

---

## Final Verification

- [ ] **Run full backend test suite one last time**

```bash
cd backend && npx vitest run 2>&1 | tail -15
```

Expected: all tests pass, no regressions.

- [ ] **Verify docker compose config**

```bash
docker compose config --quiet && echo "compose OK"
```

- [ ] **Final commit if any stray changes**

```bash
git status
```

If clean, nothing to do. If there are leftover changes, review and commit with an appropriate message.
