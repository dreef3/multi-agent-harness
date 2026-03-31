# SQLite-Backed Task Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make task dispatch restart-resilient by persisting queued task entries to a new `task_queue` SQLite table, so that tasks waiting for a concurrency slot survive a backend restart and are re-dispatched immediately on boot rather than waiting for the 60-second polling cycle.

**Architecture:** A new `task_queue` table (id, project_id, queued_at, priority, status) is created in the existing `harness.db`. A new store module `backend/src/store/taskQueue.ts` exposes `enqueueTask`, `dequeueNextTask`, `markTaskDispatching`, `removeFromQueue`, and `listQueuedTasks`. `RecoveryService.dispatchWithRetry` calls `enqueueTask` before acquiring a semaphore slot and `removeFromQueue` after the task finishes (success or failure). The existing in-memory semaphore (`this.slots`, `this.waiters`, `this.projectSlots`) is unchanged — it continues to govern active concurrency at runtime. Boot recovery is extended to re-dispatch any tasks still in `status = 'queued'` in the DB.

**Tech Stack:** TypeScript, better-sqlite3, Express backend, `RecoveryService`, `recoveryService.ts`, `db.ts`.

---

## Step 1 — Add `task_queue` table migration to `db.ts`

- [ ] Read `backend/src/store/db.ts` (already read — reference the `migrate()` function).

- [ ] Add the new table and index to the `migrate()` function's `database.exec(...)` call. Add immediately after the `agent_events` table and its index:

```typescript
    CREATE TABLE IF NOT EXISTS task_queue (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      queued_at   TEXT NOT NULL,
      priority    INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'queued'
    );

    CREATE INDEX IF NOT EXISTS idx_task_queue_status
      ON task_queue (status, priority DESC, queued_at ASC);
```

This must be inside the `database.exec(` template literal so it runs in the same transaction-free batch as the other `CREATE TABLE IF NOT EXISTS` statements.

The full `task_queue` addition in context:

```typescript
    CREATE INDEX IF NOT EXISTS idx_agent_events_session
      ON agent_events (session_id);

    CREATE TABLE IF NOT EXISTS task_queue (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      queued_at   TEXT NOT NULL,
      priority    INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'queued'
    );

    CREATE INDEX IF NOT EXISTS idx_task_queue_status
      ON task_queue (status, priority DESC, queued_at ASC);
  `);
```

**Status values:**
- `'queued'` — task is waiting for a concurrency slot; server restart should re-dispatch it
- `'dispatching'` — slot acquired, container is starting (in-flight)
- `'done'` — task finished (success or failure); entry is deleted shortly after

In practice `'done'` entries are deleted immediately by `removeFromQueue`, so they will not accumulate. The `status` column is still useful for debug queries and for the `listQueuedTasks` function which filters on `'queued'`.

---

## Step 2 — Create `backend/src/store/taskQueue.ts`

- [ ] Create the file at `/home/ae/multi-agent-harness/backend/src/store/taskQueue.ts`:

```typescript
import { getDb } from "./db.js";

export interface QueuedTask {
  id: string;
  projectId: string;
  priority: number;
  queuedAt: string;
}

/**
 * Insert a task into the queue.
 * INSERT OR IGNORE ensures idempotency — calling enqueueTask twice for the same
 * task ID is safe; the second call is a no-op.
 */
export function enqueueTask(taskId: string, projectId: string, priority = 0): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO task_queue (id, project_id, queued_at, priority, status)
       VALUES (?, ?, ?, ?, 'queued')`
    )
    .run(taskId, projectId, new Date().toISOString(), priority);
}

/**
 * Return the next task to dispatch (highest priority, then oldest queued_at).
 * Returns null if the queue is empty.
 */
export function dequeueNextTask(): { id: string; projectId: string } | null {
  return (
    getDb()
      .prepare(
        `SELECT id, project_id AS projectId
         FROM task_queue
         WHERE status = 'queued'
         ORDER BY priority DESC, queued_at ASC
         LIMIT 1`
      )
      .get() as { id: string; projectId: string } | undefined
  ) ?? null;
}

/**
 * Mark a task as actively being dispatched (slot acquired, container starting).
 */
export function markTaskDispatching(taskId: string): void {
  getDb()
    .prepare(`UPDATE task_queue SET status = 'dispatching' WHERE id = ?`)
    .run(taskId);
}

/**
 * Remove a task from the queue entirely (call after task completes or fails permanently).
 */
export function removeFromQueue(taskId: string): void {
  getDb()
    .prepare(`DELETE FROM task_queue WHERE id = ?`)
    .run(taskId);
}

/**
 * List all tasks currently in 'queued' status, ordered by priority then age.
 */
export function listQueuedTasks(): QueuedTask[] {
  return getDb()
    .prepare(
      `SELECT id, project_id AS projectId, priority, queued_at AS queuedAt
       FROM task_queue
       WHERE status = 'queued'
       ORDER BY priority DESC, queued_at ASC`
    )
    .all() as QueuedTask[];
}

/**
 * List all tasks in the queue regardless of status (for diagnostics).
 */
export function listAllQueueEntries(): Array<QueuedTask & { status: string }> {
  return getDb()
    .prepare(
      `SELECT id, project_id AS projectId, priority, queued_at AS queuedAt, status
       FROM task_queue
       ORDER BY priority DESC, queued_at ASC`
    )
    .all() as Array<QueuedTask & { status: string }>;
}

/**
 * Called on boot recovery: remove queue entries for tasks that are no longer
 * in a state that requires queuing (i.e. tasks that are completed, failed,
 * or have an active running session). Stale 'dispatching' entries from a
 * crashed server are reset to 'queued' so they will be re-dispatched.
 */
export function resetStaleDispatchingEntries(): void {
  // Reset 'dispatching' → 'queued': these were mid-dispatch when the server crashed.
  // The corresponding containers are gone (server restarted), so they need re-dispatch.
  getDb()
    .prepare(`UPDATE task_queue SET status = 'queued' WHERE status = 'dispatching'`)
    .run();
}

/**
 * Remove queue entries for a list of task IDs that are known to be terminal
 * (completed or failed) and no longer need dispatching.
 */
export function removeTerminalTasks(taskIds: string[]): void {
  if (taskIds.length === 0) return;
  const placeholders = taskIds.map(() => "?").join(", ");
  getDb()
    .prepare(`DELETE FROM task_queue WHERE id IN (${placeholders})`)
    .run(...taskIds);
}
```

---

## Step 3 — Integrate `taskQueue` into `RecoveryService`

### Step 3a — Add import

- [ ] In `backend/src/orchestrator/recoveryService.ts`, add the import after the existing store imports:

```typescript
import {
  enqueueTask,
  markTaskDispatching,
  removeFromQueue,
  listQueuedTasks,
  resetStaleDispatchingEntries,
  removeTerminalTasks,
} from "../store/taskQueue.js";
```

### Step 3b — Enqueue task before acquiring slot in `dispatchWithRetry`

- [ ] In `dispatchWithRetry`, immediately after `this.activeTaskIds.add(task.id)` (line ~201) and before `await this.acquireProjectSlot(project.id)`, add:

```typescript
    // Persist to queue so restart recovery can re-dispatch if the server dies while waiting
    const taskPriority = (task.retryCount ?? 0) > 0 ? 1 : 0; // retries get higher priority
    enqueueTask(task.id, project.id, taskPriority);
```

The full context around the insertion:

```typescript
  async dispatchWithRetry(project: Project, task: PlanTask): Promise<void> {
    if (this.activeTaskIds.has(task.id)) return; // concurrency guard
    this.activeTaskIds.add(task.id);

    // Persist to queue so restart recovery can re-dispatch if the server dies while waiting
    const taskPriority = (task.retryCount ?? 0) > 0 ? 1 : 0; // retries get higher priority
    enqueueTask(task.id, project.id, taskPriority);

    await this.acquireProjectSlot(project.id);
    // ... rest of the function
```

### Step 3c — Mark task as dispatching after slot is acquired

- [ ] Inside `dispatchWithRetry`, after `await this.acquireSlot()` succeeds (line ~232), add:

```typescript
          markTaskDispatching(task.id);
```

In context:

```typescript
          // Acquire a concurrency slot before starting a container
          await this.acquireSlot();
          console.log(`[recoveryService] slot acquired for task ${task.id} ...`);
          markTaskDispatching(task.id);
          let result: Awaited<ReturnType<typeof this.dispatcher.runTask>>;
```

### Step 3d — Remove from queue after task finishes

- [ ] In the `finally` block of `dispatchWithRetry` (line ~278), add `removeFromQueue` before the existing cleanup:

```typescript
      } finally {
        span.end();
        removeFromQueue(task.id);      // ← add this line
        this.activeTaskIds.delete(task.id);
        this.releaseProjectSlot(project.id);
      }
```

This ensures the queue entry is removed whether the task succeeded, failed permanently, or threw an unexpected error.

---

## Step 4 — Extend boot recovery to re-dispatch queued tasks

### Step 4a — Reset stale dispatching entries on boot

- [ ] In `recoverOnBoot()`, add `resetStaleDispatchingEntries()` as the very first line (before the existing `listStaleAgentSessions()` call):

```typescript
  async recoverOnBoot(): Promise<void> {
    // Reset any 'dispatching' queue entries from a previous crashed server instance.
    // These tasks' containers are gone, so they need to be re-queued for dispatch.
    resetStaleDispatchingEntries();

    const allSessions = listStaleAgentSessions();
    // ... rest of existing recoverOnBoot
```

### Step 4b — Re-dispatch persisted queued tasks after session recovery

- [ ] At the end of `recoverOnBoot()`, after `await this.recoverOrphanedExecutingProjects()`, add:

```typescript
    // Re-dispatch any tasks that were queued (waiting for a slot) when the server died.
    // These are tasks whose containers never started, so they don't have stale sessions.
    await this.redispatchQueuedTasks();
```

### Step 4c — Implement `redispatchQueuedTasks()`

- [ ] Add the new private method to `RecoveryService`, after `recoverOrphanedExecutingProjects()`:

```typescript
  /**
   * Re-dispatch tasks that are in the task_queue with status 'queued'.
   * These are tasks that were waiting for a concurrency slot when the server restarted.
   * Without this, they would be stuck until the 60-second polling cycle fires.
   */
  private async redispatchQueuedTasks(): Promise<void> {
    const queued = listQueuedTasks();
    if (queued.length === 0) return;

    console.log(`[recoveryService] Re-dispatching ${queued.length} queued task(s) from persistent queue`);

    // Identify terminal task IDs to avoid re-dispatching tasks that already completed
    // in a previous server instance (queue cleanup may have been missed on crash)
    const terminalIds: string[] = [];

    for (const entry of queued) {
      if (this.activeTaskIds.has(entry.id)) continue; // already in-flight from session recovery

      const project = getProject(entry.projectId);
      if (!project?.plan) {
        console.warn(`[recoveryService] Queued task ${entry.id} has no project/plan — removing from queue`);
        terminalIds.push(entry.id);
        continue;
      }

      const task = project.plan.tasks.find(t => t.id === entry.id);
      if (!task) {
        console.warn(`[recoveryService] Queued task ${entry.id} not found in plan — removing from queue`);
        terminalIds.push(entry.id);
        continue;
      }

      const terminal = new Set(["completed", "failed", "cancelled"]);
      if (terminal.has(task.status)) {
        console.log(`[recoveryService] Queued task ${entry.id} is already terminal (${task.status}) — removing from queue`);
        terminalIds.push(entry.id);
        continue;
      }

      // Reset to pending if stuck as 'executing' with no live container
      if (task.status === "executing") {
        updateTaskInPlan(entry.projectId, entry.id, { status: "pending" });
      }

      const freshProject = getProject(entry.projectId)!;
      const freshTask = freshProject.plan!.tasks.find(t => t.id === entry.id) ?? task;
      void this.dispatchWithRetry(freshProject, freshTask);
    }

    // Clean up terminal entries from queue
    if (terminalIds.length > 0) {
      removeTerminalTasks(terminalIds);
    }
  }
```

---

## Step 5 — Write unit tests for `taskQueue.ts`

- [ ] Create `backend/src/store/taskQueue.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { initDb } from "./db.js";
import {
  enqueueTask,
  dequeueNextTask,
  markTaskDispatching,
  removeFromQueue,
  listQueuedTasks,
  listAllQueueEntries,
  resetStaleDispatchingEntries,
  removeTerminalTasks,
} from "./taskQueue.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Use a fresh in-memory-equivalent DB per test suite
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  initDb(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("enqueueTask", () => {
  test("inserts a new queue entry", () => {
    enqueueTask("task-1", "proj-1", 0);
    const all = listAllQueueEntries();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("task-1");
    expect(all[0].status).toBe("queued");
  });

  test("is idempotent — duplicate insert is ignored", () => {
    enqueueTask("task-1", "proj-1", 0);
    enqueueTask("task-1", "proj-1", 0);
    expect(listAllQueueEntries()).toHaveLength(1);
  });
});

describe("dequeueNextTask", () => {
  test("returns null when queue is empty", () => {
    expect(dequeueNextTask()).toBeNull();
  });

  test("returns highest priority task first", () => {
    enqueueTask("task-low", "proj-1", 0);
    enqueueTask("task-high", "proj-1", 1);
    const next = dequeueNextTask();
    expect(next?.id).toBe("task-high");
  });

  test("returns oldest task when priorities are equal", async () => {
    enqueueTask("task-older", "proj-1", 0);
    // Ensure different queued_at by advancing time slightly
    await new Promise(r => setTimeout(r, 5));
    enqueueTask("task-newer", "proj-1", 0);
    expect(dequeueNextTask()?.id).toBe("task-older");
  });

  test("does not return dispatching tasks", () => {
    enqueueTask("task-1", "proj-1", 0);
    markTaskDispatching("task-1");
    expect(dequeueNextTask()).toBeNull();
  });
});

describe("markTaskDispatching", () => {
  test("changes task status to dispatching", () => {
    enqueueTask("task-1", "proj-1", 0);
    markTaskDispatching("task-1");
    const all = listAllQueueEntries();
    expect(all[0].status).toBe("dispatching");
  });
});

describe("removeFromQueue", () => {
  test("deletes the entry", () => {
    enqueueTask("task-1", "proj-1", 0);
    removeFromQueue("task-1");
    expect(listAllQueueEntries()).toHaveLength(0);
  });

  test("is safe to call on non-existent entry", () => {
    expect(() => removeFromQueue("nonexistent")).not.toThrow();
  });
});

describe("listQueuedTasks", () => {
  test("only returns queued status tasks", () => {
    enqueueTask("task-1", "proj-1", 0);
    enqueueTask("task-2", "proj-1", 0);
    markTaskDispatching("task-2");
    const queued = listQueuedTasks();
    expect(queued).toHaveLength(1);
    expect(queued[0].id).toBe("task-1");
  });
});

describe("resetStaleDispatchingEntries", () => {
  test("resets dispatching entries to queued", () => {
    enqueueTask("task-1", "proj-1", 0);
    markTaskDispatching("task-1");
    resetStaleDispatchingEntries();
    const all = listAllQueueEntries();
    expect(all[0].status).toBe("queued");
  });

  test("does not affect queued entries", () => {
    enqueueTask("task-1", "proj-1", 0);
    resetStaleDispatchingEntries();
    expect(listAllQueueEntries()[0].status).toBe("queued");
  });
});

describe("removeTerminalTasks", () => {
  test("removes all specified IDs", () => {
    enqueueTask("task-1", "proj-1", 0);
    enqueueTask("task-2", "proj-1", 0);
    removeTerminalTasks(["task-1", "task-2"]);
    expect(listAllQueueEntries()).toHaveLength(0);
  });

  test("is safe with empty array", () => {
    expect(() => removeTerminalTasks([])).not.toThrow();
  });
});
```

- [ ] Run `cd backend && bun run test src/store/taskQueue.test.ts` and confirm all tests pass.

---

## Step 6 — Verify integration with RecoveryService

### Step 6a — Run full backend test suite

- [ ] `cd backend && bun run test` — confirm no regressions.

### Step 6b — Smoke test restart recovery

This can be done manually in a dev environment:

- [ ] Start a project and dispatch tasks.
- [ ] While tasks are in the queue (status = `queued` in `task_queue`), stop the backend process.
- [ ] Restart the backend.
- [ ] Confirm that tasks are re-dispatched immediately (log line: `[recoveryService] Re-dispatching N queued task(s) from persistent queue`) rather than waiting for the 60-second poll cycle.

### Step 6c — Verify TypeScript compilation

- [ ] `cd backend && bun run build` or `npx tsc --noEmit` — confirm no TypeScript errors.

---

## Design notes

**Why not modify `plan_json`?** The `projects.plan_json` column stores the full plan as a JSON blob. Task status updates go through `updateTaskInPlan()`, which serialises the entire plan back to JSON on every call. Adding queue state to this column would require deserializing/updating/reserializing on every enqueue and dequeue operation — slower and more error-prone than a dedicated row-per-task table.

**Why `INSERT OR IGNORE` instead of `INSERT OR REPLACE`?** If a task was already enqueued (e.g., `dispatchWithRetry` is called twice due to a race), `INSERT OR IGNORE` preserves the original `queued_at` timestamp, maintaining correct FIFO ordering. `INSERT OR REPLACE` would reset the timestamp and push the task to the back of the queue.

**Why not use `this.waiters` for recovery?** The in-memory `waiters` array is lost on restart. Persisting all queue state to SQLite gives the recovery service a source of truth that survives process crashes, OOM kills, and intentional restarts.

**Semaphore unchanged:** The `this.slots` / `this.waiters` / `this.projectSlots` semaphore continues to be the authoritative runtime concurrency controller. The `task_queue` table adds persistence for recovery, not a new concurrency model.

---

## Summary of files changed

| File | Change |
|---|---|
| `backend/src/store/db.ts` | Add `task_queue` table + index in `migrate()` |
| `backend/src/store/taskQueue.ts` | New file — queue CRUD operations |
| `backend/src/store/taskQueue.test.ts` | New file — unit tests |
| `backend/src/orchestrator/recoveryService.ts` | Import queue functions; call enqueue/dispatching/remove in `dispatchWithRetry`; extend `recoverOnBoot` to call `redispatchQueuedTasks` |
