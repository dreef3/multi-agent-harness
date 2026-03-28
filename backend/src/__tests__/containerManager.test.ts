import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSubAgentContainer, startContainer, getContainerStatus } from "../orchestrator/containerManager.js";

describe("imageBuilder", () => {
  beforeEach(() => { vi.resetModules(); });

  it("resolves if image already exists", async () => {
    const mockInspect = vi.fn().mockResolvedValue({});
    const mockDocker = { getImage: vi.fn().mockReturnValue({ inspect: mockInspect }) };
    const { ensureSubAgentImage } = await import("../orchestrator/imageBuilder.js");
    await expect(ensureSubAgentImage(mockDocker as never, "test-image:latest")).resolves.toBeUndefined();
    expect(mockInspect).toHaveBeenCalled();
  });

  it("throws if image does not exist", async () => {
    const mockInspect = vi.fn().mockRejectedValue(new Error("No such image"));
    const mockDocker = { getImage: vi.fn().mockReturnValue({ inspect: mockInspect }) };
    const { ensureSubAgentImage } = await import("../orchestrator/imageBuilder.js");
    await expect(ensureSubAgentImage(mockDocker as never, "test-image:latest")).rejects.toThrow("test-image:latest");
  });
});

describe("containerManager", () => {
  it("creates container with correct env and binds", async () => {
    const mockCreate = vi.fn().mockResolvedValue({ id: "container-abc" });
    const mockDocker = { createContainer: mockCreate };
    const id = await createSubAgentContainer(mockDocker as never, {
      sessionId: "sess-1", repoCloneUrl: "https://github.com/org/repo.git",
      branchName: "agent/proj-1/task-1",
    });
    expect(id).toBe("container-abc");
    const callArg = mockCreate.mock.calls[0][0] as { Env: string[]; HostConfig: { Binds: string[] } };
    expect(callArg.Env).toContain("REPO_CLONE_URL=https://github.com/org/repo.git");
    expect(callArg.HostConfig.Binds.some((b: string) => b.endsWith(":/pi-agent"))).toBe(true);
  });

  it("starts a container", async () => {
    const mockStart = vi.fn().mockResolvedValue(undefined);
    const mockDocker = { getContainer: vi.fn().mockReturnValue({ start: mockStart }) };
    await startContainer(mockDocker as never, "container-abc");
    expect(mockStart).toHaveBeenCalled();
  });

  it("reports running status", async () => {
    const mockDocker = { getContainer: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({ State: { Status: "running" } }) }) };
    expect(await getContainerStatus(mockDocker as never, "abc")).toBe("running");
  });

  it("reports unknown for missing container", async () => {
    const mockDocker = { getContainer: vi.fn().mockReturnValue({ inspect: vi.fn().mockRejectedValue(new Error("No such container")) }) };
    expect(await getContainerStatus(mockDocker as never, "abc")).toBe("unknown");
  });

  it("includes CapDrop ALL and SecurityOpt no-new-privileges in HostConfig", async () => {
    const mockCreate = vi.fn().mockResolvedValue({ id: "container-secure" });
    await createSubAgentContainer({ createContainer: mockCreate } as never, {
      sessionId: "sess-sec",
      repoCloneUrl: "https://github.com/org/repo.git",
      branchName: "agent/proj-1/task-sec",
    });
    const hostConfig = mockCreate.mock.calls[0][0].HostConfig as {
      CapDrop: string[];
      SecurityOpt: string[];
    };
    expect(hostConfig.CapDrop).toEqual(["ALL"]);
    expect(hostConfig.SecurityOpt).toContain("no-new-privileges:true");
  });

  it("does not set ReadonlyRootfs when SUB_AGENT_READONLY_ROOTFS is not set", async () => {
    delete process.env.SUB_AGENT_READONLY_ROOTFS;
    vi.resetModules();
    const { createSubAgentContainer: createFresh } = await import("../orchestrator/containerManager.js");
    const mockCreate = vi.fn().mockResolvedValue({ id: "container-rw" });
    await createFresh({ createContainer: mockCreate } as never, {
      sessionId: "sess-rw",
      repoCloneUrl: "https://github.com/org/repo.git",
      branchName: "agent/task-rw",
    });
    const hostConfig = mockCreate.mock.calls[0][0].HostConfig;
    expect(hostConfig.ReadonlyRootfs).toBeUndefined();
    expect(hostConfig.Tmpfs).toBeUndefined();
  });

  it("sets ReadonlyRootfs and Tmpfs when SUB_AGENT_READONLY_ROOTFS=true", async () => {
    process.env.SUB_AGENT_READONLY_ROOTFS = "true";
    vi.resetModules();
    const { createSubAgentContainer: createFresh } = await import("../orchestrator/containerManager.js");
    const mockCreate = vi.fn().mockResolvedValue({ id: "container-ro" });
    await createFresh({ createContainer: mockCreate } as never, {
      sessionId: "sess-ro",
      repoCloneUrl: "https://github.com/org/repo.git",
      branchName: "agent/task-ro",
    });
    const hostConfig = mockCreate.mock.calls[0][0].HostConfig;
    expect(hostConfig.ReadonlyRootfs).toBe(true);
    expect(hostConfig.Tmpfs).toMatchObject({
      "/tmp": expect.stringContaining("rw"),
      "/workspace": expect.stringContaining("rw"),
    });
    delete process.env.SUB_AGENT_READONLY_ROOTFS;
  });
});
