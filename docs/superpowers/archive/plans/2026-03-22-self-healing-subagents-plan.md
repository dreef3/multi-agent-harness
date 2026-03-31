# Self-Healing Subagent System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic retry, stale-session recovery, and master-agent notification so failed sub-agent tasks heal themselves without manual intervention.

**Architecture:** A new `RecoveryService` singleton owns all healing logic — it wraps `TaskDispatcher.runTask` with a retry loop, scans for stale sessions at boot and each poll cycle, and notifies the master agent via `getOrInitAgent(...).prompt(...)` when tasks permanently fail or complete. A new `restart_failed_tasks` master-agent tool lets the master re-dispatch all failed tasks on demand.

**Tech Stack:** TypeScript, Node.js, better-sqlite3 (synchronous SQLite), Dockerode, vitest

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `backend/src/orchestrator/recoveryService.ts` | **Create** | Core singleton: dispatchWithRetry, recoverOnBoot, recoverExecutingProjects, dispatchFailedTasks, dispatchTasksForProject, checkAllTerminal |
| `backend/src/agents/restartFailedTasksTool.ts` | **Create** | Master-agent tool factory; calls getRecoveryService().dispatchFailedTasks |
| `backend/src/models/types.ts` | **Modify** | Add `retryCount?: number` to PlanTask |
| `backend/src/store/projects.ts` | **Modify** | Add `updateTaskInPlan` (transactional) and `listExecutingProjects` helpers |
| `backend/src/config.ts` | **Modify** | Change `subAgentMaxRetries` default 3→1; add `staleSessionThresholdMs` |
| `backend/src/index.ts` | **Modify** | Init RecoveryService, await recoverOnBoot before startPolling |
| `backend/src/polling.ts` | **Modify** | Replace dispatchTasks call with dispatchTasksForProject; add recoverExecutingProjects per cycle |
| `backend/src/api/websocket.ts` | **Modify** | Add restart_failed_tasks tool to getOrInitAgent tool list |
| `backend/src/orchestrator/taskDispatcher.ts` | **Modify** | Make `runTask` public |
| `backend/src/__tests__/recoveryService.test.ts` | **Create** | Unit tests for all RecoveryService paths |

**Note on connectors:** Both `github.ts` and `bitbucket.ts` already handle duplicate-branch errors gracefully — no changes needed there.

---

## Task 1: Data model + store helpers

**Files:**
- Modify: `backend/src/models/types.ts`
- Modify: `backend/src/store/projects.ts`
- Modify: `backend/src/config.ts`
- Test: `backend/src/__tests__/store.test.ts`

- [ ] **Step 1: Add `retryCount` to PlanTask in types.ts**

In `backend/src/models/types.ts`, add one field to `PlanTask`:

```typescript
export interface PlanTask {
  id: string;
  repositoryId: string;
  description: string;
  status: "pending" | "executing" | "completed" | "failed" | "cancelled";
  dependsOn?: string[];
  retryCount?: number;  // failed attempts consumed (undefined = 0)
}
```

- [ ] **Step 2: Add `updateTaskInPlan` to store/projects.ts**

Add after `updateProject` in `backend/src/store/projects.ts`:

```typescript
import type { PlanTask } from "../models/types.js";

export function updateTaskInPlan(
  projectId: string,
  taskId: string,
  updates: Partial<PlanTask>
): void {
  const db = getDb();
  db.transaction(() => {
    const row = db.prepare("SELECT plan_json FROM projects WHERE id = ?").get(projectId) as { plan_json: string | null } | undefined;
    if (!row?.plan_json) return;
    const plan = JSON.parse(row.plan_json) as import("../models/types.js").Plan;
    const task = plan.tasks.find(t => t.id === taskId);
    if (task) Object.assign(task, updates);
    db.prepare("UPDATE projects SET plan_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(plan), new Date().toISOString(), projectId);
  })();
}
```

- [ ] **Step 3: Add `listExecutingProjects` to store/projects.ts**

Add after `listProjectsAwaitingLgtm`:

```typescript
export function listExecutingProjects(): Project[] {
  return (getDb().prepare(
    "SELECT * FROM projects WHERE status = 'executing'"
  ).all() as ProjectRow[]).map(fromRow);
}
```

- [ ] **Step 4: Update config.ts**

In `backend/src/config.ts`, change:
```typescript
subAgentMaxRetries: parseInt(process.env.SUB_AGENT_MAX_RETRIES ?? "3", 10),
```
to:
```typescript
subAgentMaxRetries: parseInt(process.env.SUB_AGENT_MAX_RETRIES ?? "1", 10),
```

Add after `subAgentIdleTimeoutMs`:
```typescript
// Must exceed subAgentTimeoutMs (default 30 min). Use literal — config object
// cannot reference its own properties during construction.
staleSessionThresholdMs: parseInt(
  process.env.STALE_SESSION_THRESHOLD_MS ?? String(35 * 60 * 1000),
  10
),
```

- [ ] **Step 5: Write failing tests for updateTaskInPlan**

Add to `backend/src/__tests__/store.test.ts`:

```typescript
import { insertProject, getProject, updateTaskInPlan } from "../store/projects.js";
import type { Project } from "../models/types.js";

function makeProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: "proj-1",
    name: "Test Project",
    status: "executing",
    source: { type: "freeform", freeformDescription: "test" },
    repositoryIds: ["repo-1"],
    masterSessionPath: "",
    createdAt: now,
    updatedAt: now,
    plan: {
      id: "plan-1",
      projectId: "proj-1",
      content: "# Plan",
      tasks: [
        { id: "task-1", repositoryId: "repo-1", description: "Do A", status: "pending" },
        { id: "task-2", repositoryId: "repo-1", description: "Do B", status: "pending" },
      ],
    },
    ...overrides,
  };
}

describe("updateTaskInPlan", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
    initDb(tmpDir);
    insertProject(makeProject());
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("updates the target task without touching sibling tasks", () => {
    updateTaskInPlan("proj-1", "task-1", { status: "executing", retryCount: 0 });
    const project = getProject("proj-1")!;
    const t1 = project.plan!.tasks.find(t => t.id === "task-1")!;
    const t2 = project.plan!.tasks.find(t => t.id === "task-2")!;
    expect(t1.status).toBe("executing");
    expect(t1.retryCount).toBe(0);
    expect(t2.status).toBe("pending"); // unchanged
  });

  it("does nothing when project has no plan", () => {
    const proj2: Project = { ...makeProject(), id: "proj-2", plan: undefined };
    insertProject(proj2);
    expect(() => updateTaskInPlan("proj-2", "task-1", { status: "completed" })).not.toThrow();
  });

  it("does nothing when taskId is not found", () => {
    expect(() => updateTaskInPlan("proj-1", "nonexistent", { status: "completed" })).not.toThrow();
    const project = getProject("proj-1")!;
    expect(project.plan!.tasks[0].status).toBe("pending"); // unchanged
  });
});
```

- [ ] **Step 6: Run tests — expect failure**

```bash
cd backend && npx vitest run src/__tests__/store.test.ts 2>&1 | tail -20
```
Expected: tests fail because `updateTaskInPlan` doesn't exist yet in the module import.

- [ ] **Step 7: Run tests — expect pass**

```bash
cd backend && npx vitest run src/__tests__/store.test.ts 2>&1 | tail -20
```
Expected: all tests in the file pass.

- [ ] **Step 8: Make `runTask` public in taskDispatcher.ts**

In `backend/src/orchestrator/taskDispatcher.ts`, change line 132:
```typescript
private async runTask(
```
to:
```typescript
public async runTask(
```

- [ ] **Step 9: Commit**

```bash
cd backend && npx tsc --noEmit
git add backend/src/models/types.ts backend/src/store/projects.ts backend/src/config.ts backend/src/orchestrator/taskDispatcher.ts backend/src/__tests__/store.test.ts
git commit -m "feat: add PlanTask.retryCount, updateTaskInPlan, staleSessionThresholdMs; make runTask public"
```

---

## Task 2: RecoveryService — core + tests

**Files:**
- Create: `backend/src/orchestrator/recoveryService.ts`
- Create: `backend/src/__tests__/recoveryService.test.ts`

- [ ] **Step 1: Write failing tests first**

Create `backend/src/__tests__/recoveryService.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { initDb } from "../store/db.js";
import { insertProject, getProject } from "../store/projects.js";
import { insertAgentSession, getAgentSession } from "../store/agents.js";
import type { Project, AgentSession } from "../models/types.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeProject(id: string, status: Project["status"] = "executing"): Project {
  const now = new Date().toISOString();
  return {
    id,
    name: "Test",
    status,
    source: { type: "freeform", freeformDescription: "" },
    repositoryIds: ["repo-1"],
    primaryRepositoryId: "repo-1",
    masterSessionPath: "",
    createdAt: now,
    updatedAt: now,
    plan: {
      id: `plan-${id}`,
      projectId: id,
      content: "",
      tasks: [
        { id: "task-1", repositoryId: "repo-1", description: "Do A", status: "pending" },
      ],
    },
  };
}

function makeSession(id: string, projectId: string, status: AgentSession["status"], taskId = "task-1", minsAgo = 40): AgentSession {
  const updatedAt = new Date(Date.now() - minsAgo * 60 * 1000).toISOString();
  return {
    id,
    projectId,
    type: "sub",
    repositoryId: "repo-1",
    taskId,
    containerId: "container-abc",
    status,
    createdAt: updatedAt,
    updatedAt,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("RecoveryService", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-recovery-test-"));
    initDb(tmpDir);
    vi.resetAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("dispatchWithRetry", () => {
    it("succeeds on first attempt — marks task completed and clears activeTaskIds", async () => {
      insertProject(makeProject("proj-1"));
      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const mockDocker = {} as never;
      const mockRunTask = vi.fn().mockResolvedValue({ taskId: "task-1", success: true });
      const mockNotify = vi.fn().mockResolvedValue(undefined);
      const svc = new RecoveryService(mockDocker);
      // @ts-expect-error accessing private for test
      svc.dispatcher.runTask = mockRunTask;
      // @ts-expect-error accessing private for test
      svc.notifyMaster = mockNotify;

      const project = getProject("proj-1")!;
      await svc.dispatchWithRetry(project, project.plan!.tasks[0]);

      expect(mockRunTask).toHaveBeenCalledTimes(1);
      const updated = getProject("proj-1")!;
      expect(updated.plan!.tasks[0].status).toBe("completed");
      // @ts-expect-error accessing private for test
      expect(svc.activeTaskIds.has("task-1")).toBe(false);
    });

    it("retries once on failure — succeeds on second attempt", async () => {
      insertProject(makeProject("proj-2"));
      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const mockDocker = {} as never;
      const mockRunTask = vi.fn()
        .mockResolvedValueOnce({ taskId: "task-1", success: false, error: "crash" })
        .mockResolvedValueOnce({ taskId: "task-1", success: true });
      const mockNotify = vi.fn().mockResolvedValue(undefined);
      const svc = new RecoveryService(mockDocker);
      // @ts-expect-error accessing private for test
      svc.dispatcher.runTask = mockRunTask;
      // @ts-expect-error accessing private for test
      svc.notifyMaster = mockNotify;

      const project = getProject("proj-2")!;
      await svc.dispatchWithRetry(project, project.plan!.tasks[0]);

      expect(mockRunTask).toHaveBeenCalledTimes(2);
      expect(getProject("proj-2")!.plan!.tasks[0].status).toBe("completed");
      expect(mockNotify).not.toHaveBeenCalled(); // succeeded on retry — no failure notification
    });

    it("permanently fails after all retries — notifies master and clears activeTaskIds", async () => {
      insertProject(makeProject("proj-3"));
      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const mockDocker = {} as never;
      const mockRunTask = vi.fn().mockResolvedValue({ taskId: "task-1", success: false, error: "crash" });
      const mockNotify = vi.fn().mockResolvedValue(undefined);
      const svc = new RecoveryService(mockDocker);
      // @ts-expect-error accessing private for test
      svc.dispatcher.runTask = mockRunTask;
      // @ts-expect-error accessing private for test
      svc.notifyMaster = mockNotify;

      const project = getProject("proj-3")!;
      await svc.dispatchWithRetry(project, project.plan!.tasks[0]);

      // subAgentMaxRetries = 1 → 2 total attempts
      expect(mockRunTask).toHaveBeenCalledTimes(2);
      expect(getProject("proj-3")!.plan!.tasks[0].status).toBe("failed");
      expect(mockNotify).toHaveBeenCalled();
      // @ts-expect-error accessing private for test
      expect(svc.activeTaskIds.has("task-1")).toBe(false);
    });

    it("skips if task already in activeTaskIds", async () => {
      insertProject(makeProject("proj-4"));
      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const mockRunTask = vi.fn().mockResolvedValue({ taskId: "task-1", success: true });
      const svc = new RecoveryService({} as never);
      // @ts-expect-error accessing private for test
      svc.dispatcher.runTask = mockRunTask;
      // @ts-expect-error accessing private for test
      svc.activeTaskIds.add("task-1");

      const project = getProject("proj-4")!;
      await svc.dispatchWithRetry(project, project.plan!.tasks[0]);

      expect(mockRunTask).not.toHaveBeenCalled();
    });
  });

  describe("checkAllTerminal", () => {
    it("updates project to completed when all tasks succeeded", async () => {
      const proj = makeProject("proj-5");
      proj.plan!.tasks[0].status = "completed";
      insertProject(proj);
      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const mockNotify = vi.fn().mockResolvedValue(undefined);
      const svc = new RecoveryService({} as never);
      // @ts-expect-error accessing private for test
      svc.notifyMaster = mockNotify;
      // @ts-expect-error accessing private for test
      await svc.checkAllTerminal("proj-5");
      expect(getProject("proj-5")!.status).toBe("completed");
      expect(mockNotify).toHaveBeenCalledWith("proj-5", expect.stringContaining("complete"));
    });

    it("does not fire if some tasks are still executing", async () => {
      const proj = makeProject("proj-6");
      proj.plan!.tasks = [
        { id: "task-1", repositoryId: "repo-1", description: "", status: "completed" },
        { id: "task-2", repositoryId: "repo-1", description: "", status: "executing" },
      ];
      insertProject(proj);
      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const mockNotify = vi.fn().mockResolvedValue(undefined);
      const svc = new RecoveryService({} as never);
      // @ts-expect-error accessing private for test
      svc.notifyMaster = mockNotify;
      // @ts-expect-error accessing private for test
      await svc.checkAllTerminal("proj-6");
      expect(getProject("proj-6")!.status).toBe("executing"); // unchanged
      expect(mockNotify).not.toHaveBeenCalled();
    });
  });

  describe("dispatchFailedTasks", () => {
    it("re-queues failed tasks, skips in-flight ones, updates project to executing", async () => {
      const proj = makeProject("proj-7");
      proj.plan!.tasks[0].status = "failed";
      proj.plan!.tasks[0].retryCount = 2;
      insertProject(proj);

      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const svc = new RecoveryService({} as never);
      const dispatchSpy = vi.spyOn(svc, "dispatchWithRetry").mockResolvedValue(undefined);

      await svc.dispatchFailedTasks("proj-7");

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      // retryCount reset to 0
      expect(getProject("proj-7")!.plan!.tasks[0].retryCount).toBe(0);
      expect(getProject("proj-7")!.plan!.tasks[0].status).toBe("pending");
      expect(getProject("proj-7")!.status).toBe("executing");
    });

    it("skips tasks already in activeTaskIds", async () => {
      const proj = makeProject("proj-8");
      proj.plan!.tasks[0].status = "failed";
      insertProject(proj);

      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const svc = new RecoveryService({} as never);
      // @ts-expect-error accessing private for test
      svc.activeTaskIds.add("task-1");
      const dispatchSpy = vi.spyOn(svc, "dispatchWithRetry").mockResolvedValue(undefined);

      await svc.dispatchFailedTasks("proj-8");

      expect(dispatchSpy).not.toHaveBeenCalled();
    });
  });

  describe("recoverOnBoot", () => {
    it("registers taskIds synchronously before async container checks", async () => {
      insertProject(makeProject("proj-9"));
      insertAgentSession(makeSession("sess-1", "proj-9", "running"));

      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const mockGetContainerStatus = vi.fn().mockResolvedValue("exited");
      const mockDispatch = vi.fn().mockResolvedValue(undefined);

      const svc = new RecoveryService({} as never);
      // @ts-expect-error accessing private for test
      svc.getContainerStatus = mockGetContainerStatus;
      // @ts-expect-error accessing private for test
      svc.dispatcher.runTask = vi.fn().mockResolvedValue({ taskId: "task-1", success: true });

      let observedActiveIds: Set<string> | null = null;
      mockGetContainerStatus.mockImplementationOnce(async () => {
        // @ts-expect-error accessing private for test
        observedActiveIds = new Set(svc.activeTaskIds);
        return "exited";
      });

      vi.spyOn(svc, "dispatchWithRetry").mockImplementation(async () => {
        mockDispatch();
      });

      await svc.recoverOnBoot();

      expect(observedActiveIds).not.toBeNull();
      expect(observedActiveIds!.has("task-1")).toBe(true); // populated before first await
    });
  });

  describe("recoverExecutingProjects", () => {
    it("skips tasks in activeTaskIds (concurrency guard)", async () => {
      insertProject(makeProject("proj-10"));
      insertAgentSession(makeSession("sess-2", "proj-10", "running", "task-1", 40));

      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const svc = new RecoveryService({} as never);
      // @ts-expect-error accessing private for test
      svc.activeTaskIds.add("task-1");
      const mockGetContainerStatus = vi.fn().mockResolvedValue("exited");
      // @ts-expect-error accessing private for test
      svc.getContainerStatus = mockGetContainerStatus;

      await svc.recoverExecutingProjects();

      expect(mockGetContainerStatus).not.toHaveBeenCalled(); // guard fired before container check
    });

    it("does not flag sessions updated within staleSessionThresholdMs", async () => {
      insertProject(makeProject("proj-11"));
      // 5 minutes ago — well within 35-min threshold
      insertAgentSession(makeSession("sess-3", "proj-11", "running", "task-1", 5));

      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const svc = new RecoveryService({} as never);
      const mockGetContainerStatus = vi.fn().mockResolvedValue("exited");
      // @ts-expect-error accessing private for test
      svc.getContainerStatus = mockGetContainerStatus;

      await svc.recoverExecutingProjects();

      expect(mockGetContainerStatus).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
cd backend && npx vitest run src/__tests__/recoveryService.test.ts 2>&1 | tail -10
```
Expected: fails — `recoveryService.js` does not exist yet.

- [ ] **Step 3: Create RecoveryService**

Create `backend/src/orchestrator/recoveryService.ts`:

```typescript
import type Dockerode from "dockerode";
import { getProject, updateProject, listExecutingProjects, updateTaskInPlan } from "../store/projects.js";
import { listAgentSessions, updateAgentSession } from "../store/agents.js";
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
    const allSessions = this.queryStaleSessionsFromDb();
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
        // Derive branch name (same logic as taskDispatcher.ts — must stay deterministic)
        const freshProject2 = getProject(project.id)!;
        const repo = freshProject2.repositoryIds[0]; // placeholder; actual branch name is computed inside runTask
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
  private async recoverSession(session: import("../store/agents.js").AgentSession extends never ? never : Awaited<ReturnType<typeof import("../store/agents.js").getAgentSession>>): Promise<void>;
  private async recoverSession(session: { id: string; projectId: string; taskId?: string; containerId?: string; status: string }): Promise<void> {
    if (!session.taskId) return;

    // Check if container is actually still running (not stale)
    if (session.containerId) {
      const containerStatus = await getContainerStatus(this.docker, session.containerId);
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

  private queryStaleSessionsFromDb() {
    return listAgentSessions("").filter(() => false); // placeholder — real impl below
  }
}
```

> **Note:** The `queryStaleSessionsFromDb` placeholder above is intentional — replace it in the next step with the real cross-project query.

- [ ] **Step 4: Fix queryStaleSessionsFromDb — add `listStaleAgentSessions` to store/agents.ts**

Add to `backend/src/store/agents.ts`:

```typescript
export function listStaleAgentSessions(): AgentSession[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_sessions WHERE status IN ('starting', 'running')")
    .all() as AgentSessionRow[];
  return rows.map(fromRow);
}
```

Update the import at the top of `recoveryService.ts` to include `listStaleAgentSessions`:

```typescript
import { listAgentSessions, updateAgentSession, listStaleAgentSessions } from "../store/agents.js";
```

Replace the placeholder `queryStaleSessionsFromDb` with:

```typescript
private queryStaleSessionsFromDb() {
  return listStaleAgentSessions();
}
```

Also simplify the `recoverSession` signature — remove the overload and use a single signature:

```typescript
private async recoverSession(session: { id: string; projectId: string; taskId?: string; containerId?: string; status: string }): Promise<void> {
```

- [ ] **Step 5: Run tests — expect pass**

```bash
cd backend && npx vitest run src/__tests__/recoveryService.test.ts 2>&1 | tail -20
```
Expected: all tests pass.

- [ ] **Step 6: Run full test suite — no regressions**

```bash
cd backend && npx vitest run 2>&1 | tail -20
```
Expected: all existing tests still pass.

- [ ] **Step 7: Commit**

```bash
cd backend && npx tsc --noEmit
git add backend/src/orchestrator/recoveryService.ts backend/src/store/agents.ts backend/src/__tests__/recoveryService.test.ts
git commit -m "feat: add RecoveryService with retry loop, stale-session recovery, master notification"
```

---

## Task 3: `restart_failed_tasks` master-agent tool

**Files:**
- Create: `backend/src/agents/restartFailedTasksTool.ts`
- Modify: `backend/src/api/websocket.ts`

- [ ] **Step 1: Write failing test**

Add to `backend/src/__tests__/recoveryService.test.ts` (or a new file `restartFailedTasksTool.test.ts`):

```typescript
describe("createRestartFailedTasksTool", () => {
  it("calls dispatchFailedTasks and returns count message", async () => {
    const { createRestartFailedTasksTool } = await import("../agents/restartFailedTasksTool.js");
    const { setRecoveryService, RecoveryService } = await import("../orchestrator/recoveryService.js");

    insertProject(makeProject("proj-tool"));
    const svc = new RecoveryService({} as never);
    vi.spyOn(svc, "dispatchFailedTasks").mockResolvedValue({ count: 3 });
    setRecoveryService(svc);

    const tool = createRestartFailedTasksTool("proj-tool");
    const result = await tool.execute("call-id", {});
    expect(result.content[0].text).toContain("3");
    expect(svc.dispatchFailedTasks).toHaveBeenCalledWith("proj-tool");
  });
});
```

- [ ] **Step 2: Run test — confirm failure**

```bash
cd backend && npx vitest run src/__tests__/recoveryService.test.ts 2>&1 | tail -10
```
Expected: fails — module does not exist.

- [ ] **Step 3: Create restartFailedTasksTool.ts**

Create `backend/src/agents/restartFailedTasksTool.ts`:

```typescript
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { getRecoveryService } from "../orchestrator/recoveryService.js";

const RestartFailedTasksParams = Type.Object({});

export function createRestartFailedTasksTool(projectId: string): ToolDefinition<typeof RestartFailedTasksParams> {
  return {
    name: "restart_failed_tasks",
    label: "Restart Failed Tasks",
    description:
      "Re-dispatches all permanently failed tasks for this project. Resets retry counts so each task gets fresh attempts. Use this when sub-agent tasks have failed and the user wants to try again.",
    parameters: RestartFailedTasksParams,
    async execute(_toolCallId, _args) {
      const result = await getRecoveryService().dispatchFailedTasks(projectId);
      const text = result.count > 0
        ? `Re-queued ${result.count} failed task(s). Sub-agents are retrying now.`
        : `No failed tasks to re-queue (tasks may already be running or completed).`;
      console.log(`[restartFailedTasksTool:${projectId}] ${text}`);
      return {
        content: [{ type: "text", text }],
        details: {},
      } satisfies AgentToolResult<unknown>;
    },
  };
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
cd backend && npx vitest run src/__tests__/recoveryService.test.ts 2>&1 | tail -10
```
Expected: all tests pass.

- [ ] **Step 5: Wire tool into websocket.ts — inside `getOrInitAgent`**

In `backend/src/api/websocket.ts`, add the import:

```typescript
import { createRestartFailedTasksTool } from "../agents/restartFailedTasksTool.js";
```

Inside `getOrInitAgent`, after the existing tool definitions, add `restartTool`:

```typescript
const planningTool = createWritePlanningDocumentTool(projectId, globalDataDir);
const statusTool = createSubAgentStatusTool(projectId);
const restartTool = createRestartFailedTasksTool(projectId);
const agent = new MasterAgent(projectId, sessionPath, [
  planningTool as unknown as ToolDefinition,
  statusTool as unknown as ToolDefinition,
  restartTool as unknown as ToolDefinition,
]);
```

- [ ] **Step 6: Run full test suite — no regressions**

```bash
cd backend && npx vitest run 2>&1 | tail -10
```

- [ ] **Step 7: Commit**

```bash
cd backend && npx tsc --noEmit
git add backend/src/agents/restartFailedTasksTool.ts backend/src/api/websocket.ts backend/src/__tests__/recoveryService.test.ts
git commit -m "feat: add restart_failed_tasks master-agent tool, wire into getOrInitAgent"
```

---

## Task 4: Wire RecoveryService into index.ts and polling.ts

**Files:**
- Modify: `backend/src/index.ts`
- Modify: `backend/src/polling.ts`

- [ ] **Step 1: Update index.ts**

In `backend/src/index.ts`, add the import:

```typescript
import { RecoveryService, setRecoveryService } from "./orchestrator/recoveryService.js";
```

In `main()`, replace the existing `startPolling(docker)` call with:

```typescript
console.log("[startup] Initializing recovery service...");
const recoveryService = new RecoveryService(docker);
setRecoveryService(recoveryService);

console.log("[startup] Running boot recovery (stale session scan)...");
await recoveryService.recoverOnBoot();

console.log("[startup] Starting polling...");
startPolling(docker);
```

- [ ] **Step 2: Update polling.ts — replace dispatchTasks with dispatchTasksForProject**

In `backend/src/polling.ts`, inside `pollPlanningPrs`, find this block:

```typescript
const dispatcher = new TaskDispatcher();
dispatcher.dispatchTasks(docker, project.id).then(results => {
  ...
}).catch(err => {
  ...
});
```

Replace it with:

```typescript
const { getRecoveryService } = await import("./orchestrator/recoveryService.js");
getRecoveryService().dispatchTasksForProject(project.id).catch(err => {
  console.error(`[polling] dispatchTasksForProject failed for project ${project.id}:`, err);
});
```

Also remove the now-unused `TaskDispatcher` import from `polling.ts` if present.

- [ ] **Step 3: Update polling.ts — add recoverExecutingProjects each cycle**

In `pollAllPullRequests`, at the end just before `await pollPlanningPrs(docker)`:

```typescript
// Recover any stale sub-agent sessions
const { getRecoveryService } = await import("./orchestrator/recoveryService.js");
await getRecoveryService().recoverExecutingProjects();
```

- [ ] **Step 4: Run full test suite**

```bash
cd backend && npx vitest run 2>&1 | tail -20
```
Expected: all tests pass.

- [ ] **Step 5: TypeScript check**

```bash
cd backend && npx tsc --noEmit 2>&1
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/index.ts backend/src/polling.ts
git commit -m "feat: wire RecoveryService into startup and polling loop"
```

---

## Task 5: Final verification

- [ ] **Step 1: Run full test suite one last time**

```bash
cd backend && npx vitest run 2>&1
```
Expected: all tests pass, no regressions.

- [ ] **Step 2: TypeScript check**

```bash
cd backend && npx tsc --noEmit 2>&1
```
Expected: zero errors.

- [ ] **Step 3: Verify RecoveryService is the only dispatcher in polling.ts**

```bash
grep -n "TaskDispatcher\|dispatchTasks" backend/src/polling.ts
```
Expected: no results (the old `TaskDispatcher` call has been replaced).

- [ ] **Step 4: Verify restart_failed_tasks is in the getOrInitAgent tool list**

```bash
grep -n "restartTool\|restart_failed_tasks" backend/src/api/websocket.ts
```
Expected: at least 2 lines — the import and the tool array entry.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: final verification — self-healing subagent system complete"
```
