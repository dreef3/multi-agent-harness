import { describe, it, expect, vi, beforeEach } from "vitest";
import { MasterAgent } from "../agents/masterAgent.js";
import path from "path";
import os from "os";
import fs from "fs";

const mocks = vi.hoisted(() => {
  let capturedHandler: ((event: unknown) => void) | undefined;
  const mockSession = {
    prompt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn((handler: (event: unknown) => void) => {
      capturedHandler = handler;
    }),
    get _handler() { return capturedHandler; },
  };
  const mockCreateAgentSession = vi.fn().mockResolvedValue({ session: mockSession });
  const mockSessionManager = { create: vi.fn().mockReturnValue({ type: "file" }) };
  const mockSettingsManagerInstance = { type: "in-memory" };
  const mockSettingsManager = { inMemory: vi.fn().mockReturnValue(mockSettingsManagerInstance) };
  const mockResourceLoaderInstance = { 
    type: "resource-loader",
    reload: vi.fn().mockResolvedValue(undefined),
  };
  const MockDefaultResourceLoader = vi.fn().mockImplementation(() => mockResourceLoaderInstance);
  const mockAuthStorageInstance = { type: "auth-storage" };
  const mockAuthStorage = { create: vi.fn().mockReturnValue(mockAuthStorageInstance) };
  const mockModelInstance = { id: "minimax-m2.7", provider: "opencode-go" };
  const mockModelRegistryInstance = { find: vi.fn().mockReturnValue(mockModelInstance) };
  const MockModelRegistry = vi.fn().mockImplementation(() => mockModelRegistryInstance);
  return {
    mockSession, mockCreateAgentSession, mockSessionManager,
    mockSettingsManager, MockDefaultResourceLoader, mockResourceLoaderInstance,
    mockAuthStorage, MockModelRegistry, mockModelRegistryInstance, mockModelInstance,
  };
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: mocks.mockCreateAgentSession,
  SessionManager: mocks.mockSessionManager,
  SettingsManager: mocks.mockSettingsManager,
  DefaultResourceLoader: mocks.MockDefaultResourceLoader,
  AuthStorage: mocks.mockAuthStorage,
  ModelRegistry: mocks.MockModelRegistry,
}));

describe("MasterAgent", () => {
  let tempDir: string;
  let sessionPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "master-agent-test-"));
    sessionPath = path.join(tempDir, "master.jsonl");
    vi.clearAllMocks();
  });

  it("initializes successfully", async () => {
    const agent = new MasterAgent("proj-1", sessionPath);
    await agent.init();
    expect(mocks.mockCreateAgentSession).toHaveBeenCalledWith({
      sessionManager: { type: "file" },
      settingsManager: { type: "in-memory" },
      resourceLoader: mocks.mockResourceLoaderInstance,
      modelRegistry: mocks.mockModelRegistryInstance,
      model: mocks.mockModelInstance,
    });
    agent.dispose();
  });

  it("emits delta events on text_delta", async () => {
    const agent = new MasterAgent("proj-1", sessionPath);
    await agent.init();
    const deltas: string[] = [];
    agent.on("delta", (text: string) => deltas.push(text));

    const handler = mocks.mockSession._handler!;
    handler({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello " },
    });
    handler({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "World" },
    });

    expect(deltas).toEqual(["Hello ", "World"]);
    agent.dispose();
  });

  it("emits message_complete on message_stop", async () => {
    const agent = new MasterAgent("proj-1", sessionPath);
    await agent.init();
    let completed = false;
    agent.on("message_complete", () => { completed = true; });

    const handler = mocks.mockSession._handler!;
    handler({
      type: "message_update",
      assistantMessageEvent: { type: "message_stop" },
    });

    expect(completed).toBe(true);
    agent.dispose();
  });

  it("throws on prompt before init", async () => {
    const agent = new MasterAgent("proj-1", sessionPath);
    await expect(agent.prompt("hello")).rejects.toThrow("MasterAgent not initialized");
  });

  it("throws on steer before init", async () => {
    const agent = new MasterAgent("proj-1", sessionPath);
    await expect(agent.steer("steer text")).rejects.toThrow("MasterAgent not initialized");
  });

  it("calls session.prompt when prompted", async () => {
    const agent = new MasterAgent("proj-1", sessionPath);
    await agent.init();
    await agent.prompt("test prompt");
    expect(mocks.mockSession.prompt).toHaveBeenCalledWith("test prompt");
    agent.dispose();
  });

  it("calls session.steer when steered", async () => {
    const agent = new MasterAgent("proj-1", sessionPath);
    await agent.init();
    await agent.steer("steer command");
    expect(mocks.mockSession.steer).toHaveBeenCalledWith("steer command");
    agent.dispose();
  });

  it("emits tool_call on tool_execution_start", async () => {
    const agent = new MasterAgent("proj-1", sessionPath);
    await agent.init();
    const calls: { toolName: string; args: unknown }[] = [];
    agent.on("tool_call", (toolName: string, args: unknown) => calls.push({ toolName, args }));

    const handler = mocks.mockSession._handler!;
    handler({ type: "tool_execution_start", toolCallId: "tc1", toolName: "write_planning_document", args: { type: "spec" } });
    handler({ type: "tool_execution_start", toolCallId: "tc2", toolName: "Bash", args: { command: "ls" } });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ toolName: "write_planning_document", args: { type: "spec" } });
    expect(calls[1]).toEqual({ toolName: "Bash", args: { command: "ls" } });
    agent.dispose();
  });

  it("emits message_complete per turn then prompt resolves", async () => {
    const agent = new MasterAgent("proj-1", sessionPath);
    await agent.init();
    const completions: number[] = [];
    agent.on("message_complete", () => completions.push(Date.now()));

    const handler = mocks.mockSession._handler!;
    // Simulate two text turns separated by a tool call
    handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "turn 1" } });
    handler({ type: "message_update", assistantMessageEvent: { type: "message_stop" } });
    handler({ type: "tool_execution_start", toolCallId: "tc1", toolName: "Bash", args: {} });
    handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "turn 2" } });
    handler({ type: "message_update", assistantMessageEvent: { type: "message_stop" } });

    expect(completions).toHaveLength(2);
    agent.dispose();
  });

  it("disposes session on dispose", async () => {
    const agent = new MasterAgent("proj-1", sessionPath);
    await agent.init();
    agent.dispose();
    expect(mocks.mockSession.dispose).toHaveBeenCalled();
  });
});
