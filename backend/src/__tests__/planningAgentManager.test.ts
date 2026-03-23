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

  it("omits streamingBehavior when not streaming", async () => {
    const { mgr, mockAttachStream } = await makeRunningManager();
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
