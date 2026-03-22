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

1. Auto-retry each failed task once before giving up
2. Detect and recover stale sessions on boot and during ongoing polling
3. Notify the master agent when tasks permanently fail so it can inform the user
4. Give the master agent a tool to re-dispatch all permanently-failed tasks
5. Ensure retried sub-agents always start from the latest remote state of the branch

---

## Non-Goals

- Per-task retry counts configurable by the user (fixed at 1 retry)
- Selective restart of individual tasks by the master agent (restarts all failed tasks)
- Retry of fix-run tasks (only plan task dispatch is covered)

---

## Architecture

### New component: `RecoveryService`

A singleton service initialized at boot in `index.ts` with the Docker instance. Exposed via module-level `getRecoveryService()` / `setRecoveryService()` accessors (same pattern as `DebounceEngine`).

```
index.ts
  const recoveryService = new RecoveryService(docker);
  setRecoveryService(recoveryService);
  await recoveryService.recoverOnBoot();
  startPolling(docker);

polling.ts  (each poll cycle)
  await getRecoveryService().recoverExecutingProjects();

restartFailedTasksTool.ts
  getRecoveryService().dispatchFailedTasks(projectId)
```

### Responsibilities

| Method | Called from | Purpose |
|--------|------------|---------|
| `recoverOnBoot()` | `index.ts` once at startup | Scan all stale sessions, retry or notify |
| `recoverExecutingProjects()` | `polling.ts` each cycle | Detect sessions stuck > threshold, retry or notify |
| `dispatchWithRetry(docker, project, task)` | internally | Run task up to 2 attempts, notify master on permanent failure |
| `dispatchFailedTasks(projectId)` | `restart_failed_tasks` tool | Reset retryCount, re-dispatch all failed tasks |

---

## Retry Flow

```
dispatchWithRetry(project, task)
  ├─ attempt 1: TaskDispatcher.runTask()
  │    success → mark task completed, check if all done → notify master
  │    failure ↓
  ├─ increment task.retryCount to 1 (updateTaskInPlan)
  ├─ attempt 2: TaskDispatcher.runTask()
  │    (container clones latest remote state of existing branch)
  │    (task description prefixed with resume note)
  │    success → mark task completed, check if all done → notify master
  │    failure ↓
  └─ mark task permanently failed
     update project status if all tasks terminal
     notify master agent via [SYSTEM] prompt
```

### Branch handling on retry

- **Branch creation is idempotent**: `createBranch` catches "branch already exists" and continues. The branch from attempt 1 is reused.
- **Container clones latest remote**: the sub-agent container always does a fresh `git clone` of `cloneUrl` at `branchName`, naturally picking up any commits from the previous attempt.
- **Task description on retry** includes a preamble: *"Note: this is a retry. The branch `{branchName}` may contain partial work from a previous attempt — start from its current state."*

---

## Stale Session Recovery

### Definition of stale

A session is stale when **both** are true:
- `status` is `starting` or `running` in the DB
- The Docker container is gone, exited, or unknown

### Boot recovery (`recoverOnBoot`)

1. Query all agent sessions where `status IN ('starting', 'running')`
2. For each: call `getContainerStatus(docker, containerId)`
3. Stale → mark session `failed`, mark corresponding `PlanTask` `failed`
4. If `task.retryCount < 1`: re-dispatch via `dispatchWithRetry`
5. If retries exhausted: notify master with summary

### Polling recovery (`recoverExecutingProjects`)

1. Query projects with `status = 'executing'`
2. For each project, find sessions in `starting`/`running` where `updatedAt` is older than `staleSessionThresholdMs` (default 5 minutes)
3. Same container check + retry-or-notify logic as boot recovery
4. **Concurrency guard**: skip if the task ID is already in the `activeTaskIds: Set<string>` tracked by `RecoveryService` (prevents double-dispatch)

---

## Master Agent Notification

Injected via `getOrInitAgent(projectId).prompt(...)` by `RecoveryService`.

### All tasks terminal (all succeeded or permanently failed)

```
[SYSTEM] Sub-agent execution complete.
Succeeded: Task 1 (Create auth module), Task 2 (Write tests)
Failed (retries exhausted): Task 3 (Deploy script)

Use restart_failed_tasks to retry failed tasks, or inform the user.
```

### Partial failure (some tasks still running)

```
[SYSTEM] Task 3 (Deploy script) has permanently failed after 2 attempts.
Other tasks are still running. Use restart_failed_tasks when ready,
or wait for the remaining tasks to finish first.
```

---

## Master Agent Tools

### `restart_failed_tasks` (new)

```typescript
// restartFailedTasksTool.ts
{
  name: "restart_failed_tasks",
  description: "Re-dispatches all permanently failed tasks for this project. Resets retry counts so each task gets two fresh attempts.",
  parameters: Type.Object({}),
  execute: async () => {
    const result = await getRecoveryService().dispatchFailedTasks(projectId);
    return { content: [{ type: "text", text: `Re-queued ${result.count} task(s).` }] };
  }
}
```

`dispatchFailedTasks`:
1. Find all `PlanTask` with `status === 'failed'`
2. Reset `retryCount` to 0, `status` to `pending` via `updateTaskInPlan`
3. Update project `status` back to `executing`
4. Dispatch each via `dispatchWithRetry`

### `get_subagent_status` (existing, unchanged)

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
  retryCount?: number;  // NEW: attempts consumed (undefined = 0)
}
```

No DB migration — `plan` is stored as a JSON blob, optional field is backwards compatible.

### `store/projects.ts` — new helper

```typescript
export function updateTaskInPlan(
  projectId: string,
  taskId: string,
  updates: Partial<PlanTask>
): void
```

Reads plan JSON, patches the matching task, writes back atomically.

### `config.ts` — new value

```typescript
staleSessionThresholdMs: number  // default: 5 * 60 * 1000
// env: STALE_SESSION_THRESHOLD_MS
```

---

## Files Changed

| File | Change |
|------|--------|
| `backend/src/orchestrator/recoveryService.ts` | **New** — core self-healing logic |
| `backend/src/agents/restartFailedTasksTool.ts` | **New** — master agent tool |
| `backend/src/models/types.ts` | Add `retryCount?` to `PlanTask` |
| `backend/src/store/projects.ts` | Add `updateTaskInPlan` helper |
| `backend/src/config.ts` | Add `staleSessionThresholdMs` |
| `backend/src/index.ts` | Init `RecoveryService`, call `recoverOnBoot` |
| `backend/src/polling.ts` | Call `recoverExecutingProjects` each cycle |
| `backend/src/api/websocket.ts` | Wire `restart_failed_tasks` tool |
| `backend/src/orchestrator/taskDispatcher.ts` | Make `createBranch` idempotent; `runTask` already public |

---

## Testing

- Unit test `RecoveryService.dispatchWithRetry`: mock `runTask` to fail twice, assert task marked failed + master notified
- Unit test `RecoveryService.recoverOnBoot`: mock stale sessions + container status, assert retry dispatched
- Unit test `updateTaskInPlan`: assert patch is applied correctly without corrupting other tasks
- Unit test `restart_failed_tasks` tool: assert `dispatchFailedTasks` called, retryCount reset
- Existing E2E tests unchanged (recovery is transparent to the happy path)
