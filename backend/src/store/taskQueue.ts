import { getAdapter } from "./db.js";

const db = () => getAdapter();

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
  db()
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
    db()
      .prepare(
        `SELECT id, project_id AS projectId
         FROM task_queue
         WHERE status = 'queued'
         ORDER BY priority DESC, queued_at ASC
         LIMIT 1`
      )
      .get() as { id: string; projectId: string } | null
  ) ?? null;
}

/**
 * Mark a task as actively being dispatched (slot acquired, container starting).
 */
export function markTaskDispatching(taskId: string): void {
  db()
    .prepare(`UPDATE task_queue SET status = 'dispatching' WHERE id = ?`)
    .run(taskId);
}

/**
 * Remove a task from the queue entirely (call after task completes or fails permanently).
 */
export function removeFromQueue(taskId: string): void {
  db()
    .prepare(`DELETE FROM task_queue WHERE id = ?`)
    .run(taskId);
}

/**
 * List all tasks currently in 'queued' status, ordered by priority then age.
 */
export function listQueuedTasks(): QueuedTask[] {
  return db()
    .prepare(
      `SELECT id, project_id AS projectId, priority, queued_at AS queuedAt
       FROM task_queue
       WHERE status = 'queued'
       ORDER BY priority DESC, queued_at ASC`
    )
    .all() as unknown as QueuedTask[];
}

/**
 * List all tasks in the queue regardless of status (for diagnostics).
 */
export function listAllQueueEntries(): Array<QueuedTask & { status: string }> {
  return db()
    .prepare(
      `SELECT id, project_id AS projectId, priority, queued_at AS queuedAt, status
       FROM task_queue
       ORDER BY priority DESC, queued_at ASC`
    )
    .all() as unknown as Array<QueuedTask & { status: string }>;
}

/**
 * Reset 'dispatching' entries to 'queued' on boot recovery.
 * These were mid-dispatch when the server crashed; their containers are gone.
 */
export function resetStaleDispatchingEntries(): void {
  db()
    .prepare(`UPDATE task_queue SET status = 'queued' WHERE status = 'dispatching'`)
    .run();
}

/**
 * Remove queue entries for a list of task IDs that are known to be terminal.
 */
export function removeTerminalTasks(taskIds: string[]): void {
  if (taskIds.length === 0) return;
  const placeholders = taskIds.map(() => "?").join(", ");
  db()
    .prepare(`DELETE FROM task_queue WHERE id IN (${placeholders})`)
    .run(...taskIds);
}
