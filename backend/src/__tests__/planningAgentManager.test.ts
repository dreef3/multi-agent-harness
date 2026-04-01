import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock agentEvents so tests don't need a real DB
vi.mock("../store/agentEvents.js", () => ({
  appendEvent: vi.fn(),
  getEvents: vi.fn().mockReturnValue([]),
}));

// Mock config before importing the module under test
vi.mock("../config.js", () => ({
  config: {
    planningAgentImage: "multi-agent-harness/planning-agent:latest",
    subAgentNetwork: "multi-agent-harness_harness-agents",
    piAgentVolume: "harness-pi-auth",
  },
}));

// ── Mock net.Socket so tests don't make real TCP connections ──────────────────
// The module-level object is captured by reference by the mock factory,
// so each test can access the most recently created socket.
const netState: { lastSocket: MockSocket | null } = { lastSocket: null };

class MockSocket extends EventEmitter {
  write = vi.fn().mockReturnValue(true);
  destroy = vi.fn();
  destroyed = false;

  connect(_port: number, _host: string, callback: () => void) {
    netState.lastSocket = this;
    // Resolve asynchronously (mirrors real TCP behaviour)
    process.nextTick(callback);
    return this;
  }
}

vi.mock("net", () => ({ Socket: MockSocket }));

// ── ContainerRuntime mock helpers ─────────────────────────────────────────────

function makeMockRuntime(overrides: Record<string, unknown> = {}) {
  const runtime = {
    createContainer: vi.fn().mockResolvedValue("container-plan-123"),
    startContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue("running"),
    watchExit: vi.fn().mockResolvedValue(undefined),
    streamLogs: vi.fn().mockResolvedValue(undefined),
    listByLabel: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  return { docker: runtime, mockContainer: runtime };
}

// Keep alias for backward compatibility in tests
const makeMockDocker = makeMockRuntime;

// ── Container lifecycle tests ─────────────────────────────────────────────────

describe("PlanningAgentManager - container lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    netState.lastSocket = null;
  });

  it("starts a new container for a project and tracks it", async () => {
    const { docker, mockContainer } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);

    expect(mgr.isRunning("proj-1")).toBe(false);
    await mgr.ensureRunning("proj-1", []);
    expect(mgr.isRunning("proj-1")).toBe(true);
    expect(docker.startContainer).toHaveBeenCalled();
  });

  it("does not create a second container when one is already running", async () => {
    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);

    await mgr.ensureRunning("proj-1", []);
    await mgr.ensureRunning("proj-1", []);
    expect(docker.startContainer).toHaveBeenCalledTimes(1);
  });

  it("stops and deregisters the container on stopContainer", async () => {
    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);

    await mgr.ensureRunning("proj-1", []);
    expect(mgr.isRunning("proj-1")).toBe(true);

    await mgr.stopContainer("proj-1");
    expect(docker.stopContainer).toHaveBeenCalled();
    expect(mgr.isRunning("proj-1")).toBe(false);
  });

  it("reuses an existing container on backend restart", async () => {
    const { docker } = makeMockDocker();
    // Simulate existing container found via listByLabel
    docker.listByLabel = vi.fn().mockResolvedValue([{
      id: "container-plan-123",
      name: "planning-proj-2",
      status: "running",
    }]);
    docker.getStatus = vi.fn().mockResolvedValue("running");

    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);

    await mgr.ensureRunning("proj-2", []);
    // Should not create a new container — already exists
    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(mgr.isRunning("proj-2")).toBe(true);
  });
});

// ── Communication tests ───────────────────────────────────────────────────────

describe("PlanningAgentManager - communication", () => {
  beforeEach(() => {
    vi.resetModules();
    netState.lastSocket = null;
  });

  async function makeRunningManager() {
    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-1", []);
    // The TCP socket created during ensureRunning
    const tcpSocket = netState.lastSocket!;
    return { mgr, tcpSocket };
  }

  it("writes prompt JSON-RPC command to TCP socket", async () => {
    const { mgr, tcpSocket } = await makeRunningManager();
    await mgr.sendPrompt("proj-1", "Hello agent");
    expect(tcpSocket.write).toHaveBeenCalledWith(
      expect.stringContaining('"type":"prompt"')
    );
    expect(tcpSocket.write).toHaveBeenCalledWith(
      expect.stringContaining('"message":"Hello agent"')
    );
  });

  it("omits streamingBehavior when not streaming", async () => {
    const { mgr, tcpSocket } = await makeRunningManager();
    await mgr.sendPrompt("proj-1", "first");
    const call = (tcpSocket.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(call).not.toContain("streamingBehavior");
  });

  it("emits delta events when text_delta lines arrive on TCP socket", async () => {
    const { mgr, tcpSocket } = await makeRunningManager();
    const events: import("../orchestrator/planningAgentManager.js").PlanningAgentEvent[] = [];
    mgr.onOutput("proj-1", (e) => events.push(e));

    tcpSocket.emit("data", Buffer.from(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    }) + "\n"));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "delta", text: "Hello" });
  });

  it("emits tool_call event on tool_execution_start", async () => {
    const { mgr, tcpSocket } = await makeRunningManager();
    const events: import("../orchestrator/planningAgentManager.js").PlanningAgentEvent[] = [];
    mgr.onOutput("proj-1", (e) => events.push(e));

    tcpSocket.emit("data", Buffer.from(JSON.stringify({
      type: "tool_execution_start",
      toolName: "dispatch_tasks",
      args: { tasks: [] },
    }) + "\n"));

    expect(events[0]).toEqual({ type: "tool_call", toolName: "dispatch_tasks", args: { tasks: [] } });
  });

  it("emits message_complete on message_end", async () => {
    const { mgr, tcpSocket } = await makeRunningManager();
    const events: import("../orchestrator/planningAgentManager.js").PlanningAgentEvent[] = [];
    mgr.onOutput("proj-1", (e) => events.push(e));

    tcpSocket.emit("data", Buffer.from(JSON.stringify({ type: "message_end", message: {} }) + "\n"));
    expect(events[0]).toEqual({ type: "message_complete" });
  });

  it("emits conversation_complete on agent_end", async () => {
    const { mgr, tcpSocket } = await makeRunningManager();
    const events: import("../orchestrator/planningAgentManager.js").PlanningAgentEvent[] = [];
    mgr.onOutput("proj-1", (e) => events.push(e));

    tcpSocket.emit("data", Buffer.from(JSON.stringify({ type: "agent_end", messages: [] }) + "\n"));
    expect(events[0]).toEqual({ type: "conversation_complete" });
  });

  it("emits tool_result event on tool_execution_end", async () => {
    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-1", []);
    const socket = netState.lastSocket!;
    const events: import("../orchestrator/planningAgentManager.js").PlanningAgentEvent[] = [];
    mgr.onOutput("proj-1", (e) => events.push(e));
    socket.emit("data", Buffer.from(
      JSON.stringify({ type: "tool_execution_end", toolName: "bash", result: "ok", isError: false }) + "\n"
    ));
    expect(events).toEqual([{ type: "tool_result", toolName: "bash", result: "ok", isError: false }]);
  });

  it("emits thinking event on thinking_delta", async () => {
    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-2", []);
    const socket = netState.lastSocket!;
    const events: import("../orchestrator/planningAgentManager.js").PlanningAgentEvent[] = [];
    mgr.onOutput("proj-2", (e) => events.push(e));
    socket.emit("data", Buffer.from(
      JSON.stringify({ type: "thinking_delta", delta: "hmm..." }) + "\n"
    ));
    expect(events).toEqual([{ type: "thinking", text: "hmm..." }]);
  });
});

// ── injectMessage tests ───────────────────────────────────────────────────────

describe("PlanningAgentManager - injectMessage", () => {
  beforeEach(() => {
    vi.resetModules();
    netState.lastSocket = null;
  });

  it("injectMessage writes a prompt to the TCP socket", async () => {
    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-inject", []);
    const socket = netState.lastSocket!;
    socket.write.mockClear();
    await mgr.injectMessage("proj-inject", "[Sub-agent: Task A] asks: Is this right?");
    expect(socket.write).toHaveBeenCalledOnce();
    const written = JSON.parse((socket.write.mock.calls[0][0] as string).trim());
    expect(written).toMatchObject({ type: "prompt", message: "[Sub-agent: Task A] asks: Is this right?" });
  });

  it("injectMessage restarts container when project has no running container", async () => {
    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    
    // Mock getProject and listRepositories for the restart logic
    vi.doMock("../store/projects.js", () => ({
      getProject: vi.fn().mockReturnValue({ id: "proj-1", repositoryIds: [] }),
    }));
    vi.doMock("../store/repositories.js", () => ({
      listRepositories: vi.fn().mockReturnValue([]),
    }));

    await mgr.injectMessage("proj-1", "hello");
    expect(docker.createContainer).toHaveBeenCalled();
  });
});

// ── commitSessionLog tests ─────────────────────────────────────────────────────

describe("PlanningAgentManager - commitSessionLog", () => {
  beforeEach(() => {
    vi.resetModules();
    netState.lastSocket = null;
  });

  it("commits session log to GitHub on stopContainer", async () => {
    const mockCommitFile = vi.fn().mockResolvedValue(undefined);
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue("line1\nline2\n"),
    }));
    vi.doMock("../store/projects.js", () => ({
      getProject: vi.fn().mockReturnValue({
        id: "proj-1",
        primaryRepositoryId: "repo-1",
      }),
    }));
    vi.doMock("../store/repositories.js", () => ({
      getRepository: vi.fn().mockReturnValue({
        id: "repo-1",
        name: "my-repo",
        provider: "github",
        cloneUrl: "https://github.com/org/my-repo.git",
        defaultBranch: "main",
        providerConfig: { owner: "org", repo: "my-repo" },
      }),
    }));
    vi.doMock("../connectors/github.js", () => ({
      GitHubConnector: vi.fn().mockImplementation(function () {
        return { commitFile: mockCommitFile };
      }),
    }));

    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-1", []);
    await mgr.stopContainer("proj-1");

    expect(mockCommitFile).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "github" }),
      "main",
      ".harness/logs/planning-agent/proj-1.jsonl",
      "line1\nline2\n",
      "chore: save planning agent session log [proj-1]"
    );
    expect(docker.stopContainer).toHaveBeenCalled();
  });

  it("skips commit when session file does not exist (ENOENT)", async () => {
    const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
    const mockCommitFile = vi.fn();
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(enoent),
    }));
    vi.doMock("../store/projects.js", () => ({
      getProject: vi.fn().mockReturnValue({ id: "proj-1", primaryRepositoryId: "repo-1" }),
    }));
    vi.doMock("../store/repositories.js", () => ({
      getRepository: vi.fn().mockReturnValue({
        id: "repo-1", provider: "github", defaultBranch: "main",
        providerConfig: { owner: "org", repo: "r" },
      }),
    }));
    vi.doMock("../connectors/github.js", () => ({
      GitHubConnector: vi.fn().mockImplementation(function () {
        return { commitFile: mockCommitFile };
      }),
    }));

    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-1", []);
    await mgr.stopContainer("proj-1");

    expect(mockCommitFile).not.toHaveBeenCalled();
  });

  it("skips commit when primary repo is not GitHub", async () => {
    const mockCommitFile = vi.fn();
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue("content"),
    }));
    vi.doMock("../store/projects.js", () => ({
      getProject: vi.fn().mockReturnValue({ id: "proj-1", primaryRepositoryId: "repo-1" }),
    }));
    vi.doMock("../store/repositories.js", () => ({
      getRepository: vi.fn().mockReturnValue({
        id: "repo-1", provider: "bitbucket-server", defaultBranch: "main",
        providerConfig: {},
      }),
    }));
    vi.doMock("../connectors/github.js", () => ({
      GitHubConnector: vi.fn().mockImplementation(function () {
        return { commitFile: mockCommitFile };
      }),
    }));

    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-1", []);
    await mgr.stopContainer("proj-1");

    expect(mockCommitFile).not.toHaveBeenCalled();
  });

  it("does not throw when commitFile fails — logs warning only", async () => {
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue("content"),
    }));
    vi.doMock("../store/projects.js", () => ({
      getProject: vi.fn().mockReturnValue({ id: "proj-1", primaryRepositoryId: "repo-1" }),
    }));
    vi.doMock("../store/repositories.js", () => ({
      getRepository: vi.fn().mockReturnValue({
        id: "repo-1", provider: "github", defaultBranch: "main",
        providerConfig: { owner: "org", repo: "r" },
      }),
    }));
    vi.doMock("../connectors/github.js", () => ({
      GitHubConnector: vi.fn().mockImplementation(function () {
        return { commitFile: vi.fn().mockRejectedValue(new Error("API rate limit")) };
      }),
    }));

    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-1", []);
    // Should not throw
    await expect(mgr.stopContainer("proj-1")).resolves.toBeUndefined();
  });
});

describe("PlanningAgentManager - lifecycle grace period", () => {
  beforeEach(() => {
    vi.resetModules();
    netState.lastSocket = null;
  });

  it("does not stop container immediately when last WS connection drops", async () => {
    vi.useFakeTimers();
    try {
      const { docker } = makeMockDocker();
      const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
      const mgr = new PlanningAgentManager(docker as never);
      await mgr.ensureRunning("proj-grace", []);
      mgr.incrementConnections("proj-grace");
      mgr.decrementConnections("proj-grace"); // last connection drops

      // Not stopped yet — grace timer still running
      expect(docker.stopContainer).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops container after 2-minute grace period elapses", async () => {
    vi.useFakeTimers();
    try {
      const { docker } = makeMockDocker();
      const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
      const mgr = new PlanningAgentManager(docker as never);
      await mgr.ensureRunning("proj-timer", []);
      mgr.incrementConnections("proj-timer");
      mgr.decrementConnections("proj-timer");

      // Advance past the 120 s grace period
      await vi.advanceTimersByTimeAsync(121_000);

      expect(docker.stopContainer).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels stop timer when new connection arrives during grace period", async () => {
    vi.useFakeTimers();
    try {
      const { docker } = makeMockDocker();
      const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
      const mgr = new PlanningAgentManager(docker as never);
      await mgr.ensureRunning("proj-cancel", []);
      mgr.incrementConnections("proj-cancel");
      mgr.decrementConnections("proj-cancel"); // grace timer starts

      mgr.incrementConnections("proj-cancel"); // new connection — should cancel timer
      await vi.advanceTimersByTimeAsync(121_000);

      expect(docker.stopContainer).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── OTEL metrics tests ────────────────────────────────────────────────────────

describe("PlanningAgentManager - OTEL metrics", () => {
  beforeEach(() => {
    vi.resetModules();
    netState.lastSocket = null;
  });

  it("calls toolCallCounter.add on tool_execution_start and toolCallDuration.record on tool_execution_end", async () => {
    const mockAdd = vi.fn();
    const mockRecord = vi.fn();

    const mockSpan = { end: vi.fn(), setStatus: vi.fn(), setAttribute: vi.fn(), setAttributes: vi.fn() };
    vi.doMock("../telemetry.js", () => ({
      tracer: {
        startActiveSpan: vi.fn((_n: string, fn: (s: typeof mockSpan) => unknown) => fn(mockSpan)),
        startSpan: vi.fn().mockReturnValue(mockSpan),
      },
      meter: {
        createCounter: vi.fn().mockReturnValue({ add: mockAdd }),
        createHistogram: vi.fn().mockReturnValue({ record: mockRecord }),
      },
    }));

    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-metrics", []);
    const socket = netState.lastSocket!;

    // Emit tool_execution_start
    socket.emit("data", Buffer.from(
      JSON.stringify({ type: "tool_execution_start", toolName: "bash", toolCallId: "call-1", args: {} }) + "\n"
    ));

    expect(mockAdd).toHaveBeenCalledWith(1, { "tool.name": "bash", "project.id": "proj-metrics" });

    // Emit tool_execution_end with matching toolCallId
    socket.emit("data", Buffer.from(
      JSON.stringify({ type: "tool_execution_end", toolName: "bash", toolCallId: "call-1", result: "ok", isError: false }) + "\n"
    ));

    expect(mockRecord).toHaveBeenCalledWith(
      expect.any(Number),
      { "tool.name": "bash", "project.id": "proj-metrics" }
    );
  });
});

describe("PlanningAgentManager - docker cleanup", () => {
  beforeEach(() => {
    vi.resetModules();
    netState.lastSocket = null;
  });

  it("removes container after stopping", async () => {
    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-remove", []);
    await mgr.stopContainer("proj-remove");

    expect(docker.stopContainer).toHaveBeenCalled();
    expect(docker.removeContainer).toHaveBeenCalled();
  });

  it("cleanupStaleContainers removes stopped planning- and sub- containers", async () => {
    const { docker } = makeMockDocker();
    vi.mocked(docker.listByLabel).mockResolvedValue([
      { id: "aaa", name: "planning-proj-1", status: "exited" },
      { id: "bbb", name: "sub-abc12345678", status: "exited" },
      { id: "ccc", name: "planning-proj-2", status: "running" }, // skip — running
      { id: "ddd", name: "other-container", status: "exited" }, // skip — not ours
    ]);

    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.cleanupStaleContainers();

    // Only aaa and bbb removed (planning-proj-1 and sub-abc12345678 are stopped harness containers)
    expect(docker.removeContainer).toHaveBeenCalledTimes(2);
  });

  it("cleanupStaleContainers is non-fatal when removal fails", async () => {
    const { docker } = makeMockDocker();
    vi.mocked(docker.listByLabel).mockResolvedValue([
      { id: "aaa", name: "planning-fail", status: "exited" },
    ]);
    docker.removeContainer = vi.fn().mockRejectedValue(new Error("no such container"));

    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);

    // Must not throw
    await expect(mgr.cleanupStaleContainers()).resolves.not.toThrow();
  });
});

describe("PlanningAgentManager - event persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    netState.lastSocket = null;
  });

  it("persists planning agent events to DB via appendEvent so history survives restart", async () => {
    const { appendEvent } = await import("../store/agentEvents.js");
    const mockAppend = vi.mocked(appendEvent);
    mockAppend.mockClear();

    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-persist", []);
    const socket = netState.lastSocket!;

    socket.emit("data", Buffer.from(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } }) + "\n"
    ));
    socket.emit("data", Buffer.from(
      JSON.stringify({ type: "tool_execution_start", toolName: "bash", toolCallId: "c1", args: {} }) + "\n"
    ));

    expect(mockAppend).toHaveBeenCalledWith(
      "master-proj-persist",
      expect.objectContaining({ type: "delta", payload: expect.objectContaining({ text: "hello" }) })
    );
    expect(mockAppend).toHaveBeenCalledWith(
      "master-proj-persist",
      expect.objectContaining({ type: "tool_call", payload: expect.objectContaining({ toolName: "bash" }) })
    );
  });
});
