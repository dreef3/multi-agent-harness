import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { initDb } from "../store/db.js";
import { insertProject, getProject } from "../store/projects.js";
import { insertAgentSession, getAgentSession, updateAgentSession } from "../store/agents.js";
import { config } from "../config.js";
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
      // notifyMaster called once for project completion, NOT for failure
      expect(mockNotify).toHaveBeenCalledWith("proj-2", expect.stringContaining("complete"));
      expect(mockNotify).toHaveBeenCalledTimes(1);
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

    it("skips recovery when container is still running", async () => {
      insertProject(makeProject("proj-12"));
      insertAgentSession(makeSession("sess-4", "proj-12", "running", "task-1", 40));

      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const svc = new RecoveryService({} as never);
      // @ts-expect-error accessing private for test
      svc.getContainerStatus = vi.fn().mockResolvedValue("running");
      const dispatchSpy = vi.spyOn(svc, "dispatchWithRetry").mockResolvedValue(undefined);

      await svc.recoverExecutingProjects();

      expect(dispatchSpy).not.toHaveBeenCalled(); // container running → no recovery
    });
  });

  describe("recoverOrphanedProject — orphaned executing project detection", () => {
    it("notifies master when project is executing with no tasks", async () => {
      const proj = makeProject("proj-orphan-1");
      proj.plan!.tasks = [];
      insertProject(proj);

      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const mockNotify = vi.fn().mockResolvedValue(undefined);
      const svc = new RecoveryService({} as never);
      // @ts-expect-error accessing private for test
      svc.notifyMaster = mockNotify;

      // @ts-expect-error accessing private for test
      await svc.recoverOrphanedProject(proj);

      expect(mockNotify).toHaveBeenCalledWith("proj-orphan-1", expect.stringContaining("awaiting_plan_approval"));
      expect(getProject("proj-orphan-1")!.status).toBe("awaiting_plan_approval"); // reverted
    });

    it("calls checkAllTerminal when all tasks are already terminal", async () => {
      const proj = makeProject("proj-orphan-2");
      proj.plan!.tasks[0].status = "completed";
      insertProject(proj);

      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const mockNotify = vi.fn().mockResolvedValue(undefined);
      const svc = new RecoveryService({} as never);
      // @ts-expect-error accessing private for test
      svc.notifyMaster = mockNotify;

      // @ts-expect-error accessing private for test
      await svc.recoverOrphanedProject(proj);

      // checkAllTerminal should transition project to completed and notify
      expect(getProject("proj-orphan-2")!.status).toBe("completed");
      expect(mockNotify).toHaveBeenCalledWith("proj-orphan-2", expect.stringContaining("complete"));
    });

    it("re-dispatches pending tasks when no active sessions", async () => {
      const proj = makeProject("proj-orphan-3");
      proj.plan!.tasks[0].status = "pending";
      insertProject(proj);

      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const svc = new RecoveryService({} as never);
      const dispatchSpy = vi.spyOn(svc, "dispatchWithRetry").mockResolvedValue(undefined);

      // @ts-expect-error accessing private for test
      await svc.recoverOrphanedProject(proj);

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
    });

    it("skips tasks already in activeTaskIds when re-dispatching", async () => {
      const proj = makeProject("proj-orphan-4");
      proj.plan!.tasks[0].status = "pending";
      insertProject(proj);

      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const svc = new RecoveryService({} as never);
      // @ts-expect-error accessing private for test
      svc.activeTaskIds.add("task-1");
      const dispatchSpy = vi.spyOn(svc, "dispatchWithRetry").mockResolvedValue(undefined);

      // @ts-expect-error accessing private for test
      await svc.recoverOrphanedProject(proj);

      expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it("resets executing tasks to pending before re-dispatch when no session", async () => {
      const proj = makeProject("proj-orphan-5");
      proj.plan!.tasks[0].status = "executing";
      insertProject(proj);

      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const svc = new RecoveryService({} as never);
      const dispatchSpy = vi.spyOn(svc, "dispatchWithRetry").mockResolvedValue(undefined);

      // @ts-expect-error accessing private for test
      await svc.recoverOrphanedProject(proj);

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      // task should have been reset to pending before dispatch
      expect(getProject("proj-orphan-5")!.plan!.tasks[0].status).toBe("pending");
    });
  });

  describe("recoverExecutingProjects — orphan detection", () => {
    it("calls recoverOrphanedProject when project has no active sessions", async () => {
      const proj = makeProject("proj-orphan-6");
      proj.plan!.tasks[0].status = "pending";
      insertProject(proj);
      // No sessions inserted

      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const svc = new RecoveryService({} as never);
      const orphanSpy = vi.spyOn(svc as never, "recoverOrphanedProject").mockResolvedValue(undefined);

      await svc.recoverExecutingProjects();

      expect(orphanSpy).toHaveBeenCalledWith(expect.objectContaining({ id: "proj-orphan-6" }));
    });

    it("does NOT call recoverOrphanedProject when active sessions exist", async () => {
      insertProject(makeProject("proj-orphan-7"));
      // Insert a fresh session (5 min ago — not stale)
      insertAgentSession(makeSession("sess-orphan", "proj-orphan-7", "running", "task-1", 5));

      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const svc = new RecoveryService({} as never);
      const orphanSpy = vi.spyOn(svc as never, "recoverOrphanedProject").mockResolvedValue(undefined);
      // @ts-expect-error accessing private for test
      svc.getContainerStatus = vi.fn().mockResolvedValue("running"); // not stale

      await svc.recoverExecutingProjects();

      expect(orphanSpy).not.toHaveBeenCalled();
    });
  });

  describe("errorMessage population", () => {
    it("sets errorMessage on task when permanently failed via dispatchWithRetry", async () => {
      insertProject(makeProject("proj-err"));
      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const mockDocker = {} as never;
      const mockRunTask = vi.fn().mockResolvedValue({ taskId: "task-1", success: false, error: "container exited 1" });
      const mockNotify = vi.fn().mockResolvedValue(undefined);
      const svc = new RecoveryService(mockDocker);
      // @ts-expect-error accessing private for test
      svc.dispatcher.runTask = mockRunTask;
      // @ts-expect-error accessing private for test
      svc.notifyMaster = mockNotify;

      // Temporarily set maxRetries to 0 so 1 attempt causes permanent failure
      const originalMaxRetries = config.subAgentMaxRetries;
      config.subAgentMaxRetries = 0;
      try {
        const freshProject = getProject("proj-err")!;
        await svc.dispatchWithRetry(freshProject, freshProject.plan!.tasks[0]);
      } finally {
        config.subAgentMaxRetries = originalMaxRetries;
      }

      const updated = getProject("proj-err")!;
      const updatedTask = updated.plan!.tasks[0];
      expect(updatedTask.status).toBe("failed");
      expect(updatedTask.errorMessage).toContain("container exited 1");
    });

    it("sets errorMessage on task when recoverSession exhausts retries", async () => {
      const project = makeProject("proj-recover");
      insertProject(project);
      const session = makeSession("sess-recover", "proj-recover", "running");
      insertAgentSession(session);

      const { RecoveryService } = await import("../orchestrator/recoveryService.js");
      const mockDocker = {
        getContainer: vi.fn().mockReturnValue({
          inspect: vi.fn().mockResolvedValue({ State: { Status: "exited" } }),
        }),
      } as never;
      const mockNotify = vi.fn().mockResolvedValue(undefined);
      const svc = new RecoveryService(mockDocker);
      // @ts-expect-error accessing private for test
      svc.getContainerStatus = vi.fn().mockResolvedValue("exited");
      // @ts-expect-error accessing private for test
      svc.notifyMaster = mockNotify;

      // Manually update task retryCount to match so the exhaustion branch is triggered
      const { updateTaskInPlan } = await import("../store/projects.js");
      updateTaskInPlan("proj-recover", "task-1", { retryCount: config.subAgentMaxRetries });

      // @ts-expect-error accessing private for test
      await svc.recoverSession(session);

      const updated = getProject("proj-recover")!;
      const updatedTask = updated.plan!.tasks.find(t => t.id === "task-1")!;
      expect(updatedTask.status).toBe("failed");
      expect(updatedTask.errorMessage).toContain("Permanently failed");
    });
  });
});

describe("createRestartFailedTasksTool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-recovery-tool-test-"));
    initDb(tmpDir);
    vi.resetAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("calls dispatchFailedTasks and returns count message", async () => {
    const { createRestartFailedTasksTool } = await import("../agents/restartFailedTasksTool.js");
    const { setRecoveryService, RecoveryService } = await import("../orchestrator/recoveryService.js");

    insertProject(makeProject("proj-tool"));
    const svc = new RecoveryService({} as never);
    vi.spyOn(svc, "dispatchFailedTasks").mockResolvedValue({ count: 3 });
    setRecoveryService(svc);

    const tool = createRestartFailedTasksTool("proj-tool");
    const result = await tool.execute("call-id", {}, undefined, undefined, {} as never);
    const firstContent = result.content[0] as { type: string; text: string };
    expect(firstContent.text).toContain("3");
    expect(svc.dispatchFailedTasks).toHaveBeenCalledWith("proj-tool");
  });
});
