# Self-Healing Subagent System — Design

**Date:** 2026-03-22
**Status:** Approved

---

## Problem

Sub-agent tasks can fail silently for several reasons:

- Docker container crash or non-zero exit
- Container timeout
- Backend process restart leaving sessions stuck in `starting`/`running`

Currently there is no retry, no recovery after restart, and no notification to the master agent or user when tasks fail. Failed projects require manual intervention with no tooling support.

---

## Goals

1. Auto-retry each failed task up to `config.subAgentMaxRetries` times before giving up
2. Detect and recover stale sessions on boot and during ongoing polling
3. Notify the master agent when tasks permanently fail so it can inform the user
4. Give the master agent a tool to re-dispatch all permanently-failed tasks
5. Ensure retried sub-agents always start from the latest remote state of the branch

---

## Non-Goals

- Per-task retry counts configurable per-task (retry limit is a single global config value)
- Selective restart of individual tasks by the master agent (restarts all failed tasks)
- Retry of fix-run tasks (only plan task dispatch is covered)

---

## Architecture

### New component: `RecoveryService`

A singleton service initialized at boot in `index.ts` with the Docker instance. Exposed via module-level `getRecoveryService()` / `setRecoveryService()` accessors (same pattern as `DebounceEngine` / `getDebounceEngine()`).

Because `RecoveryService` holds the `docker` reference from its constructor, no caller needs to pass `docker` — `restartFailedTasksTool` and `polling.ts` call `getRecoveryService()` without any Docker argument.

```
index.ts
  const recoveryService = new RecoveryService(docker);
  setRecoveryService(recoveryService);
  await recoveryService.recoverOnBoot();   // must fully resolve before startPolling is called
  startPolling(docker);                    // fires first poll immediately; activeTaskIds already populated

polling.ts  (each poll cycle)
  await getRecoveryService().recoverExecutingProjects();
  // replaces the existing: dispatcher.dispatchTasks(docker, projectId) call in pollPlanningPrs

restartFailedTasksTool.ts
  getRecoveryService().dispatchFailedTasks(projectId)  // no docker needed
```

### `polling.ts` dispatch path

`pollPlanningPrs` currently calls `new TaskDispatcher().dispatchTasks(docker, projectId)` when LGTM is detected. This is replaced by `getRecoveryService().dispatchTasksForProject(projectId)`, which runs the retry-aware dispatch and handles master notification on completion.

### Responsibilities

| Method | Called from | Purpose |
|--------|------------|---------|
| `recoverOnBoot()` | `index.ts` once at startup | Scan stale sessions, register guards, retry or notify |
| `recoverExecutingProjects()` | `polling.ts` each cycle | Detect sessions stuck > threshold, retry or notify |
| `dispatchTasksForProject(projectId)` | `polling.ts` on LGTM approval | Dispatch all tasks in parallel with retry; notify master on completion |
| `dispatchWithRetry(project, task)` | internally | Run one task up to max attempts; notify on permanent failure |
| `dispatchFailedTasks(projectId)` | `restart_failed_tasks` tool | Reset retryCount, re-dispatch all failed tasks |

### `TaskDispatcher` changes

- `runTask` is promoted from `private` to `public` so `RecoveryService.dispatchWithRetry` can call `dispatcher.runTask(docker, project, task)` directly.
- `dispatchTasks` remains but is no longer called from the main flow. It can be kept for tests or removed in a follow-up.
- `TaskDispatcher.activeTasks: Map<string, Promise<TaskResult>>` currently exists but is never populated. Leave it as-is; the deduplication concern moves to `RecoveryService.activeTaskIds`.

---

## `activeTaskIds` — definition and lifecycle

`RecoveryService` has a single instance property:

```typescript
private activeTaskIds = new Set<string>();  // keyed by PlanTask.id
```

Lifecycle:
- **Added**: synchronously at the start of `dispatchWithRetry` (before any `await`)
- **Removed**: when `dispatchWithRetry` resolves, regardless of outcome (success or permanent failure)
- **Checked**: at the start of `dispatchWithRetry`, `dispatchFailedTasks`, and `recoverExecutingProjects` — if the task ID is present, skip

This means a task is guarded for the entire duration of its dispatch lifecycle, including all retry attempts.

---

## Retry Flow

`dispatchWithRetry(project: Project, task: PlanTask)`:

```
if task.id in activeTaskIds: return   ← guard
activeTaskIds.add(task.id)

localRetryCount = task.retryCount ?? 0   ← read from DB snapshot; track locally

while localRetryCount <= config.subAgentMaxRetries:
  updateTaskInPlan(task.id, { status: 'executing', retryCount: localRetryCount })
  result = await dispatcher.runTask(docker, project, task)   ← new session + container
  if result.success:
    updateTaskInPlan(task.id, { status: 'completed' })
    checkAllTerminal(project.id)   ← notify master if all tasks done
    activeTaskIds.delete(task.id)
    return
  localRetryCount++
  updateTaskInPlan(task.id, { status: 'failed', retryCount: localRetryCount })
  if localRetryCount <= config.subAgentMaxRetries: continue  ← retry

// All attempts exhausted
updateProject(project.id, { status: ... })   ← failed if all tasks failed
notifyMasterPartialFailure(project.id, task)
activeTaskIds.delete(task.id)
checkAllTerminal(project.id)
```

**`localRetryCount` semantics**: represents the number of failed attempts completed so far. The loop condition `localRetryCount <= subAgentMaxRetries` allows entry when `localRetryCount` equals `subAgentMaxRetries` (the final retry attempt). With `subAgentMaxRetries = 1` the loop runs for `localRetryCount = 0` (first attempt) and `localRetryCount = 1` (one retry) = 2 total attempts.

**Task status during retry**: `task.status` is set to `executing` at the top of each loop iteration, so `get_subagent_status` shows `executing` during active attempts. Between failure and the next attempt (within the loop) the status is briefly `failed` but immediately overwritten on the next iteration.

**Session records**: Each call to `runTask` inserts a new `AgentSession` row with a new UUID. Failed sessions from earlier attempts remain in the DB with `status = 'failed'`. `get_subagent_status` shows all sessions per task — this is the retry history.

---

## `checkAllTerminal`

After each task completes (success or permanent failure), `checkAllTerminal(projectId)` checks whether all tasks in `project.plan.tasks` have `status` in `['completed', 'failed', 'cancelled']`. If so:

1. Update `project.status` to `'completed'` (all succeeded) or `'failed'` (any failed)
2. Inject a `[SYSTEM]` message into the master agent via `getOrInitAgent(projectId).prompt(...)`

This replaces the existing post-`Promise.all` status update in `dispatchTasks`.

---

## Branch Handling on Retry

- **Branch naming is deterministic**: `branchName` is computed from `project.planningBranch` (primary repo) or `project.name + task.id.slice(0, 8)` (other repos). This formula produces the same name on every attempt. The spec relies on this determinism for idempotency — do not change the naming logic without updating this spec.
- **Branch creation is idempotent**: `createBranch` in `taskDispatcher.ts` is updated to catch "branch already exists" errors from the VCS connector and continue rather than failing. The GitHub and Bitbucket Server connectors (`connectors/github.ts`, `connectors/bitbucket.ts`) must also be checked — if they currently throw on duplicate branches, they should return gracefully instead. Both connectors are added to the Files Changed table.
- **Container clones latest remote**: the sub-agent container does a fresh `git clone` of `cloneUrl` at `branchName` on every run, picking up any commits from previous attempts.
- **Task description on retry** (when `localRetryCount > 0`) includes a preamble: *"Note: this is a retry. The branch `{branchName}` may contain partial work from a previous attempt — start from its current state."*

---

## Stale Session Recovery

### Definition of stale

A session is stale when **both** are true:
- `status` is `starting` or `running` in the DB
- The Docker container no longer exists, has exited, or is in an error state (checked via `getContainerStatus`)

### `updatedAt` dependency

The stale check uses `session.updatedAt`. `updateAgentSession` sets `updatedAt` on every call. No code paths today call `updateAgentSession` on a running session except on status transitions — this must remain true. If a heartbeat mechanism is added in future, replace the `updatedAt` stale check with a dedicated `lastHeartbeatAt` field.

### Boot recovery (`recoverOnBoot`)

**Ordering is critical** — `recoverOnBoot` must register task IDs in `activeTaskIds` before returning, so the first polling cycle (fired synchronously by `startPolling`) sees the guard populated:

```typescript
async recoverOnBoot(): Promise<void> {
  const staleSessions = queryStaleSessionsFromDb();          // synchronous
  const taskIds = staleSessions.map(s => s.taskId).filter(Boolean);
  for (const id of taskIds) this.activeTaskIds.add(id);      // synchronous, before any await

  for (const session of staleSessions) {
    await this.recoverSession(session);                      // async work starts here
  }
}
```

Steps per stale session:
1. Call `getContainerStatus(docker, containerId)` — if container is running, skip (not stale)
2. Mark session `failed`; mark corresponding `PlanTask` `failed`; increment `retryCount` in plan blob
3. If `retryCount <= config.subAgentMaxRetries`: call `dispatchWithRetry` without `await` (fire-and-forget within `recoverOnBoot`) — this keeps boot fast while ensuring `activeTaskIds` was pre-populated synchronously before any dispatch was started
4. If retries exhausted: notify master, remove task ID from `activeTaskIds`

**Clarification:** "fire-and-forget" applies to the individual `dispatchWithRetry` calls inside the loop, not to `recoverOnBoot` itself. `index.ts` must `await recoverOnBoot()` fully before calling `startPolling`. The `async` loop in `recoverOnBoot` processes each session sequentially (checking container status), but the `dispatchWithRetry` launches are non-blocking so they run in the background after boot completes.

### Polling recovery (`recoverExecutingProjects`)

1. Query projects with `status = 'executing'`
2. For each project, find sessions in `starting`/`running` where `updatedAt < now - staleSessionThresholdMs`
3. Same container check + `recoverSession` logic as boot recovery
4. **Concurrency guard**: if `task.id` is in `activeTaskIds`, skip entirely

### Stale session threshold

`staleSessionThresholdMs` defaults to `35 * 60 * 1000` (35 minutes). This exceeds the default `subAgentTimeoutMs` of 30 minutes, ensuring a legitimately running container is never flagged stale before its own timeout fires.

```typescript
// config.ts
staleSessionThresholdMs: parseInt(
  process.env.STALE_SESSION_THRESHOLD_MS ?? String(35 * 60 * 1000),
  10
),
```

The literal `35 * 60 * 1000` is used (not `config.subAgentTimeoutMs + ...`) because an object literal cannot reference its own properties during construction. If `subAgentTimeoutMs` is changed via env, `STALE_SESSION_THRESHOLD_MS` should also be set explicitly.

---

## Master Agent Notification

Injected via `getOrInitAgent(projectId).prompt(...)`.

**Cold-start caveat:** If the backend restarted and no WebSocket client has reconnected, `getOrInitAgent` cold-starts a new `MasterAgent` with a blank session. The `[SYSTEM]` message lands as the first prompt with no prior conversation context. The agent can still invoke `restart_failed_tasks` correctly — but only if the tool is present in the tool list passed to the constructor.

**`getOrInitAgent` must always include `restart_failed_tasks`:** The tool list assembled inside `getOrInitAgent` (not just in the WebSocket connection handler) must include `createRestartFailedTasksTool(projectId)`. This is the only path through which `RecoveryService` obtains a master agent for notifications. The tool must be wired unconditionally so cold-started agents and normally-connected agents both have access to it.

### All tasks terminal

```
[SYSTEM] Sub-agent execution complete.
Succeeded: Task 1 (Create auth module), Task 2 (Write tests)
Failed (retries exhausted): Task 3 (Deploy script)

Use restart_failed_tasks to retry failed tasks, or inform the user.
```

### Partial failure (some tasks still running)

```
[SYSTEM] Task 3 (Deploy script) has permanently failed after {N} attempts.
Other tasks are still running. Use restart_failed_tasks when ready,
or wait for the remaining tasks to finish first.
```

---

## Master Agent Tools

### `restart_failed_tasks` (new, `restartFailedTasksTool.ts`)

Factory function pattern (same as existing tools):

```typescript
export function createRestartFailedTasksTool(projectId: string): ToolDefinition<...> {
  return {
    name: "restart_failed_tasks",
    description: "Re-dispatches all permanently failed tasks for this project. Resets retry counts so each task gets fresh attempts.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _args) {
      const result = await getRecoveryService().dispatchFailedTasks(projectId);
      return { content: [{ type: "text", text: `Re-queued ${result.count} task(s).` }] };
    }
  };
}
```

`dispatchFailedTasks(projectId)`:
1. Find all `PlanTask` with `status === 'failed'`
2. For each: skip if `task.id` in `activeTaskIds`
3. Reset `retryCount` to 0, `status` to `pending` via `updateTaskInPlan`
4. Update `project.status` to `'executing'`
5. Fire `dispatchWithRetry` for each (fire-and-forget)
6. Return `{ count: N }` immediately (N = tasks actually re-queued, excluding already-active ones)

### `get_subagent_status` (existing, unchanged)

Will now show multiple sessions per task when retries have occurred. Each session reflects one attempt.

---

## Data Model Changes

### `types.ts`

```typescript
export interface PlanTask {
  id: string;
  repositoryId: string;
  description: string;
  status: "pending" | "executing" | "completed" | "failed" | "cancelled";
  dependsOn?: string[];
  retryCount?: number;  // NEW: failed attempts consumed (undefined = 0)
}
```

No DB migration — `plan` is a JSON blob in `projects`. Optional field is backwards compatible.

### `store/projects.ts` — new helper

```typescript
export function updateTaskInPlan(
  projectId: string,
  taskId: string,
  updates: Partial<PlanTask>
): void
```

Reads plan JSON, patches the matching task, writes back atomically. All other tasks are untouched.

**Concurrency safety:** `dispatchTasksForProject` launches multiple `dispatchWithRetry` calls in parallel. Each calls `updateTaskInPlan` on status transitions, producing concurrent read-modify-write operations on the same `plan` JSON blob. To prevent tasks clobbering each other's updates, `updateTaskInPlan` must wrap the read-modify-write in a `better-sqlite3` synchronous transaction:

```typescript
export function updateTaskInPlan(projectId, taskId, updates) {
  const db = getDb();
  db.transaction(() => {
    const row = db.prepare("SELECT plan FROM projects WHERE id = ?").get(projectId);
    const plan = JSON.parse(row.plan);
    const task = plan.tasks.find(t => t.id === taskId);
    if (task) Object.assign(task, updates);
    db.prepare("UPDATE projects SET plan = ? WHERE id = ?")
      .run(JSON.stringify(plan), projectId);
  })();
}
```

`better-sqlite3` transactions are synchronous and serialise concurrent JS callers against the same SQLite connection, preventing lost updates.

### `config.ts` — changes

```typescript
// Change default from 3 to 1 (2 total attempts: 1 initial + 1 retry)
subAgentMaxRetries: parseInt(process.env.SUB_AGENT_MAX_RETRIES ?? "1", 10),

// New: must exceed subAgentTimeoutMs (default 30 min); use literal not self-reference
staleSessionThresholdMs: parseInt(
  process.env.STALE_SESSION_THRESHOLD_MS ?? String(35 * 60 * 1000),
  10
),
```

---

## Files Changed

| File | Change |
|------|--------|
| `backend/src/orchestrator/recoveryService.ts` | **New** — core self-healing logic |
| `backend/src/agents/restartFailedTasksTool.ts` | **New** — master agent tool (factory function) |
| `backend/src/models/types.ts` | Add `retryCount?` to `PlanTask` |
| `backend/src/store/projects.ts` | Add `updateTaskInPlan` helper |
| `backend/src/config.ts` | Change `subAgentMaxRetries` default to 1; add `staleSessionThresholdMs` |
| `backend/src/index.ts` | Init `RecoveryService`, call `recoverOnBoot` before `startPolling` |
| `backend/src/polling.ts` | Replace `dispatchTasks` call with `dispatchTasksForProject`; add `recoverExecutingProjects` call |
| `backend/src/api/websocket.ts` | Wire `restart_failed_tasks` tool via `createRestartFailedTasksTool(projectId)` inside `getOrInitAgent` (not just at WS connection time) |
| `backend/src/orchestrator/taskDispatcher.ts` | Make `runTask` public; make `createBranch` idempotent |
| `backend/src/connectors/github.ts` | Handle duplicate-branch gracefully in `createBranch` |
| `backend/src/connectors/bitbucket.ts` | Handle duplicate-branch gracefully in `createBranch` |

---

## Testing

- Unit test `RecoveryService.dispatchWithRetry`: mock `runTask` to fail twice, assert task permanently failed + master notified; assert `activeTaskIds` cleared on exit
- Unit test retry semantics: mock first attempt fail, second succeed; assert `retryCount` incremented then `status = 'completed'`
- Unit test `RecoveryService.recoverOnBoot`: mock stale sessions + container status; assert task IDs in `activeTaskIds` before first `await`; assert retry dispatched
- Unit test `activeTaskIds` guard: assert `dispatchWithRetry`, `dispatchFailedTasks`, and `recoverExecutingProjects` all skip in-flight tasks
- Unit test `checkAllTerminal`: assert project status updated and master notified only when all tasks reach a terminal state
- Unit test `updateTaskInPlan`: assert patch applied correctly without corrupting sibling tasks
- Unit test `restart_failed_tasks` tool: assert `dispatchFailedTasks` called; retryCount reset; `activeTaskIds` excludes already-running tasks
- Unit test stale threshold: assert sessions updated within `staleSessionThresholdMs` are not flagged
- Unit test `createBranch` idempotency: mock connector to throw duplicate-branch error; assert no failure propagated
- Existing E2E tests unchanged (recovery is transparent to the happy path)
