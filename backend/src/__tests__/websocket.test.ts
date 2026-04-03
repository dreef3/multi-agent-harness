/**
 * Tests for WebSocket message persistence.
 * Verifies that user prompts and assistant responses are saved to the DB,
 * so that loadMessages() on the frontend returns them after each turn_complete.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer } from "http";
import { EventEmitter } from "events";
import WS from "ws";
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { initDb } from "../store/db.js";
import { insertProject, updateProject } from "../store/projects.js";
import { listMessages } from "../store/messages.js";
import { setupWebSocket } from "../api/websocket.js";
import type { Project } from "../models/types.js";

// ── Mock AcpAgentManager ────────────────────────────────────────────────────

class MockManager extends EventEmitter {
  ensureRunning = vi.fn().mockResolvedValue(undefined);
  isRunning = vi.fn().mockReturnValue(false);
  incrementConnections = vi.fn();
  decrementConnections = vi.fn();
  sendPrompt = vi.fn().mockResolvedValue(undefined);
}

let mockManager: MockManager;

vi.mock("../orchestrator/acpAgentManager.js", () => ({
  getAcpAgentManager: () => mockManager,
}));

vi.mock("../store/repositories.js", () => ({
  listRepositories: () => [],
}));

vi.mock("../store/projects.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/projects.js")>();
  return {
    ...actual,
    updateProject: vi.fn(),
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function waitForWsMessage(
  ws: WS,
  predicate: (data: Record<string, unknown>) => boolean,
  timeoutMs = 2000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitForWsMessage timed out")), timeoutMs);
    function handler(raw: WS.RawData) {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    }
    ws.on("message", handler);
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Shared server setup ───────────────────────────────────────────────────────

describe("WebSocket message persistence", () => {
  let tmpDir: string;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    mockManager = new MockManager();
    vi.mocked(updateProject).mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ws-test-"));
    await initDb(tmpDir);

    server = createServer();
    setupWebSocket(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Each test uses its own unique projectId to avoid cross-test broadcaster contamination
  // (projectBroadcasters is module-level state)
  async function makeProject(status: Project["status"] = "brainstorming"): Promise<{ projectId: string; project: Project }> {
    const projectId = randomUUID();
    const project: Project = {
      id: projectId,
      name: "WS Test Project",
      status,
      source: { type: "freeform", freeformDescription: "test" },
      repositoryIds: [],
      masterSessionPath: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await insertProject(project);
    return { projectId, project };
  }

  async function connectWs(projectId: string): Promise<WS> {
    const ws = new WS(`ws://127.0.0.1:${port}/ws?projectId=${projectId}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return ws;
  }

  it("persists user message to DB when prompt is sent", async () => {
    const { projectId } = await makeProject();
    const ws = await connectWs(projectId);
    ws.send(JSON.stringify({ type: "prompt", text: "Fix the build please" }));
    await sleep(50);
    ws.close();

    const msgs = await listMessages(projectId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("Fix the build please");
  });

  it("persists assistant message to DB after streaming completes", async () => {
    const { projectId } = await makeProject();
    const agentId = "planning-" + projectId;
    const ws = await connectWs(projectId);
    ws.send(JSON.stringify({ type: "prompt", text: "Hello" }));
    await sleep(20);

    mockManager.emit(agentId, { type: "acp:agent_message_chunk", agentId, content: "Hello " });
    mockManager.emit(agentId, { type: "acp:agent_message_chunk", agentId, content: "world!" });
    const mcPromise = waitForWsMessage(ws, (m) => m.type === "acp:turn_complete");
    mockManager.emit(agentId, { type: "acp:turn_complete", agentId, stopReason: "end_turn" });
    await mcPromise;
    ws.close();
    await sleep(20);

    const msgs = await listMessages(projectId);
    const assistant = msgs.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe("Hello world!");
  });

  it("accumulates multiple deltas into a single assistant message", async () => {
    const { projectId } = await makeProject();
    const agentId = "planning-" + projectId;
    const ws = await connectWs(projectId);
    ws.send(JSON.stringify({ type: "prompt", text: "Go" }));
    await sleep(20);

    for (const chunk of ["The ", "answer ", "is ", "42."]) {
      mockManager.emit(agentId, { type: "acp:agent_message_chunk", agentId, content: chunk });
    }
    const mcPromise = waitForWsMessage(ws, (m) => m.type === "acp:turn_complete");
    mockManager.emit(agentId, { type: "acp:turn_complete", agentId, stopReason: "end_turn" });
    await mcPromise;
    ws.close();
    await sleep(20);

    const msgs = await listMessages(projectId);
    const assistant = msgs.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe("The answer is 42.");
  });

  it("saves separate assistant messages for each turn_complete", async () => {
    const { projectId } = await makeProject();
    const agentId = "planning-" + projectId;
    const ws = await connectWs(projectId);
    ws.send(JSON.stringify({ type: "prompt", text: "Multi-turn" }));
    await sleep(20);

    // First assistant turn
    mockManager.emit(agentId, { type: "acp:agent_message_chunk", agentId, content: "First response." });
    const mc1 = waitForWsMessage(ws, (m) => m.type === "acp:turn_complete");
    mockManager.emit(agentId, { type: "acp:turn_complete", agentId, stopReason: "end_turn" });
    await mc1;

    // Second assistant turn
    mockManager.emit(agentId, { type: "acp:agent_message_chunk", agentId, content: "Second response." });
    const mc2 = waitForWsMessage(ws, (m) => m.type === "acp:turn_complete");
    mockManager.emit(agentId, { type: "acp:turn_complete", agentId, stopReason: "end_turn" });
    await mc2;

    ws.close();
    await sleep(20);

    const msgs = await listMessages(projectId);
    const assistant = msgs.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(2);
    expect(assistant[0].content).toBe("First response.");
    expect(assistant[1].content).toBe("Second response.");
  });

  it("buffers messages sent before container is ready and replays them after startup", async () => {
    const { projectId } = await makeProject();

    // Simulate slow container startup — ensureRunning resolves after 50ms
    let resolveEnsure!: () => void;
    const ensurePromise = new Promise<void>((resolve) => { resolveEnsure = resolve; });
    mockManager.ensureRunning.mockReturnValueOnce(ensurePromise);

    // Connect but don't await the full "open + message" cycle yet
    const ws = new WS(`ws://127.0.0.1:${port}/ws?projectId=${projectId}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    // Send prompt immediately after WS opens — container still starting
    ws.send(JSON.stringify({ type: "prompt", text: "Early message" }));

    // Now let the container "start"
    await sleep(10);
    resolveEnsure();

    // Give the server time to process the buffered message
    await sleep(50);
    ws.close();

    expect(mockManager.sendPrompt).toHaveBeenCalledOnce();
    // sendPrompt is called with (planningAgentId, contextPlusMessage)
    expect(mockManager.sendPrompt.mock.calls[0][0]).toBe("planning-" + projectId);
    expect(mockManager.sendPrompt.mock.calls[0][1]).toContain("Early message");

    const msgs = await listMessages(projectId);
    const user = msgs.filter((m) => m.role === "user");
    expect(user).toHaveLength(1);
    expect(user[0].content).toBe("Early message");
  });

  it("does not save empty assistant message when no chunks precede turn_complete", async () => {
    const { projectId } = await makeProject();
    const agentId = "planning-" + projectId;
    const ws = await connectWs(projectId);
    ws.send(JSON.stringify({ type: "prompt", text: "Go" }));
    await sleep(20);

    // turn_complete with no preceding chunk (tool-only turn)
    const mcPromise = waitForWsMessage(ws, (m) => m.type === "acp:turn_complete");
    mockManager.emit(agentId, { type: "acp:turn_complete", agentId, stopReason: "end_turn" });
    await mcPromise;
    ws.close();
    await sleep(20);

    const msgs = await listMessages(projectId);
    const assistant = msgs.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(0);
  });

  it("reactivates a completed project to executing when user sends a prompt", async () => {
    const { projectId } = await makeProject("completed");
    const ws = await connectWs(projectId);

    ws.send(JSON.stringify({ type: "prompt", text: "What changed?" }));
    await sleep(50);
    ws.close();

    expect(vi.mocked(updateProject)).toHaveBeenCalledWith(projectId, { status: "executing" });
  });

  it("does not reactivate a project that is already executing on user prompt", async () => {
    const { projectId } = await makeProject("executing");
    const ws = await connectWs(projectId);

    ws.send(JSON.stringify({ type: "prompt", text: "Go" }));
    await sleep(50);
    ws.close();

    expect(vi.mocked(updateProject)).not.toHaveBeenCalled();
  });

  it("does not reactivate on steer or resume messages", async () => {
    const { projectId } = await makeProject("completed");
    const ws = await connectWs(projectId);

    ws.send(JSON.stringify({ type: "steer", text: "Actually, stop" }));
    ws.send(JSON.stringify({ type: "resume", lastSeqId: 0 }));
    await sleep(50);
    ws.close();

    expect(vi.mocked(updateProject)).not.toHaveBeenCalled();
  });
});
