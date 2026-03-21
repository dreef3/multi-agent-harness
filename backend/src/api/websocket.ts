import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage, Server } from "http";
import { randomUUID } from "crypto";
import { MasterAgent } from "../agents/masterAgent.js";
import { getProject, updateProject } from "../store/projects.js";
import { appendMessage, listMessagesSince } from "../store/messages.js";
import { parsePlan } from "../agents/planParser.js";
import { listRepositories } from "../store/repositories.js";
import path from "path";
import fs from "fs";

const agentSessions = new Map<string, MasterAgent>();
const agentInitPromises = new Map<string, Promise<MasterAgent>>();
let globalDataDir = "";

async function getOrInitAgent(projectId: string): Promise<MasterAgent> {
  const existing = agentSessions.get(projectId);
  if (existing) return existing;

  const existingPromise = agentInitPromises.get(projectId);
  if (existingPromise) return existingPromise;

  const promise = (async () => {
    const sessionDir = path.join(globalDataDir, "sessions", projectId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "master.jsonl");
    const agent = new MasterAgent(projectId, sessionPath);
    await agent.init();
    agentSessions.set(projectId, agent);
    agentInitPromises.delete(projectId);
    return agent;
  })();

  agentInitPromises.set(projectId, promise);
  return promise;
}

export function preInitAgent(projectId: string): void {
  if (agentSessions.has(projectId) || agentInitPromises.has(projectId)) return;
  getOrInitAgent(projectId).catch((err) => {
    console.error(`[preInitAgent] Failed to init agent for ${projectId}:`, err);
  });
}

interface WsClientMessage { type: "prompt" | "steer" | "resume"; text?: string; lastSeqId?: number; }
interface WsServerMessage { type: "delta" | "message_complete" | "replay" | "error" | "plan_ready"; [key: string]: unknown; }

function send(ws: WebSocket, msg: WsServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function handleWsMessage(agent: MasterAgent, ws: WebSocket, projectId: string, raw: Buffer): Promise<void> {
  let msg: WsClientMessage;
  try { msg = JSON.parse(raw.toString()) as WsClientMessage; }
  catch { send(ws, { type: "error", message: "Invalid JSON" }); return; }

  if (msg.type === "resume" && msg.lastSeqId !== undefined) {
    const missed = listMessagesSince(projectId, msg.lastSeqId);
    send(ws, { type: "replay", messages: missed });
    return;
  }

  if (msg.type === "prompt" && msg.text) {
    appendMessage(projectId, "user", msg.text);
    let fullResponse = "";
    const onDelta = (text: string) => (fullResponse += text);
    agent.on("delta", onDelta);
    try {
      await agent.prompt(msg.text);
      if (fullResponse) {
        appendMessage(projectId, "assistant", fullResponse);
        if (fullResponse.includes("### Task") && fullResponse.includes("**Repository:**")) {
          const repos = listRepositories();
          const tasks = parsePlan(projectId, fullResponse, repos);
          if (tasks.length > 0) {
            const plan = { id: randomUUID(), projectId, content: fullResponse, tasks, approved: false };
            updateProject(projectId, { plan, status: "awaiting_approval" });
            send(ws, { type: "plan_ready", plan });
          }
        }
      }
      // Send message_complete AFTER appendMessage so the client can safely reload messages
      send(ws, { type: "message_complete" });
    } catch (err) {
      send(ws, { type: "error", message: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      agent.off("delta", onDelta);
    }
    return;
  }

  if (msg.type === "steer" && msg.text) {
    await agent.steer(msg.text);
    return;
  }
}

export function setupWebSocket(server: Server, dataDir: string): void {
  globalDataDir = dataDir;
  const wss = new WebSocketServer({ server });
  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const match = /\/ws\/projects\/([^/]+)\/chat/.exec(req.url ?? "");
    if (!match) { ws.close(4000, "Invalid URL"); return; }
    const projectId = match[1];
    const project = getProject(projectId);
    if (!project) { ws.close(4004, "Project not found"); return; }

    // Buffer messages received before agent is ready to avoid losing them during init
    const pendingMessages: Buffer[] = [];
    let agent: MasterAgent | undefined = agentSessions.get(projectId);

    ws.on("message", async (raw: Buffer) => {
      if (!agent) { pendingMessages.push(raw); return; }
      await handleWsMessage(agent, ws, projectId, raw);
    });

    if (!agent) {
      agent = await getOrInitAgent(projectId);
    }

    const onDeltaFwd = (text: string) => send(ws, { type: "delta", text });
    const onErrorFwd = (err: Error) => send(ws, { type: "error", message: err.message });
    agent.on("delta", onDeltaFwd);
    agent.on("error", onErrorFwd);

    ws.on("close", () => {
      agent!.off("delta", onDeltaFwd);
      agent!.off("error", onErrorFwd);
    });

    for (const raw of pendingMessages) {
      await handleWsMessage(agent, ws, projectId, raw);
    }

    // If a plan is already awaiting approval, notify the newly connected client
    const currentProject = getProject(projectId);
    if (currentProject?.plan && !currentProject.plan.approved) {
      send(ws, { type: "plan_ready", plan: currentProject.plan });
    }
  });
}
