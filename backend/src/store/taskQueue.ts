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
export async function enqueueTask(taskId: string, projectId: string, priority = 0): Promise<void> {
  await db().execute(
    `INSERT OR IGNORE INTO task_queue (id, project_id, queued_at, priority, status)
     VALUES (?, ?, ?, ?, 'queued')`,
    [taskId, projectId, new Date().toISOString(), priority]
  );
}

/**
 * Return the next task to dispatch (highest priority, then oldest queued_at).
 * Returns null if the queue is empty.
 */
export async function dequeueNextTask(): Promise<{ id: string; projectId: string } | null> {
  const rows = await db().query<{ id: string; projectId: string }>(
    `SELECT id, project_id AS projectId
     FROM task_queue
     WHERE status = 'queued'
     ORDER BY priority DESC, queued_at ASC
     LIMIT 1`
  );
  return rows[0] ?? null;
}

/**
 * Mark a task as actively being dispatched (slot acquired, container starting).
 */
export async function markTaskDispatching(taskId: string): Promise<void> {
  await db().execute(`UPDATE task_queue SET status = 'dispatching' WHERE id = ?`, [taskId]);
}

/**
 * Remove a task from the queue entirely (call after task completes or fails permanently).
 */
export async function removeFromQueue(taskId: string): Promise<void> {
  await db().execute(`DELETE FROM task_queue WHERE id = ?`, [taskId]);
}

/**
 * List all tasks currently in 'queued' status, ordered by priority then age.
 */
export async function listQueuedTasks(): Promise<QueuedTask[]> {
  return db().query<QueuedTask>(
    `SELECT id, project_id AS projectId, priority, queued_at AS queuedAt
     FROM task_queue
     WHERE status = 'queued'
     ORDER BY priority DESC, queued_at ASC`
  );
}

/**
 * List all tasks in the queue regardless of status (for diagnostics).
 */
export async function listAllQueueEntries(): Promise<Array<QueuedTask & { status: string }>> {
  return db().query<QueuedTask & { status: string }>(
    `SELECT id, project_id AS projectId, priority, queued_at AS queuedAt, status
     FROM task_queue
     ORDER BY priority DESC, queued_at ASC`
  );
}

/**
 * Reset 'dispatching' entries to 'queued' on boot recovery.
 * These were mid-dispatch when the server crashed; their containers are gone.
 */
export async function resetStaleDispatchingEntries(): Promise<void> {
  await db().execute(`UPDATE task_queue SET status = 'queued' WHERE status = 'dispatching'`);
}

/**
 * Remove queue entries for a list of task IDs that are known to be terminal.
 */
export async function removeTerminalTasks(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  const placeholders = taskIds.map(() => "?").join(", ");
  await db().execute(`DELETE FROM task_queue WHERE id IN (${placeholders})`, taskIds);
}
