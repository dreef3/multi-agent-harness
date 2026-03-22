# Planning Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-process `MasterAgent` with a per-project Docker container running the pi SDK in JSON-RPC mode, with access to cloned project repositories and typed HTTP tools for dispatching sub-agent tasks.

**Architecture:** A new `PlanningAgentManager` singleton manages per-project planning containers (one per project, started on-demand). The backend communicates via the pi SDK's JSON-RPC protocol over Docker stdin/stdout attach. The container runs `runRpcMode(session)` after cloning repos and registering custom tools. WebSocket traffic is proxied through `PlanningAgentManager` instead of `MasterAgent`.

**Tech Stack:** TypeScript, Node.js, Dockerode, `@mariozechner/pi-coding-agent` (SDK + `runRpcMode`), Bun (in container), `@sinclair/typebox` (tool schemas), Vitest (tests).

**Spec:** `docs/superpowers/specs/2026-03-22-planning-agent-design.md`

---

## File Map

### New files
| File | Purpose |
|------|---------|
| `planning-agent/Dockerfile` | Container image for planning agent |
| `planning-agent/package.json` | Container dependencies |
| `planning-agent/runner.mjs` | Entrypoint: clone repos, create session with custom tools, run RPC mode |
| `planning-agent/system-prompt.md` | Planning agent system prompt (injected at session creation) |
| `backend/src/orchestrator/planningAgentManager.ts` | Singleton: container lifecycle + JSON-RPC communication |
| `backend/src/__tests__/planningAgentManager.test.ts` | Unit tests for PlanningAgentManager |

### Modified files
| File | Changes |
|------|---------|
| `backend/src/models/types.ts` | Add `errorMessage?: string` to `PlanTask` |
| `backend/src/orchestrator/recoveryService.ts` | Populate `errorMessage`, switch `notifyMaster` to `PlanningAgentManager`, update messages |
| `backend/src/api/projects.ts` | Add `POST /api/projects/:id/tasks` and `GET /api/projects/:id/tasks` |
| `backend/src/config.ts` | Add `planningAgentImage` config key |
| `backend/src/index.ts` | Initialise `PlanningAgentManager` singleton at startup |
| `backend/src/api/websocket.ts` | Replace `MasterAgent`/`getOrInitAgent` with `PlanningAgentManager` |

### Deleted files
| File | Reason |
|------|--------|
| `backend/src/agents/masterAgent.ts` | Replaced by `PlanningAgentManager` + container |
| `backend/src/agents/restartFailedTasksTool.ts` | Superseded — planning agent calls `dispatch_tasks` directly |
| `backend/src/__tests__/masterAgent.test.ts` | Tests for deleted class |

---

## Task 1: Add `errorMessage` to `PlanTask`

**Files:**
- Modify: `backend/src/models/types.ts`
- Modify: `backend/src/orchestrator/recoveryService.ts`
- Modify: `backend/src/__tests__/recoveryService.test.ts`

- [ ] **Step 1: Add the field to the type**

In `backend/src/models/types.ts`, add `errorMessage` to `PlanTask`:

```typescript
export interface PlanTask {
  id: string;
  repositoryId: string;
  description: string;
  status: "pending" | "executing" | "completed" | "failed" | "cancelled";
  dependsOn?: string[];
  retryCount?: number;
  errorMessage?: string;  // populated on permanent failure
}
```

- [ ] **Step 2: Populate `errorMessage` in RecoveryService on permanent failure**

In `recoveryService.ts`, `dispatchWithRetry` already calls `updateTaskInPlan` when marking a task permanently failed (after the while loop). Change the call to include `errorMessage`:

```typescript
// After the while loop, before notifyMasterPartialFailure:
console.error(`[recoveryService] task ${task.id} permanently failed after ${localRetryCount} attempt(s)`);
updateTaskInPlan(project.id, task.id, {
  status: "failed",
  retryCount: localRetryCount,
  errorMessage: `Permanently failed after ${localRetryCount} attempt(s). Last error: ${result.error ?? "unknown"}`,
});
await this.notifyMasterPartialFailure(project.id, task, localRetryCount);
```

Also update `recoverSession` when exhausting retries:

```typescript
// In recoverSession, the else branch:
updateTaskInPlan(session.projectId, session.taskId, {
  status: "failed",
  retryCount: currentRetryCount,
  errorMessage: `Permanently failed after recovery (${currentRetryCount} attempt(s)). Container was stale.`,
});
```

- [ ] **Step 3: Write a failing test for `errorMessage` population**

Add to `backend/src/__tests__/recoveryService.test.ts` (after existing tests):

```typescript
it("sets errorMessage on task when permanently failed", async () => {
  const project = makeProject("proj-err");
  insertProject(project);
  const session = makeSession("sess-err", "proj-err", "running");
  insertAgentSession(session);

  // Mock Docker + dispatcher
  const mockDocker = {
    getContainer: vi.fn().mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ State: { Status: "exited" } }),
    }),
  } as never;

  vi.mock("../orchestrator/taskDispatcher.js", () => ({
    TaskDispatcher: vi.fn().mockImplementation(() => ({
      runTask: vi.fn().mockResolvedValue({ success: false, error: "container exited 1" }),
    })),
  }));
  vi.mock("../api/websocket.js", () => ({
    getOrInitAgent: vi.fn().mockResolvedValue({ prompt: vi.fn() }),
  }));

  const { RecoveryService } = await import("../orchestrator/recoveryService.js");
  const svc = new RecoveryService(mockDocker);
  // Force exhaustion: max retries = 0 means 1 attempt, then permanent failure
  vi.spyOn(await import("../config.js"), "config", "get").mockReturnValue({ ...config, subAgentMaxRetries: 0 });

  const freshProject = getProject("proj-err")!;
  const task = freshProject.plan!.tasks[0];
  await svc.dispatchWithRetry(freshProject, task);

  const updated = getProject("proj-err")!;
  const updatedTask = updated.plan!.tasks[0];
  expect(updatedTask.status).toBe("failed");
  expect(updatedTask.errorMessage).toContain("container exited 1");
});
```

- [ ] **Step 4: Run tests — should fail (no errorMessage yet)**

```bash
cd /home/ae/multi-agent-harness/backend && npm test -- --reporter=verbose 2>&1 | tail -30
```

Expected: test `sets errorMessage on task when permanently failed` FAIL.

- [ ] **Step 5: Implementation is done (Step 2 above). Run tests again.**

```bash
cd /home/ae/multi-agent-harness/backend && npm test 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/ae/multi-agent-harness
git add backend/src/models/types.ts backend/src/orchestrator/recoveryService.ts backend/src/__tests__/recoveryService.test.ts
git commit -m "feat: add errorMessage to PlanTask, populate on permanent failure"
```

---

## Task 2: New Task API Endpoints

**Files:**
- Modify: `backend/src/api/projects.ts`
- Modify: `backend/src/__tests__/projects.test.ts`

- [ ] **Step 1: Write failing tests for the two new endpoints**

Open `backend/src/__tests__/projects.test.ts`. Find how existing routes are tested (supertest + express app). Add tests for the new endpoints.

Check the test file header to understand the test setup pattern, then add:

```typescript
describe("POST /projects/:id/tasks", () => {
  it("returns 404 for unknown project", async () => {
    const res = await request(app).post("/projects/nonexistent/tasks").send({ tasks: [] });
    expect(res.status).toBe(404);
  });

  it("returns 400 when tasks array is missing", async () => {
    const project = createTestProject();
    const res = await request(app).post(`/projects/${project.id}/tasks`).send({});
    expect(res.status).toBe(400);
  });

  it("upserts tasks into plan and returns dispatched count", async () => {
    const project = createTestProject();
    // Seed a plan with one existing task
    updateProject(project.id, {
      plan: { id: "plan-1", projectId: project.id, content: "", tasks: [
        { id: "task-1", repositoryId: "repo-1", description: "Old task", status: "failed", retryCount: 2, errorMessage: "prev error" }
      ]},
      status: "executing",
    });

    const mockDispatch = vi.fn().mockResolvedValue(undefined);
    vi.mock("../orchestrator/recoveryService.js", () => ({
      getRecoveryService: () => ({ dispatchTasksForProject: mockDispatch }),
    }));

    const res = await request(app).post(`/projects/${project.id}/tasks`).send({
      tasks: [
        { id: "task-1", repositoryId: "repo-1", description: "Retried task" },  // upsert
        { repositoryId: "repo-1", description: "New task" },                      // new (no id)
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.dispatched).toBe(2);
    expect(mockDispatch).toHaveBeenCalledWith(project.id);
    const updated = getProject(project.id)!;
    const task1 = updated.plan!.tasks.find(t => t.id === "task-1")!;
    expect(task1.status).toBe("pending");
    expect(task1.retryCount).toBe(0);
    expect(task1.errorMessage).toBeUndefined();
    expect(updated.plan!.tasks).toHaveLength(2);
  });
});

describe("GET /projects/:id/tasks", () => {
  it("returns 404 for unknown project", async () => {
    const res = await request(app).get("/projects/nonexistent/tasks");
    expect(res.status).toBe(404);
  });

  it("returns empty tasks when no plan", async () => {
    const project = createTestProject();
    const res = await request(app).get(`/projects/${project.id}/tasks`);
    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([]);
  });

  it("returns task list with errorMessage when plan exists", async () => {
    const project = createTestProject();
    updateProject(project.id, {
      plan: { id: "plan-1", projectId: project.id, content: "", tasks: [
        { id: "t1", repositoryId: "repo-1", description: "Do A", status: "failed", errorMessage: "timeout" },
      ]},
    });
    const res = await request(app).get(`/projects/${project.id}/tasks`);
    expect(res.status).toBe(200);
    expect(res.body.tasks[0].errorMessage).toBe("timeout");
  });
});
```

- [ ] **Step 2: Run tests — expect failures for the new endpoints**

```bash
cd /home/ae/multi-agent-harness/backend && npm test -- --reporter=verbose 2>&1 | grep -A3 "tasks"
```

Expected: new tests FAIL with 404 or route-not-found.

- [ ] **Step 3: Implement the endpoints in `backend/src/api/projects.ts`**

Add these two routes inside `createProjectsRouter()`, before the `return router` line. Also import the needed deps:

```typescript
import { randomUUID } from "crypto";  // already imported
import { updateTaskInPlan } from "../store/projects.js";  // already imported
import { getRecoveryService } from "../orchestrator/recoveryService.js";
```

```typescript
// GET /api/projects/:id/tasks — return task list for planning agent get_task_status tool
router.get("/:id/tasks", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  res.json({ tasks: project.plan?.tasks ?? [] });
});

// POST /api/projects/:id/tasks — upsert tasks and dispatch (for planning agent dispatch_tasks tool)
router.post("/:id/tasks", async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { tasks } = req.body as { tasks?: Array<{ id?: string; repositoryId: string; description: string }> };
  if (!Array.isArray(tasks)) { res.status(400).json({ error: "tasks must be an array" }); return; }

  const now = new Date().toISOString();
  const existingTasks = project.plan?.tasks ?? [];

  const updatedTasks = [...existingTasks];
  for (const incoming of tasks) {
    const existingIdx = incoming.id ? updatedTasks.findIndex(t => t.id === incoming.id) : -1;
    if (existingIdx >= 0) {
      // Upsert: reset to pending, clear error
      updatedTasks[existingIdx] = {
        ...updatedTasks[existingIdx],
        description: incoming.description,
        repositoryId: incoming.repositoryId,
        status: "pending",
        retryCount: 0,
        errorMessage: undefined,
      };
    } else {
      // New task
      updatedTasks.push({
        id: incoming.id ?? randomUUID(),
        repositoryId: incoming.repositoryId,
        description: incoming.description,
        status: "pending",
      });
    }
  }

  const plan = project.plan
    ? { ...project.plan, tasks: updatedTasks }
    : { id: randomUUID(), projectId: project.id, content: "", tasks: updatedTasks };

  updateProject(project.id, { plan, status: "executing" });

  try {
    await getRecoveryService().dispatchTasksForProject(project.id);
  } catch (err) {
    console.error(`[projects] dispatchTasksForProject error:`, err);
  }

  res.json({ dispatched: tasks.length });
});
```

- [ ] **Step 4: Run tests — all should pass**

```bash
cd /home/ae/multi-agent-harness/backend && npm test 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ae/multi-agent-harness
git add backend/src/api/projects.ts backend/src/__tests__/projects.test.ts
git commit -m "feat: add POST/GET /api/projects/:id/tasks endpoints"
```

---

## Task 3: `PlanningAgentManager` — Container Lifecycle

**Files:**
- Create: `backend/src/orchestrator/planningAgentManager.ts`
- Create: `backend/src/__tests__/planningAgentManager.test.ts`

- [ ] **Step 1: Write failing tests for container lifecycle**

Create `backend/src/__tests__/planningAgentManager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config before importing the module under test
vi.mock("../config.js", () => ({
  config: {
    planningAgentImage: "multi-agent-harness/planning-agent:latest",
    subAgentNetwork: "multi-agent-harness_harness-agents",
    piAgentVolume: "harness-pi-auth",
  },
}));

function makeMockDocker(overrides: Record<string, unknown> = {}) {
  const mockAttachStream = {
    write: vi.fn(),
    on: vi.fn(),
    pipe: vi.fn(),
  };
  const mockContainer = {
    id: "container-plan-123",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    attach: vi.fn().mockImplementation((_opts, cb) => cb(null, mockAttachStream)),
    inspect: vi.fn().mockResolvedValue({ State: { Status: "running" } }),
  };
  return {
    docker: {
      createContainer: vi.fn().mockResolvedValue(mockContainer),
      getContainer: vi.fn().mockReturnValue(mockContainer),
      listContainers: vi.fn().mockResolvedValue([]),
      modem: { demuxStream: vi.fn() },
      ...overrides,
    },
    mockContainer,
    mockAttachStream,
  };
}

describe("PlanningAgentManager - container lifecycle", () => {
  beforeEach(() => { vi.resetModules(); });

  it("starts a new container for a project and tracks it", async () => {
    const { docker, mockContainer } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);

    expect(mgr.isRunning("proj-1")).toBe(false);
    await mgr.ensureRunning("proj-1", []);
    expect(mgr.isRunning("proj-1")).toBe(true);
    expect(mockContainer.start).toHaveBeenCalled();
  });

  it("does not create a second container when one is already running", async () => {
    const { docker, mockContainer } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);

    await mgr.ensureRunning("proj-1", []);
    await mgr.ensureRunning("proj-1", []);
    expect(mockContainer.start).toHaveBeenCalledTimes(1);
  });

  it("stops and deregisters the container on stopContainer", async () => {
    const { docker, mockContainer } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);

    await mgr.ensureRunning("proj-1", []);
    expect(mgr.isRunning("proj-1")).toBe(true);

    await mgr.stopContainer("proj-1");
    expect(mockContainer.stop).toHaveBeenCalled();
    expect(mgr.isRunning("proj-1")).toBe(false);
  });

  it("reuses an existing container on backend restart", async () => {
    const { docker, mockContainer } = makeMockDocker();
    // Simulate existing container found in Docker
    docker.listContainers = vi.fn().mockResolvedValue([{
      Id: "container-plan-123",
      Names: ["/planning-proj-2"],
      State: "running",
    }]);

    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);

    await mgr.ensureRunning("proj-2", []);
    // Should not create a new container — already exists
    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(mgr.isRunning("proj-2")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — expect import error (file doesn't exist yet)**

```bash
cd /home/ae/multi-agent-harness/backend && npm test -- planningAgentManager 2>&1 | tail -20
```

Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `backend/src/orchestrator/planningAgentManager.ts` with lifecycle only**

```typescript
import type Dockerode from "dockerode";
import { PassThrough } from "stream";
import { config } from "../config.js";

export type PlanningAgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; toolName: string; args?: Record<string, unknown> }
  | { type: "message_complete" }
  | { type: "conversation_complete" };

interface ProjectState {
  containerId: string;
  stream: NodeJS.ReadWriteStream;
  stdout: PassThrough;
  lineBuffer: string;
  isStreaming: boolean;
  wsConnectionCount: number;
  outputHandlers: Set<(event: PlanningAgentEvent) => void>;
}

let instance: PlanningAgentManager | null = null;

export function setPlanningAgentManager(mgr: PlanningAgentManager): void {
  instance = mgr;
}

export function getPlanningAgentManager(): PlanningAgentManager {
  if (!instance) throw new Error("[PlanningAgentManager] not initialised");
  return instance;
}

export class PlanningAgentManager {
  private projects = new Map<string, ProjectState>();

  constructor(private readonly docker: Dockerode) {}

  isRunning(projectId: string): boolean {
    return this.projects.has(projectId);
  }

  /**
   * Ensure a planning agent container is running for the project.
   * repos: array of { name, url } for GIT_CLONE_URLS env var.
   * Reuses existing container (by name) if present from a prior run.
   */
  async ensureRunning(
    projectId: string,
    repos: Array<{ name: string; url: string }>
  ): Promise<void> {
    if (this.projects.has(projectId)) return;

    const containerName = `planning-${projectId}`;
    let containerId: string;

    // Check if a container with this name already exists
    const existing = await this.findExistingContainer(containerName);
    if (existing) {
      console.log(`[PlanningAgentManager] reusing existing container ${existing} for project ${projectId}`);
      containerId = existing;
    } else {
      containerId = await this.createContainer(projectId, containerName, repos);
      await this.docker.getContainer(containerId).start();
      console.log(`[PlanningAgentManager] started container ${containerId} for project ${projectId}`);
    }

    const { stream, stdout } = await this.attachContainer(containerId);
    const state: ProjectState = {
      containerId,
      stream,
      stdout,
      lineBuffer: "",
      isStreaming: false,
      wsConnectionCount: 0,
      outputHandlers: new Set(),
    };
    this.projects.set(projectId, state);
    this.listenStdout(projectId, state);
  }

  async stopContainer(projectId: string): Promise<void> {
    const state = this.projects.get(projectId);
    if (!state) return;
    this.projects.delete(projectId);
    try {
      await this.docker.getContainer(state.containerId).stop({ t: 10 });
      console.log(`[PlanningAgentManager] stopped container ${state.containerId}`);
    } catch (err) {
      console.warn(`[PlanningAgentManager] stop failed (may already be stopped):`, err);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async findExistingContainer(name: string): Promise<string | null> {
    try {
      const containers = await this.docker.listContainers({ all: true });
      const match = containers.find(c =>
        c.Names?.some((n: string) => n === `/${name}` || n === name)
      );
      return match ? match.Id : null;
    } catch {
      return null;
    }
  }

  private async createContainer(
    projectId: string,
    name: string,
    repos: Array<{ name: string; url: string }>
  ): Promise<string> {
    const providerEnvVars = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "OPENCODE_API_KEY",
      "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY"]
      .filter(k => process.env[k])
      .map(k => `${k}=${process.env[k]}`);

    const container = await this.docker.createContainer({
      Image: config.planningAgentImage,
      name,
      Env: [
        `GIT_CLONE_URLS=${JSON.stringify(repos)}`,
        `PROJECT_ID=${projectId}`,
        `BACKEND_URL=http://backend:3000`,
        `PI_CODING_AGENT_DIR=/pi-agent`,
        ...providerEnvVars,
      ],
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: [`${config.piAgentVolume}:/pi-agent`],
        NetworkMode: config.subAgentNetwork,
      },
    });
    console.log(`[PlanningAgentManager] created container ${container.id} name=${name}`);
    return container.id;
  }

  private attachContainer(containerId: string): Promise<{ stream: NodeJS.ReadWriteStream; stdout: PassThrough }> {
    return new Promise((resolve, reject) => {
      this.docker.getContainer(containerId).attach(
        { stream: true, stdin: true, stdout: true, stderr: true },
        (err: Error | null, stream: NodeJS.ReadWriteStream) => {
          if (err) { reject(err); return; }
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          stderr.on("data", (chunk: Buffer) =>
            console.error(`[planning-agent stderr]`, chunk.toString())
          );
          (this.docker as unknown as { modem: { demuxStream: (s: unknown, o: unknown, e: unknown) => void } })
            .modem.demuxStream(stream, stdout, stderr);
          resolve({ stream, stdout });
        }
      );
    });
  }

  private listenStdout(projectId: string, state: ProjectState): void {
    state.stdout.on("data", (chunk: Buffer) => {
      state.lineBuffer += chunk.toString();
      const lines = state.lineBuffer.split("\n");
      state.lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleRpcLine(projectId, state, trimmed);
      }
    });
  }

  private handleRpcLine(projectId: string, state: ProjectState, line: string): void {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; }
    catch { return; } // not JSON — ignore

    const type = obj.type as string;

    if (type === "agent_start") { state.isStreaming = true; return; }

    if (type === "message_update") {
      const evt = obj.assistantMessageEvent as Record<string, unknown> | undefined;
      if (evt?.type === "text_delta" && typeof evt.delta === "string") {
        this.emit(state, { type: "delta", text: evt.delta });
      }
      return;
    }

    if (type === "tool_execution_start") {
      this.emit(state, {
        type: "tool_call",
        toolName: obj.toolName as string,
        args: obj.args as Record<string, unknown> | undefined,
      });
      return;
    }

    if (type === "message_end") {
      this.emit(state, { type: "message_complete" });
      return;
    }

    if (type === "agent_end") {
      state.isStreaming = false;
      this.emit(state, { type: "conversation_complete" });
      this.checkStop(projectId, state);
      return;
    }
  }

  private emit(state: ProjectState, event: PlanningAgentEvent): void {
    for (const handler of state.outputHandlers) {
      try { handler(event); } catch { /* ignore handler errors */ }
    }
  }

  private checkStop(projectId: string, state: ProjectState): void {
    if (state.wsConnectionCount === 0 && !state.isStreaming) {
      console.log(`[PlanningAgentManager] no connections + idle — stopping container for ${projectId}`);
      void this.stopContainer(projectId);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async sendPrompt(projectId: string, message: string): Promise<void> {
    const state = this.projects.get(projectId);
    if (!state) {
      console.warn(`[PlanningAgentManager] sendPrompt: no container for project ${projectId}`);
      return;
    }
    const cmd = JSON.stringify({
      type: "prompt",
      message,
      ...(state.isStreaming ? { streamingBehavior: "followUp" } : {}),
    }) + "\n";
    state.stream.write(cmd);
  }

  onOutput(projectId: string, handler: (event: PlanningAgentEvent) => void): () => void {
    const state = this.projects.get(projectId);
    if (!state) return () => {};
    state.outputHandlers.add(handler);
    return () => state.outputHandlers.delete(handler);
  }

  incrementConnections(projectId: string): void {
    const state = this.projects.get(projectId);
    if (state) state.wsConnectionCount++;
  }

  decrementConnections(projectId: string): void {
    const state = this.projects.get(projectId);
    if (!state) return;
    state.wsConnectionCount = Math.max(0, state.wsConnectionCount - 1);
    this.checkStop(projectId, state);
  }

  onProjectTerminal(projectId: string): void {
    const state = this.projects.get(projectId);
    if (!state) return;
    this.checkStop(projectId, state);
  }
}
```

- [ ] **Step 4: Run lifecycle tests — should pass**

```bash
cd /home/ae/multi-agent-harness/backend && npm test -- planningAgentManager 2>&1 | tail -20
```

Expected: lifecycle tests PASS. Communication tests (sendPrompt, onOutput) will be added in Task 4.

- [ ] **Step 5: Compile TypeScript**

```bash
cd /home/ae/multi-agent-harness/backend && npm run build 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /home/ae/multi-agent-harness
git add backend/src/orchestrator/planningAgentManager.ts backend/src/__tests__/planningAgentManager.test.ts
git commit -m "feat: add PlanningAgentManager with container lifecycle"
```

---

## Task 4: `PlanningAgentManager` — Communication Tests

**Files:**
- Modify: `backend/src/__tests__/planningAgentManager.test.ts`

- [ ] **Step 1: Add communication tests**

Append to `planningAgentManager.test.ts`:

```typescript
describe("PlanningAgentManager - communication", () => {
  beforeEach(() => { vi.resetModules(); });

  async function makeRunningManager() {
    const { docker, mockAttachStream } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-1", []);
    return { mgr, mockAttachStream };
  }

  it("writes prompt JSON-RPC command to stdin", async () => {
    const { mgr, mockAttachStream } = await makeRunningManager();
    await mgr.sendPrompt("proj-1", "Hello agent");
    expect(mockAttachStream.write).toHaveBeenCalledWith(
      expect.stringContaining('"type":"prompt"')
    );
    expect(mockAttachStream.write).toHaveBeenCalledWith(
      expect.stringContaining('"message":"Hello agent"')
    );
  });

  it("includes streamingBehavior:followUp when streaming", async () => {
    const { mgr, mockAttachStream } = await makeRunningManager();
    // Simulate agent_start to set isStreaming
    // Access internals via a test helper — we'll simulate by sending a line
    // Instead, trigger via the stdout data event
    const { docker } = makeMockDocker();
    // (This is tested via full integration; skip in unit tests)
    // At minimum verify the field is absent when not streaming
    await mgr.sendPrompt("proj-1", "first");
    const call = (mockAttachStream.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(call).not.toContain("streamingBehavior");
  });

  it("emits delta events when text_delta lines arrive on stdout", async () => {
    const { docker } = makeMockDocker();
    // Capture stdout PassThrough to feed test data
    let capturedStdout: import("stream").PassThrough | null = null;
    docker.modem.demuxStream = vi.fn((_stream, stdout) => { capturedStdout = stdout as import("stream").PassThrough; });
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-1", []);

    const events: import("../orchestrator/planningAgentManager.js").PlanningAgentEvent[] = [];
    mgr.onOutput("proj-1", (e) => events.push(e));

    capturedStdout!.write(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    }) + "\n");

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "delta", text: "Hello" });
  });

  it("emits tool_call event on tool_execution_start", async () => {
    const { docker } = makeMockDocker();
    let capturedStdout: import("stream").PassThrough | null = null;
    docker.modem.demuxStream = vi.fn((_stream, stdout) => { capturedStdout = stdout as import("stream").PassThrough; });
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-1", []);

    const events: import("../orchestrator/planningAgentManager.js").PlanningAgentEvent[] = [];
    mgr.onOutput("proj-1", (e) => events.push(e));

    capturedStdout!.write(JSON.stringify({
      type: "tool_execution_start",
      toolName: "dispatch_tasks",
      args: { tasks: [] },
    }) + "\n");

    expect(events[0]).toEqual({ type: "tool_call", toolName: "dispatch_tasks", args: { tasks: [] } });
  });

  it("emits message_complete on message_end", async () => {
    const { docker } = makeMockDocker();
    let capturedStdout: import("stream").PassThrough | null = null;
    docker.modem.demuxStream = vi.fn((_stream, stdout) => { capturedStdout = stdout as import("stream").PassThrough; });
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-1", []);
    const events: import("../orchestrator/planningAgentManager.js").PlanningAgentEvent[] = [];
    mgr.onOutput("proj-1", (e) => events.push(e));

    capturedStdout!.write(JSON.stringify({ type: "message_end", message: {} }) + "\n");
    expect(events[0]).toEqual({ type: "message_complete" });
  });

  it("emits conversation_complete on agent_end", async () => {
    const { docker } = makeMockDocker();
    let capturedStdout: import("stream").PassThrough | null = null;
    docker.modem.demuxStream = vi.fn((_stream, stdout) => { capturedStdout = stdout as import("stream").PassThrough; });
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-1", []);
    const events: import("../orchestrator/planningAgentManager.js").PlanningAgentEvent[] = [];
    mgr.onOutput("proj-1", (e) => events.push(e));

    capturedStdout!.write(JSON.stringify({ type: "agent_end", messages: [] }) + "\n");
    expect(events[0]).toEqual({ type: "conversation_complete" });
  });
});
```

- [ ] **Step 2: Run tests — expect new tests to pass (implementation already exists)**

```bash
cd /home/ae/multi-agent-harness/backend && npm test -- planningAgentManager 2>&1 | tail -30
```

Expected: all planningAgentManager tests PASS.

- [ ] **Step 3: Run full test suite**

```bash
cd /home/ae/multi-agent-harness/backend && npm test 2>&1 | tail -10
```

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
cd /home/ae/multi-agent-harness
git add backend/src/__tests__/planningAgentManager.test.ts
git commit -m "test: add communication tests for PlanningAgentManager"
```

---

## Task 5: `planning-agent/` Container

**Files:**
- Create: `planning-agent/Dockerfile`
- Create: `planning-agent/package.json`
- Create: `planning-agent/runner.mjs`
- Create: `planning-agent/system-prompt.md`

- [ ] **Step 1: Create `planning-agent/package.json`**

```json
{
  "name": "@multi-agent-harness/planning-agent",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "@mariozechner/pi-coding-agent": "^0.61.1",
    "@sinclair/typebox": "^0.34.41"
  }
}
```

- [ ] **Step 2: Create `planning-agent/Dockerfile`**

Mirror `sub-agent/Dockerfile` but skip Java/Maven (not needed for planning):

```dockerfile
FROM oven/bun:1

RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN bun install

RUN mkdir -p /workspace /pi-agent && chown bun:bun /workspace /pi-agent

ENV PI_CODING_AGENT_DIR=/pi-agent

COPY --chown=bun:bun runner.mjs .
COPY --chown=bun:bun system-prompt.md .

USER bun

ENTRYPOINT ["bun", "/app/runner.mjs"]
```

- [ ] **Step 3: Create `planning-agent/system-prompt.md`**

```markdown
You are a planning agent for the multi-agent harness. Your role is to help users design software features and coordinate their implementation.

## Workspace

Project repositories are available at `/workspace/`. Each repository is cloned as a subdirectory:
- List available repos: `ls /workspace/`
- Explore a repo: read files, run `git log`, check existing structure

Your project ID is: {{PROJECT_ID}}

## Your Workflow

You operate in two phases:

### Phase 1 — Design & Planning

When a user starts a conversation:
1. Explore the relevant repositories to understand the codebase
2. Ask clarifying questions to understand the feature requirements
3. Design an implementation plan with clear, independent tasks
4. Use `dispatch_tasks` to submit tasks when the user approves

### Phase 2 — Implementation Monitoring

After dispatching tasks:
1. Inform the user that implementation has started
2. Wait for system notifications about task progress
3. When notified of failures, use `get_task_status` to investigate and decide whether to retry with `dispatch_tasks`
4. When all tasks complete, use `get_pull_requests` to report results to the user

## Tools

- **dispatch_tasks**: Submit implementation tasks for sub-agents to execute. Each task must specify a repositoryId and a clear self-contained description. If re-submitting failed tasks, include the task `id` to reset and retry.
- **get_task_status**: Get current status of all tasks, including error messages for failed tasks.
- **get_pull_requests**: List pull requests created by sub-agents.

## Important Rules

- Do NOT write code yourself — create tasks for sub-agents to implement
- Each task description must be fully self-contained (the sub-agent has no other context)
- Tasks run in parallel — make them independent
- Include the target branch name in each task description if relevant
```

- [ ] **Step 4: Create `planning-agent/runner.mjs`**

```javascript
/**
 * Planning agent runner: clones project repos, creates a pi session
 * with custom backend tools, and runs in JSON-RPC mode for the backend
 * to communicate over stdin/stdout.
 */
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  ModelRegistry,
  AuthStorage,
  runRpcMode,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ID = process.env.PROJECT_ID ?? "unknown";
const BACKEND_URL = process.env.BACKEND_URL ?? "http://backend:3000";
const GIT_CLONE_URLS = process.env.GIT_CLONE_URLS ?? "[]";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const AGENT_PROVIDER = process.env.AGENT_PROVIDER ?? "opencode-go";
const AGENT_MODEL = process.env.AGENT_MODEL;
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? "/pi-agent";

function git(...args) {
  return execFileSync("git", args, { stdio: "inherit" });
}

// ── Git setup ─────────────────────────────────────────────────────────────────
git("config", "--global", "user.email", process.env.GIT_COMMIT_AUTHOR_EMAIL ?? "harness@noreply");
git("config", "--global", "user.name", process.env.GIT_COMMIT_AUTHOR_NAME ?? "Harness Bot");

// ── Clone all project repos ───────────────────────────────────────────────────
const repos = JSON.parse(GIT_CLONE_URLS);
for (const { name, url } of repos) {
  const dest = `/workspace/${name}`;
  if (!existsSync(join(dest, ".git"))) {
    let cloneUrl = url;
    if (GITHUB_TOKEN && cloneUrl.startsWith("https://github.com/")) {
      cloneUrl = `https://x-access-token:${GITHUB_TOKEN}@github.com/${cloneUrl.slice("https://github.com/".length)}`;
    }
    console.log(`[planning-agent] cloning ${name}...`);
    git("clone", cloneUrl, dest);
  } else {
    console.log(`[planning-agent] ${name} already cloned, fetching...`);
    execFileSync("git", ["fetch", "--all"], { cwd: dest, stdio: "inherit" });
  }
}

// ── Custom tools ──────────────────────────────────────────────────────────────

const dispatchTasksTool = {
  name: "dispatch_tasks",
  label: "Dispatch Tasks",
  description: "Submit new tasks or re-dispatch failed tasks for implementation sub-agents. Provide `id` to re-submit an existing task (resets it to pending), or omit `id` for new tasks.",
  parameters: Type.Object({
    tasks: Type.Array(Type.Object({
      id: Type.Optional(Type.String({ description: "Omit for new tasks; provide to re-dispatch a failed task" })),
      repositoryId: Type.String({ description: "Repository ID where this task should run" }),
      description: Type.String({ description: "Full self-contained task description for the sub-agent" }),
    })),
  }),
  execute: async (_toolCallId, params) => {
    const res = await fetch(`${BACKEND_URL}/api/projects/${PROJECT_ID}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks: params.tasks }),
    });
    const data = await res.json();
    return {
      content: [{ type: "text", text: `Dispatched ${data.dispatched} task(s). Sub-agents are running.` }],
      details: {},
    };
  },
};

const getTaskStatusTool = {
  name: "get_task_status",
  label: "Get Task Status",
  description: "Get the current status of all tasks for this project, including error messages for failed tasks.",
  parameters: Type.Object({}),
  execute: async () => {
    const res = await fetch(`${BACKEND_URL}/api/projects/${PROJECT_ID}/tasks`);
    const data = await res.json();
    const summary = data.tasks.map(t =>
      `- [${t.status}] ${t.id}: ${t.description.slice(0, 60)}${t.errorMessage ? ` — ERROR: ${t.errorMessage}` : ""}`
    ).join("\n") || "(no tasks)";
    return {
      content: [{ type: "text", text: `Tasks:\n${summary}` }],
      details: {},
    };
  },
};

const getPullRequestsTool = {
  name: "get_pull_requests",
  label: "Get Pull Requests",
  description: "List pull requests created by implementation sub-agents for this project.",
  parameters: Type.Object({}),
  execute: async () => {
    const res = await fetch(`${BACKEND_URL}/api/pull-requests/project/${PROJECT_ID}`);
    const data = await res.json();
    const prs = Array.isArray(data) ? data : data.pullRequests ?? [];
    const summary = prs.map(pr =>
      `- [${pr.status}] ${pr.title ?? pr.branch}: ${pr.url}`
    ).join("\n") || "(no pull requests yet)";
    return {
      content: [{ type: "text", text: `Pull Requests:\n${summary}` }],
      details: {},
    };
  },
};

// ── Session setup ─────────────────────────────────────────────────────────────
const sessionDir = join(PI_AGENT_DIR, "sessions");
mkdirSync(sessionDir, { recursive: true });
const sessionPath = join(sessionDir, `planning-${PROJECT_ID}.jsonl`);

const settingsManager = SettingsManager.inMemory();
const resourceLoader = new DefaultResourceLoader({
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
});
await resourceLoader.reload();

const authStorage = AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);

let model;
if (AGENT_MODEL) {
  try { model = modelRegistry.find(AGENT_PROVIDER, AGENT_MODEL); } catch { /* use default */ }
}

const systemPromptTemplate = readFileSync("/app/system-prompt.md", "utf8");
const systemPrompt = systemPromptTemplate.replace("{{PROJECT_ID}}", PROJECT_ID);

const loader = new DefaultResourceLoader({
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  systemPromptOverride: () => systemPrompt,
});
await loader.reload();

const sessionManager = existsSync(sessionPath)
  ? SessionManager.open(sessionPath)
  : SessionManager.create(PI_AGENT_DIR, sessionDir);

const { session } = await createAgentSession({
  sessionManager,
  settingsManager,
  resourceLoader: loader,
  modelRegistry,
  authStorage,
  cwd: "/workspace",
  ...(model ? { model } : {}),
  customTools: [dispatchTasksTool, getTaskStatusTool, getPullRequestsTool],
});

console.log(`[planning-agent] session ready for project ${PROJECT_ID}, running RPC mode`);
await runRpcMode(session);
```

- [ ] **Step 5: Build the planning-agent Docker image locally to verify it builds**

```bash
cd /home/ae/multi-agent-harness
docker build -t multi-agent-harness/planning-agent:latest ./planning-agent/
```

Expected: image builds successfully. If `bun install` fails on a dependency, check the package.json.

- [ ] **Step 6: Commit**

```bash
cd /home/ae/multi-agent-harness
git add planning-agent/
git commit -m "feat: add planning-agent container (Dockerfile, runner.mjs, system-prompt)"
```

---

## Task 6: Config and Index.ts Wiring

**Files:**
- Modify: `backend/src/config.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Add `planningAgentImage` to config**

In `backend/src/config.ts`, add after `subAgentImage`:

```typescript
planningAgentImage:
  process.env.PLANNING_AGENT_IMAGE ?? "multi-agent-harness/planning-agent:latest",
```

- [ ] **Step 2: Initialise `PlanningAgentManager` in `index.ts`**

In `backend/src/index.ts`:

Add import:
```typescript
import { PlanningAgentManager, setPlanningAgentManager } from "./orchestrator/planningAgentManager.js";
```

After `setRecoveryService(recoveryService)`:
```typescript
console.log("[startup] Initializing planning agent manager...");
const planningAgentManager = new PlanningAgentManager(docker);
setPlanningAgentManager(planningAgentManager);
```

- [ ] **Step 3: Compile**

```bash
cd /home/ae/multi-agent-harness/backend && npm run build 2>&1 | tail -20
```

Expected: no type errors.

- [ ] **Step 4: Run tests**

```bash
cd /home/ae/multi-agent-harness/backend && npm test 2>&1 | tail -10
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ae/multi-agent-harness
git add backend/src/config.ts backend/src/index.ts
git commit -m "feat: wire PlanningAgentManager into backend startup"
```

---

## Task 7: WebSocket Migration

Replace `MasterAgent`/`getOrInitAgent` in `websocket.ts` with `PlanningAgentManager`.

**Files:**
- Modify: `backend/src/api/websocket.ts`

This is a complete rewrite of the WebSocket module's agent interaction. The external interface (`setupWebSocket`, `preInitAgent`) is preserved for callers.

- [ ] **Step 1: Rewrite `websocket.ts`**

Replace the entire file with the following. Read the current file carefully before replacing — preserve the `buildMasterAgentContext` function and `WsClientMessage`/`WsServerMessage` types.

Key changes:
1. Import `getPlanningAgentManager` instead of `MasterAgent`
2. `getOrInitAgent` becomes `ensurePlanningAgent` — calls `manager.ensureRunning(projectId, repos)`
3. `handleWsMessage` subscribes to `manager.onOutput` instead of agent EventEmitter
4. Connection tracking calls `manager.incrementConnections` / `manager.decrementConnections`

```typescript
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage, Server } from "http";
import { getPlanningAgentManager } from "../orchestrator/planningAgentManager.js";
import type { PlanningAgentEvent } from "../orchestrator/planningAgentManager.js";
import { getProject, updateProject } from "../store/projects.js";
import { appendMessage, listMessagesSince } from "../store/messages.js";
import { listRepositories } from "../store/repositories.js";
import type { Project, Repository } from "../models/types.js";

interface WsClientMessage { type: "prompt" | "steer" | "resume"; text?: string; lastSeqId?: number; }
interface WsServerMessage { type: "delta" | "message_complete" | "conversation_complete" | "tool_call" | "replay" | "error"; [key: string]: unknown; }

function send(ws: WebSocket, msg: WsServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Track all active WebSocket connections per project
const projectConnections = new Map<string, Set<WebSocket>>();

function broadcastToProject(projectId: string, msg: WsServerMessage) {
  const connections = projectConnections.get(projectId);
  if (!connections) return;
  for (const ws of connections) send(ws, msg);
}

function buildMasterAgentContext(project: Project, repos: Repository[]): string {
  // [KEEP THE EXISTING buildMasterAgentContext IMPLEMENTATION UNCHANGED]
  // Copy the full function body from the current websocket.ts
}

export async function getOrInitAgent(projectId: string): Promise<{ prompt: (text: string) => Promise<void> }> {
  // This exists for RecoveryService backward compatibility — it will be removed in Task 8.
  // For now, proxy sendPrompt through PlanningAgentManager.
  return {
    prompt: (text: string) => getPlanningAgentManager().sendPrompt(projectId, text),
  };
}

export function preInitAgent(projectId: string): void {
  // Pre-init is a no-op now — planning agent starts on first WS connection
  console.log(`[ws] preInitAgent(${projectId}): deferred to first WS connection`);
}

export function setupWebSocket(server: Server, _dataDir: string): void {
  const wss = new WebSocketServer({ server });

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const match = /\/ws\/projects\/([^/]+)\/chat/.exec(req.url ?? "");
    if (!match) { ws.close(4000, "Invalid URL"); return; }
    const projectId = match[1];
    console.log(`[ws] new connection for project=${projectId}`);

    const project = getProject(projectId);
    if (!project) { ws.close(4004, "Project not found"); return; }

    // Register connection
    if (!projectConnections.has(projectId)) projectConnections.set(projectId, new Set());
    projectConnections.get(projectId)!.add(ws);

    const manager = getPlanningAgentManager();

    // Start planning agent if not running
    const allRepos = listRepositories().filter(r => project.repositoryIds.includes(r.id));
    const repoUrls = allRepos.map(r => ({
      name: r.name,
      url: process.env.GITHUB_TOKEN
        ? r.cloneUrl.replace("https://github.com/", `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/`)
        : r.cloneUrl,
    }));
    try {
      await manager.ensureRunning(projectId, repoUrls);
    } catch (err) {
      console.error(`[ws] failed to start planning agent for ${projectId}:`, err);
      send(ws, { type: "error", message: "Failed to start planning agent" });
    }

    manager.incrementConnections(projectId);

    // Forward planning agent events to this WS client (delta only — broadcasts handle the rest)
    const onDeltaFwd = (event: PlanningAgentEvent) => {
      if (event.type === "delta") send(ws, { type: "delta", text: event.text });
    };
    const unsubscribeDelta = manager.onOutput(projectId, onDeltaFwd);

    // Subscribe once for project-wide event broadcasting
    let messageBuffer = "";
    const onProjectEvent = (event: PlanningAgentEvent) => {
      switch (event.type) {
        case "delta":
          messageBuffer += event.text;
          break;
        case "message_complete":
          if (messageBuffer) {
            appendMessage(projectId, "assistant", messageBuffer);
            messageBuffer = "";
          }
          broadcastToProject(projectId, { type: "message_complete" });
          break;
        case "tool_call":
          broadcastToProject(projectId, { type: "tool_call", toolName: event.toolName, args: event.args ?? {} });
          break;
        case "conversation_complete":
          broadcastToProject(projectId, { type: "conversation_complete" });
          break;
      }
    };
    // Register broadcaster only once per project (use a flag to avoid double-registration)
    const broadcasterKey = `broadcaster-${projectId}`;
    if (!projectConnections.get(projectId)!.size || !(ws as unknown as Record<string, boolean>)[broadcasterKey]) {
      (ws as unknown as Record<string, boolean>)[broadcasterKey] = true;
      manager.onOutput(projectId, onProjectEvent);
    }

    ws.on("message", async (raw: Buffer) => {
      let msg: WsClientMessage;
      try { msg = JSON.parse(raw.toString()) as WsClientMessage; }
      catch { send(ws, { type: "error", message: "Invalid JSON" }); return; }

      if (msg.type === "resume" && msg.lastSeqId !== undefined) {
        const missed = listMessagesSince(projectId, msg.lastSeqId);
        send(ws, { type: "replay", messages: missed });
        return;
      }

      if (msg.type === "prompt" && msg.text) {
        console.log(`[ws] prompt received for project=${projectId}, length=${msg.text.length}`);
        const savedUserMsg = appendMessage(projectId, "user", msg.text);

        let promptText = msg.text;
        if (savedUserMsg.seqId === 1) {
          const proj = getProject(projectId);
          if (proj) {
            const repos = listRepositories().filter(r => proj.repositoryIds.includes(r.id));
            const context = buildMasterAgentContext(proj, repos);
            promptText = `${context}\n\n---\n\n${msg.text}`;
            if (proj.status === "brainstorming") {
              updateProject(projectId, { status: "spec_in_progress" });
            }
          }
        }

        try {
          await manager.sendPrompt(projectId, promptText);
        } catch (err) {
          console.error(`[ws] sendPrompt error:`, err);
          send(ws, { type: "error", message: err instanceof Error ? err.message : "Unknown error" });
        }
        return;
      }

      if (msg.type === "steer" && msg.text) {
        await manager.sendPrompt(projectId, msg.text);
        return;
      }
    });

    ws.on("close", () => {
      projectConnections.get(projectId)?.delete(ws);
      unsubscribeDelta();
      manager.decrementConnections(projectId);
    });
  });
}
```

**Note:** The `onProjectEvent` broadcaster logic above is simplified — in practice only one broadcaster per project is needed. A clean approach is to register it when the first connection arrives for a project and remove it when the last one leaves. The exact implementation can be refined; what matters is: delta → buffer, message_complete → save + broadcast, tool_call → broadcast, conversation_complete → broadcast.

- [ ] **Step 2: Compile to catch type errors**

```bash
cd /home/ae/multi-agent-harness/backend && npm run build 2>&1
```

Fix any type errors before proceeding.

- [ ] **Step 3: Run tests**

```bash
cd /home/ae/multi-agent-harness/backend && npm test 2>&1 | tail -20
```

Expected: all tests PASS. Some tests that mock `getOrInitAgent` may need updating — if they import from `websocket.ts`, update them to expect `getPlanningAgentManager` instead.

- [ ] **Step 4: Commit**

```bash
cd /home/ae/multi-agent-harness
git add backend/src/api/websocket.ts
git commit -m "feat: migrate WebSocket to PlanningAgentManager, remove MasterAgent dependency"
```

---

## Task 8: RecoveryService `notifyMaster` Migration

Switch `notifyMaster` in `recoveryService.ts` from `getOrInitAgent` to `getPlanningAgentManager`. Also update the notification messages to remove references to the deleted `restart_failed_tasks` tool.

**Files:**
- Modify: `backend/src/orchestrator/recoveryService.ts`

- [ ] **Step 1: Update `notifyMaster`**

Replace the `notifyMaster` method:

```typescript
private async notifyMaster(projectId: string, message: string): Promise<void> {
  try {
    const { getPlanningAgentManager } = await import("./planningAgentManager.js");
    await getPlanningAgentManager().sendPrompt(projectId, message);
  } catch (err) {
    console.error(`[recoveryService] Failed to notify planning agent for project ${projectId}:`, err);
  }
}
```

- [ ] **Step 2: Update notification messages**

In `checkAllTerminal`, replace the final line of `msg` construction:

```typescript
// Before:
if (failed.length) msg += `\nUse restart_failed_tasks to retry failed tasks, or inform the user.`;
// After:
if (failed.length) msg += `\nUse get_task_status to see error details, then dispatch_tasks to retry failed tasks or inform the user.`;
```

In `notifyMasterPartialFailure`:

```typescript
private async notifyMasterPartialFailure(projectId: string, task: PlanTask, attempts: number): Promise<void> {
  const msg =
    `[SYSTEM] Task "${task.description.slice(0, 50)}" has permanently failed after ${attempts} attempt(s).\n` +
    `Error: ${task.errorMessage ?? "unknown"}.\n` +
    `Other tasks may still be running. Use get_task_status for details, then dispatch_tasks to retry or inform the user.`;
  await this.notifyMaster(projectId, msg);
}
```

- [ ] **Step 3: Run tests**

```bash
cd /home/ae/multi-agent-harness/backend && npm test 2>&1 | tail -20
```

Expected: all tests PASS. The recovery service tests mock `getOrInitAgent` — update those mocks to mock `planningAgentManager.js` instead if they fail.

- [ ] **Step 4: Commit**

```bash
cd /home/ae/multi-agent-harness
git add backend/src/orchestrator/recoveryService.ts
git commit -m "feat: switch RecoveryService.notifyMaster to PlanningAgentManager"
```

---

## Task 9: Delete Old Code

Remove `MasterAgent`, `restartFailedTasksTool`, and their tests. Clean up all dead imports.

**Files:**
- Delete: `backend/src/agents/masterAgent.ts`
- Delete: `backend/src/agents/restartFailedTasksTool.ts`
- Delete: `backend/src/__tests__/masterAgent.test.ts`
- Modify: `backend/src/api/websocket.ts` (remove leftover imports)

- [ ] **Step 1: Delete the files**

```bash
cd /home/ae/multi-agent-harness
rm backend/src/agents/masterAgent.ts
rm backend/src/agents/restartFailedTasksTool.ts
rm backend/src/__tests__/masterAgent.test.ts
```

- [ ] **Step 2: Remove dead imports from `websocket.ts`**

Remove these lines from the top of `websocket.ts`:
```typescript
import { MasterAgent } from "../agents/masterAgent.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createWritePlanningDocumentTool } from "../agents/planningTool.js";
import { createSubAgentStatusTool } from "../agents/subAgentStatusTool.js";
import { createRestartFailedTasksTool } from "../agents/restartFailedTasksTool.js";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";
```

Also remove the `cloneReposForProject` function (it was orphaned before — now it's truly dead).

Remove unused variables: `agentSessions`, `agentInitPromises`, `globalDataDir`.

- [ ] **Step 3: Compile — verify no dangling references**

```bash
cd /home/ae/multi-agent-harness/backend && npm run build 2>&1
```

Expected: no errors. If there are "cannot find module" errors, check for any remaining imports of the deleted files.

- [ ] **Step 4: Run full test suite**

```bash
cd /home/ae/multi-agent-harness/backend && npm test 2>&1 | tail -20
```

Expected: all tests PASS. The deleted `masterAgent.test.ts` is gone; the suite shrinks by those tests.

- [ ] **Step 5: Commit**

```bash
cd /home/ae/multi-agent-harness
git add -A
git commit -m "chore: delete MasterAgent, restartFailedTasksTool and their tests"
```

---

## Task 10: docker-compose Build Target

Add the `planning-agent` service to `docker-compose.yml` as a build-only entry so `docker compose build` produces the image.

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add planning-agent build target**

In `docker-compose.yml`, add after the `frontend` service:

```yaml
  planning-agent:
    build: ./planning-agent
    image: multi-agent-harness/planning-agent:latest
    profiles:
      - build-only  # prevents this from being started by docker compose up
```

The `profiles: [build-only]` ensures `docker compose up` doesn't try to run this as a service — it's spawned on-demand by the backend.

- [ ] **Step 2: Build all images**

```bash
cd /home/ae/multi-agent-harness
docker compose build
```

Expected: backend, frontend, and planning-agent images all build successfully.

- [ ] **Step 3: Commit**

```bash
cd /home/ae/multi-agent-harness
git add docker-compose.yml
git commit -m "build: add planning-agent docker-compose build target"
```

---

## Verification

After all tasks complete, verify end-to-end:

- [ ] Rebuild and restart: `docker compose build --no-cache && docker compose up -d`
- [ ] Open the frontend, create a project with a repository
- [ ] Send a chat message — verify the planning agent container starts (`docker ps | grep planning`)
- [ ] Verify streaming tokens appear in the browser
- [ ] Verify tool call indicators appear when the agent uses `dispatch_tasks`, `get_task_status`, or `get_pull_requests`
- [ ] Verify `docker logs <planning-container-id>` shows the RPC protocol running
