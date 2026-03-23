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
