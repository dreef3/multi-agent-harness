import { describe, it, expect, vi, beforeEach } from "vitest";
import { MasterAgent } from "../agents/masterAgent.js";
import { EventEmitter } from "events";
import path from "path";
import os from "os";
import fs from "fs";

// Mock the pi-coding-agent SDK
const mockSession = new EventEmitter() as EventEmitter & {
  prompt: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  subscribe: (handler: (event: unknown) => void) => void;
};

mockSession.prompt = vi.fn().mockResolvedValue(undefined);
mockSession.steer = vi.fn().mockResolvedValue(undefined);
mockSession.dispose = vi.fn();
mockSession.subscribe = vi.fn((handler: (event: unknown) => void) => {
  // Store the handler so tests can trigger events
  (mockSession as unknown as { _handler: (event: unknown) => void })._handler = handler;
}) as unknown as (handler: (event: unknown) => void) => void;

const mockCreateAgentSession = vi.fn().mockResolvedValue({ session: mockSession });
const mockSessionManager = { create: vi.fn().mockReturnValue({ type: "file" }) };

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: mockCreateAgentSession,
  SessionManager: mockSessionManager,
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
    expect(mockCreateAgentSession).toHaveBeenCalledWith({
      sessionManager: { type: "file" },
    });
    agent.dispose();
  });

  it("emits delta events on text_delta", async () => {
    const agent = new MasterAgent("proj-1", sessionPath);
    await agent.init();
    const deltas: string[] = [];
    agent.on("delta", (text: string) => deltas.push(text));

    const handler = (mockSession as unknown as { _handler: (event: unknown) => void })._handler;
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

    const handler = (mockSession as unknown as { _handler: (event: unknown) => void })._handler;
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
    expect(mockSession.prompt).toHaveBeenCalledWith("test prompt");
    agent.dispose();
  });

  it("calls session.steer when steered", async () => {
    const agent = new MasterAgent("proj-1", sessionPath);
    await agent.init();
    await agent.steer("steer command");
    expect(mockSession.steer).toHaveBeenCalledWith("steer command");
    agent.dispose();
  });

  it("disposes session on dispose", async () => {
    const agent = new MasterAgent("proj-1", sessionPath);
    await agent.init();
    agent.dispose();
    expect(mockSession.dispose).toHaveBeenCalled();
  });
});
