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

interface WsClientMessage { type: "prompt" | "steer" | "resume"; text?: string; lastSeqId?: number; }
interface WsServerMessage { type: "delta" | "message_complete" | "replay" | "error" | "plan_ready"; [key: string]: unknown; }

function send(ws: WebSocket, msg: WsServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function setupWebSocket(server: Server, dataDir: string): void {
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const match = /\/ws\/projects\/([^/]+)\/chat/.exec(req.url ?? "");
    if (!match) { ws.close(4000, "Invalid URL"); return; }
    const projectId = match[1];
    const project = getProject(projectId);
    if (!project) { ws.close(4004, "Project not found"); return; }

    let agent = agentSessions.get(projectId);
    if (!agent) {
      const sessionDir = path.join(dataDir, "sessions", projectId);
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionPath = path.join(sessionDir, "master.jsonl");
      agent = new MasterAgent(projectId, sessionPath);
      await agent.init();
      agentSessions.set(projectId, agent);
    }

    const onDeltaFwd = (text: string) => send(ws, { type: "delta", text });
    const onCompleteFwd = () => send(ws, { type: "message_complete" });
    const onErrorFwd = (err: Error) => send(ws, { type: "error", message: err.message });
    agent.on("delta", onDeltaFwd);
    agent.on("message_complete", onCompleteFwd);
    agent.on("error", onErrorFwd);

    ws.on("close", () => {
      agent!.off("delta", onDeltaFwd);
      agent!.off("message_complete", onCompleteFwd);
      agent!.off("error", onErrorFwd);
    });

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
        appendMessage(projectId, "user", msg.text);
        let fullResponse = "";
        const onDelta = (text: string) => (fullResponse += text);
        agent!.on("delta", onDelta);
        try {
          await agent!.prompt(msg.text);
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
        } catch (err) {
          send(ws, { type: "error", message: err instanceof Error ? err.message : "Unknown error" });
        } finally {
          agent!.off("delta", onDelta);
        }
        return;
      }

      if (msg.type === "steer" && msg.text) {
        await agent!.steer(msg.text);
        return;
      }
    });
  });
}
