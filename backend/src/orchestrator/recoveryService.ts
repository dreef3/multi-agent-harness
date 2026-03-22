import type Dockerode from "dockerode";
import { getProject, updateProject, listExecutingProjects, updateTaskInPlan } from "../store/projects.js";
import { listAgentSessions, updateAgentSession, listStaleAgentSessions } from "../store/agents.js";
import { getContainerStatus } from "./containerManager.js";
import { TaskDispatcher } from "./taskDispatcher.js";
import { config } from "../config.js";
import type { Project, PlanTask } from "../models/types.js";

// ── Singleton accessor (same pattern as DebounceEngine) ──────────────────────

let instance: RecoveryService | null = null;

export function setRecoveryService(svc: RecoveryService): void {
  instance = svc;
}

export function getRecoveryService(): RecoveryService {
  if (!instance) throw new Error("[RecoveryService] not initialised — call setRecoveryService first");
  return instance;
}

// ── RecoveryService ───────────────────────────────────────────────────────────

export class RecoveryService {
  private activeTaskIds = new Set<string>(); // keyed by PlanTask.id
  private dispatcher: TaskDispatcher;

  constructor(private readonly docker: Dockerode) {
    this.dispatcher = new TaskDispatcher();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Called once from index.ts before startPolling.
   * Registers all stale task IDs synchronously (before any await) then recovers each.
   */
  async recoverOnBoot(): Promise<void> {
    const allSessions = listStaleAgentSessions();
    // Register all stale task IDs SYNCHRONOUSLY before any async work so that
    // the first poll cycle (fired immediately by startPolling) sees the guard populated.
    for (const s of allSessions) {
      if (s.taskId) this.activeTaskIds.add(s.taskId);
    }
    for (const session of allSessions) {
      await this.recoverSession(session);
    }
  }

  /**
   * Called from the polling loop each cycle.
   * Detects sessions stuck beyond staleSessionThresholdMs and recovers them.
   */
  async recoverExecutingProjects(): Promise<void> {
    const projects = listExecutingProjects();
    const thresholdMs = config.staleSessionThresholdMs;
    const now = Date.now();

    for (const project of projects) {
      if (!project.plan) continue;
      const sessions = listAgentSessions(project.id).filter(
        s => s.type === "sub" && (s.status === "starting" || s.status === "running")
      );

      for (const session of sessions) {
        // Skip if not yet old enough to be considered stale
        const ageMs = now - new Date(session.updatedAt).getTime();
        if (ageMs < thresholdMs) continue;

        // Skip if already being dispatched
        if (session.taskId && this.activeTaskIds.has(session.taskId)) continue;

        await this.recoverSession(session);
      }
    }
  }

  /**
   * Dispatches all plan tasks for a project (called from polling.ts on LGTM approval).
   * Replaces the old TaskDispatcher.dispatchTasks() call in pollPlanningPrs.
   */
  async dispatchTasksForProject(projectId: string): Promise<void> {
    const project = getProject(projectId);
    if (!project?.plan?.tasks?.length) return;
    await Promise.all(
      project.plan.tasks.map(task => this.dispatchWithRetry(project, task))
    );
  }

  /**
   * Re-queues all permanently-failed tasks for the project.
   * Called by the restart_failed_tasks master-agent tool.
   */
  async dispatchFailedTasks(projectId: string): Promise<{ count: number }> {
    const project = getProject(projectId);
    if (!project?.plan) return { count: 0 };

    const failed = project.plan.tasks.filter(t => t.status === "failed");
    let count = 0;

    for (const task of failed) {
      if (this.activeTaskIds.has(task.id)) continue; // already in-flight
      updateTaskInPlan(projectId, task.id, { status: "pending", retryCount: 0 });
      count++;
    }

    if (count > 0) {
      updateProject(projectId, { status: "executing" });
      const freshProject = getProject(projectId)!;
      for (const task of freshProject.plan!.tasks.filter(t => t.status === "pending")) {
        void this.dispatchWithRetry(freshProject, task); // fire-and-forget
      }
    }

    return { count };
  }

  // ── Core retry loop ─────────────────────────────────────────────────────────

  /**
   * Run a single task with automatic retry up to config.subAgentMaxRetries times.
   * Notifies the master agent on permanent failure or overall completion.
   */
  async dispatchWithRetry(project: Project, task: PlanTask): Promise<void> {
    if (this.activeTaskIds.has(task.id)) return; // concurrency guard
    this.activeTaskIds.add(task.id);

    let localRetryCount = task.retryCount ?? 0;

    try {
      while (localRetryCount <= config.subAgentMaxRetries) {
        const isRetry = localRetryCount > 0;
        updateTaskInPlan(project.id, task.id, { status: "executing", retryCount: localRetryCount });
        console.log(`[recoveryService] task ${task.id} attempt ${localRetryCount + 1}/${config.subAgentMaxRetries + 1}`);

        // On retry, inject a resume note into the task description
        const taskForRun = isRetry
          ? {
              ...task,
              description: `Note: this is retry attempt ${localRetryCount}. The branch for this task may contain partial work from a previous attempt — start from its current remote state.\n\n${task.description}`,
            }
          : task;

        const freshProject = getProject(project.id)!;
        const result = await this.dispatcher.runTask(this.docker, freshProject, taskForRun);

        if (result.success) {
          updateTaskInPlan(project.id, task.id, { status: "completed" });
          console.log(`[recoveryService] task ${task.id} completed successfully`);
          await this.checkAllTerminal(project.id);
          return;
        }

        localRetryCount++;
        updateTaskInPlan(project.id, task.id, { status: "failed", retryCount: localRetryCount });
        console.warn(`[recoveryService] task ${task.id} attempt failed: ${result.error}. retryCount=${localRetryCount}`);
      }

      // All attempts exhausted
      console.error(`[recoveryService] task ${task.id} permanently failed after ${localRetryCount} attempt(s)`);
      await this.notifyMasterPartialFailure(project.id, task, localRetryCount);
      await this.checkAllTerminal(project.id);
    } finally {
      this.activeTaskIds.delete(task.id);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Checks whether all tasks in the project plan have reached a terminal status.
   * If so, updates project status and notifies the master agent.
   */
  private async checkAllTerminal(projectId: string): Promise<void> {
    const project = getProject(projectId);
    if (!project?.plan) return;

    const terminal = new Set(["completed", "failed", "cancelled"]);
    const allDone = project.plan.tasks.every(t => terminal.has(t.status));
    if (!allDone) return;

    const anyFailed = project.plan.tasks.some(t => t.status === "failed");
    const newStatus = anyFailed ? "failed" : "completed";
    updateProject(projectId, { status: newStatus });

    const succeeded = project.plan.tasks.filter(t => t.status === "completed").map(t => t.description.slice(0, 40));
    const failed = project.plan.tasks.filter(t => t.status === "failed").map(t => t.description.slice(0, 40));

    let msg = `[SYSTEM] Sub-agent execution complete.\n`;
    if (succeeded.length) msg += `Succeeded: ${succeeded.join(", ")}\n`;
    if (failed.length) msg += `Failed (retries exhausted): ${failed.join(", ")}\n`;
    if (failed.length) msg += `\nUse restart_failed_tasks to retry failed tasks, or inform the user.`;

    await this.notifyMaster(projectId, msg);
  }

  private async notifyMasterPartialFailure(projectId: string, task: PlanTask, attempts: number): Promise<void> {
    const msg =
      `[SYSTEM] Task "${task.description.slice(0, 50)}" has permanently failed after ${attempts} attempt(s).\n` +
      `Other tasks may still be running. Use restart_failed_tasks when ready, ` +
      `or wait for the remaining tasks to finish first.`;
    await this.notifyMaster(projectId, msg);
  }

  private async notifyMaster(projectId: string, message: string): Promise<void> {
    try {
      const { getOrInitAgent } = await import("../api/websocket.js");
      const agent = await getOrInitAgent(projectId);
      await agent.prompt(message);
    } catch (err) {
      console.error(`[recoveryService] Failed to notify master for project ${projectId}:`, err);
    }
  }

  /**
   * Recover a single stale session: mark failed, retry or notify.
   */
  private async recoverSession(session: { id: string; projectId: string; taskId?: string; containerId?: string; status: string }): Promise<void> {
    if (!session.taskId) return;

    // Check if container is actually still running (not stale)
    if (session.containerId) {
      const containerStatus = await this.getContainerStatus(session.containerId);
      if (containerStatus === "running") return; // genuinely running — skip
    }

    console.log(`[recoveryService] Stale session detected: ${session.id} for task ${session.taskId}`);

    // Mark session failed
    try {
      updateAgentSession(session.id, { status: "failed" });
    } catch {
      // Session may not exist in DB; ignore
    }

    const project = getProject(session.projectId);
    if (!project?.plan) return;

    const task = project.plan.tasks.find(t => t.id === session.taskId);
    if (!task) return;

    const currentRetryCount = (task.retryCount ?? 0) + 1;
    updateTaskInPlan(session.projectId, session.taskId, { status: "failed", retryCount: currentRetryCount });

    if (currentRetryCount <= config.subAgentMaxRetries) {
      console.log(`[recoveryService] Re-dispatching task ${session.taskId} (retry ${currentRetryCount})`);
      const freshTask = { ...task, retryCount: currentRetryCount };
      void this.dispatchWithRetry(project, freshTask); // fire-and-forget
    } else {
      console.error(`[recoveryService] Task ${session.taskId} exhausted retries during recovery`);
      this.activeTaskIds.delete(session.taskId);
      await this.notifyMasterPartialFailure(session.projectId, task, currentRetryCount);
      await this.checkAllTerminal(session.projectId);
    }
  }

  private async getContainerStatus(containerId: string): Promise<string> {
    return getContainerStatus(this.docker, containerId);
  }
}
