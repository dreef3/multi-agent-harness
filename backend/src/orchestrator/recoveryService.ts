import type Dockerode from "dockerode";
import { randomUUID } from "crypto";
import { getProject, updateProject, listExecutingProjects, updateTaskInPlan } from "../store/projects.js";
import { listAgentSessions, updateAgentSession, listStaleAgentSessions } from "../store/agents.js";
import { getContainerStatus } from "./containerManager.js";
import { TaskDispatcher } from "./taskDispatcher.js";
import { config } from "../config.js";
import type { Project, PlanTask } from "../models/types.js";
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
  // Global concurrency semaphore — limits total simultaneous sub-agent containers
  private slots: number = config.maxConcurrentSubAgents;
  private waiters: Array<() => void> = [];
  private projectSlots = new Map<string, { slots: number; waiters: Array<() => void> }>();

  constructor(private readonly docker: Dockerode) {
    this.dispatcher = new TaskDispatcher();
  }

  private acquireSlot(): Promise<void> {
    if (this.slots > 0) { this.slots--; activeAgents.add(1); return Promise.resolve(); }
    return new Promise((resolve) => {
      this.waiters.push(() => { activeAgents.add(1); resolve(); });
    });
  }

  private releaseSlot(): void {
    activeAgents.add(-1);
    const next = this.waiters.shift();
    if (next) { next(); } else { this.slots++; }
  }

  private acquireProjectSlot(projectId: string): Promise<void> {
    let entry = this.projectSlots.get(projectId);
    if (!entry) {
      entry = { slots: config.maxImplAgentsPerProject, waiters: [] };
      this.projectSlots.set(projectId, entry);
    }
    if (entry.slots > 0) {
      entry.slots--;
      activeAgentsPerProject.add(1, { "project.id": projectId });
      return Promise.resolve();
    }
    return new Promise(resolve => entry!.waiters.push(() => {
      activeAgentsPerProject.add(1, { "project.id": projectId });
      resolve();
    }));
  }

  private releaseProjectSlot(projectId: string): void {
    activeAgentsPerProject.add(-1, { "project.id": projectId });
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
    // Also recover executing projects that have no sessions at all
    // (e.g., dispatch missed due to server restart or empty task list)
    await this.recoverOrphanedExecutingProjects();
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
      console.log(`[recoveryService] Checking executing project ${project.id} (${project.name})`);
      const sessions = listAgentSessions(project.id).filter(
        s => s.type === "sub" && (s.status === "starting" || s.status === "running")
      );

      for (const session of sessions) {
        // Skip if not yet old enough to be considered stale
        const ageMs = now - new Date(session.updatedAt).getTime();
        console.log(`[recoveryService]   Checking session ${session.id} (status=${session.status}, age=${ageMs}ms)`);
        if (ageMs < thresholdMs) continue;

        // Skip if already being dispatched
        if (session.taskId && this.activeTaskIds.has(session.taskId)) continue;

        await this.recoverSession(session);
      }

      // If no active sessions at all, check for orphaned tasks/missing dispatch
      if (sessions.length === 0) {
        await this.recoverOrphanedProject(project);
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
    const pendingTasks = project.plan.tasks.filter(t => t.status === "pending");
    if (!pendingTasks.length) return;
    await Promise.all(
      pendingTasks.map(task => this.dispatchWithRetry(project, task))
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

    await this.acquireProjectSlot(project.id);

    await tracer.startActiveSpan("task.dispatch", async (span) => {
      span.setAttributes({
        "project.id": project.id,
        "task.id": task.id,
        "task.attempt": 1,
      });

      let localRetryCount = task.retryCount ?? 0;
      let lastError: string | undefined;
      const retrySessionId = randomUUID();
      let isFirstAttempt = true;

      try {
        while (localRetryCount <= config.subAgentMaxRetries) {
          span.setAttribute("task.attempt", localRetryCount + 1);
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
          // Acquire a concurrency slot before starting a container
          await this.acquireSlot();
          console.log(`[recoveryService] slot acquired for task ${task.id} (${config.maxConcurrentSubAgents - this.slots}/${config.maxConcurrentSubAgents} slots in use)`);
          let result: Awaited<ReturnType<typeof this.dispatcher.runTask>>;
          try {
            result = await this.dispatcher.runTask(
              this.docker, freshProject, taskForRun,
              isFirstAttempt ? undefined : retrySessionId,
            );
            isFirstAttempt = false;
          } catch (err) {
            isFirstAttempt = false;
            this.releaseSlot();
            throw err;
          }
          this.releaseSlot();
          console.log(`[recoveryService] slot released for task ${task.id}`);

          if (result.success) {
            updateTaskInPlan(project.id, task.id, { status: "completed" });
            console.log(`[recoveryService] task ${task.id} completed successfully`);
            taskCounter.add(1, { "project.id": project.id, status: "success" });
            span.setAttributes({ "task.status": "success" });
            await this.checkAllTerminal(project.id);
            return;
          }

          lastError = result.error;
          localRetryCount++;
          updateTaskInPlan(project.id, task.id, { status: "failed", retryCount: localRetryCount });
          console.warn(`[recoveryService] task ${task.id} attempt failed: ${result.error}. retryCount=${localRetryCount}`);
        }

        // All attempts exhausted
        console.error(`[recoveryService] task ${task.id} permanently failed after ${localRetryCount} attempt(s)`);
        updateTaskInPlan(project.id, task.id, {
          status: "failed",
          retryCount: localRetryCount,
          errorMessage: `Permanently failed after ${localRetryCount} attempt(s). Last error: ${lastError ?? "unknown"}`,
        });
        taskCounter.add(1, { "project.id": project.id, status: "failed" });
        span.setAttributes({ "task.status": "failed" });
        span.setStatus({ code: SpanStatusCode.ERROR, message: lastError });
        await this.notifyMasterPartialFailure(project.id, task, localRetryCount);
        await this.checkAllTerminal(project.id);
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        span.setAttributes({ "task.status": "error" });
        throw err;
      } finally {
        span.end();
        this.activeTaskIds.delete(task.id);
        this.releaseProjectSlot(project.id);
      }
    });
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
    if (failed.length) msg += `\nUse get_task_status to see error details, then dispatch_tasks to retry failed tasks or inform the user.`;

    await this.notifyMaster(projectId, msg);
  }

  private async notifyMasterPartialFailure(projectId: string, task: PlanTask, attempts: number): Promise<void> {
    const msg =
      `[SYSTEM] Task "${task.description.slice(0, 50)}" has permanently failed after ${attempts} attempt(s).\n` +
      `Error: ${task.errorMessage ?? "unknown"}.\n` +
      `Other tasks may still be running. Use get_task_status for details, then dispatch_tasks to retry or inform the user.`;
    await this.notifyMaster(projectId, msg);
  }

  private async notifyMaster(projectId: string, message: string): Promise<void> {
    try {
      const { getPlanningAgentManager } = await import("./planningAgentManager.js");
      await getPlanningAgentManager().sendPrompt(projectId, message);
    } catch (err) {
      console.error(`[recoveryService] Failed to notify planning agent for project ${projectId}:`, err);
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
      updateTaskInPlan(session.projectId, session.taskId, {
        status: "failed",
        retryCount: currentRetryCount,
        errorMessage: `Permanently failed after recovery (${currentRetryCount} attempt(s)). Container was stale.`,
      });
      this.activeTaskIds.delete(session.taskId);
      await this.notifyMasterPartialFailure(session.projectId, task, currentRetryCount);
      await this.checkAllTerminal(session.projectId);
    }
  }

  private async getContainerStatus(containerId: string): Promise<string> {
    return getContainerStatus(this.docker, containerId);
  }

  /**
   * Called when an executing project has no active sub-agent sessions.
   * Handles three cases:
   *   1. No tasks → notify master (plan was never structured)
   *   2. All tasks terminal → run checkAllTerminal to clean up project status
   *   3. Non-terminal tasks → re-dispatch them
   */
  private async recoverOrphanedProject(project: Project): Promise<void> {
    console.log(`[recoveryService] Checking orphaned project ${project.id}`);
    if (!project.plan?.tasks?.length) {
      console.warn(`[recoveryService] Project ${project.id} is stuck in "executing" with no tasks — reverting to "awaiting_plan_approval"`);
      updateProject(project.id, { status: "awaiting_plan_approval" });
      await this.notifyMaster(
        project.id,
        `[SYSTEM] This project was stuck in "executing" state with no tasks in its plan. ` +
        `Status has been reverted to "awaiting_plan_approval". ` +
        `Please ensure the plan has structured tasks before re-approving.`
      );
      return;
    }

    const terminal = new Set(["completed", "failed", "cancelled"]);
    const nonTerminal = project.plan.tasks.filter(t => !terminal.has(t.status));

    if (nonTerminal.length === 0) {
      console.log(`[recoveryService] Project ${project.id} has no non-terminal tasks, all are terminal`);
      // All tasks are already done — checkAllTerminal will update project status
      await this.checkAllTerminal(project.id);
      return;
    }

    // Non-terminal tasks with no active sessions — re-dispatch them
    console.log(
      `[recoveryService] Recovering orphaned executing project ${project.id}: ` +
      `${nonTerminal.length} non-terminal task(s), 0 active sessions`
    );

    for (const task of nonTerminal) {
      if (this.activeTaskIds.has(task.id)) continue; // already in-flight

      // Tasks stuck as "executing" with no session — reset to pending before dispatch
      if (task.status === "executing") {
        updateTaskInPlan(project.id, task.id, { status: "pending" });
      }

      // Read fresh task state after potential update
      const freshProject = getProject(project.id);
      const freshTask = freshProject?.plan?.tasks.find(t => t.id === task.id) ?? task;
      void this.dispatchWithRetry(freshProject ?? project, freshTask);
    }
  }

  private async recoverOrphanedExecutingProjects(): Promise<void> {
    const projects = listExecutingProjects();
    for (const project of projects) {
      const activeSessions = listAgentSessions(project.id).filter(
        s => s.type === "sub" && (s.status === "starting" || s.status === "running")
      );
      if (activeSessions.length > 0) continue; // sessions exist — handled elsewhere
      await this.recoverOrphanedProject(project);
    }
  }
}
