import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

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

// ── Docker mock helpers ───────────────────────────────────────────────────────

function makeMockDocker(overrides: Record<string, unknown> = {}) {
  const mockContainer = {
    id: "container-plan-123",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    // Attach is only used for stderr logging; return a minimal stream
    attach: vi.fn().mockImplementation((_opts: unknown, cb: (err: null, stream: EventEmitter) => void) => {
      const stream = new EventEmitter();
      cb(null, stream);
    }),
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
  };
}

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
    mockContainer.id = "container-plan-123";
    docker.getContainer = vi.fn().mockReturnValue(mockContainer);

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
    mgr.injectMessage("proj-inject", "[Sub-agent: Task A] asks: Is this right?");
    expect(socket.write).toHaveBeenCalledOnce();
    const written = JSON.parse((socket.write.mock.calls[0][0] as string).trim());
    expect(written).toMatchObject({ type: "prompt", message: "[Sub-agent: Task A] asks: Is this right?" });
  });

  it("injectMessage is a no-op and warns when project has no running container", async () => {
    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mgr.injectMessage("nonexistent", "hello");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
