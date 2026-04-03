import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage, Server } from "http";
import { getAcpAgentManager } from "../orchestrator/acpAgentManager.js";
import type { WsAcpEvent } from "../orchestrator/acpAgentManager.js";
import { getProject, updateProject } from "../store/projects.js";
import { appendMessage, listMessagesSince } from "../store/messages.js";
import { listRepositories } from "../store/repositories.js";
import type { Project, Repository } from "../models/types.js";
import { verifyWsToken, LOCAL_USER } from "./auth.js";
import type { AuthUser } from "./auth.js";
import { config, resolveAgentConfig } from "../config.js";
import { buildCiToolsDescription } from "../agents/ciTools.js";

interface WsClientMessage { type: "prompt" | "steer" | "resume"; text?: string; lastSeqId?: number; }
interface WsServerMessage { type: "delta" | "message_complete" | "conversation_complete" | "tool_call" | "tool_result" | "thinking" | "agent_activity" | "stuck_agent" | "replay" | "error" | string; [key: string]: unknown; }

// ── resolveWsUser ─────────────────────────────────────────────────────────────
// Extracted for testability. Returns the resolved AuthUser or throws on failure.

export async function resolveWsUser(token: string | null, authEnabled: boolean): Promise<AuthUser> {
  if (!authEnabled) return LOCAL_USER;
  if (!token) throw new Error("No token provided");
  const user = await verifyWsToken(token);
  if (!user) throw new Error("Invalid or expired token");
  return user;
}

function send(ws: WebSocket, msg: WsServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Track all active WebSocket connections per project
const projectConnections = new Map<string, Set<WebSocket>>();
// Track which projects already have an output broadcaster registered (one per project)
const projectBroadcasters = new Set<string>();
// Accumulates streaming chunk text per project so we can persist on turn_complete
const projectMessageBuffers = new Map<string, string>();

export function broadcastToProject(projectId: string, msg: WsServerMessage) {
  const connections = projectConnections.get(projectId);
  if (!connections) return;
  for (const ws of connections) send(ws, msg);
}

export function broadcastAgentActivity(projectId: string, sessionId: string, event: { type: string; payload: Record<string, unknown>; timestamp: string }) {
  broadcastToProject(projectId, {
    type: "agent_activity",
    agentType: "sub",
    sessionId,
    event
  });
}

export function broadcastStuckAgent(projectId: string, sessionId: string) {
  broadcastToProject(projectId, {
    type: "stuck_agent",
    sessionId
  });
}

function buildMasterAgentContext(project: Project, repos: Repository[]): string {
  const repoList = repos.length > 0
    ? repos.map((r) => `- **${r.name}** (id: \`${r.id}\`): ${r.cloneUrl} (default branch: ${r.defaultBranch})`).join("\n")
    : "  (no repositories configured for this project)";

  let sourceSection = "";
  if (project.source.type === "freeform" && project.source.freeformDescription) {
    sourceSection = `## Project Description\n${project.source.freeformDescription}`;
  } else if (project.source.type === "jira" && project.source.jiraTickets?.length) {
    sourceSection = `## JIRA Tickets\n${project.source.jiraTickets.map((t) => `- ${t}`).join("\n")}`;
  } else if (project.source.type === "github") {
    const parts: string[] = [];
    if (project.source.freeformDescription) parts.push(project.source.freeformDescription);
    if (project.source.githubIssues?.length) parts.push(`Issue refs: ${project.source.githubIssues.join(", ")}`);
    if (parts.length > 0) sourceSection = `## GitHub Issues\n${parts.join("\n\n")}`;
  }

  return `## Your Role
You are a master planning agent. You operate in two phases, each driven by a
dedicated superpowers skill. Follow each skill's process exactly.

---
${sourceSection}

---
## Repositories
${repoList}

---
## Technical Guidelines
1. You have NO local direct file access. You MUST use the provided tools to interact with repositories.
2. Always perform a broad search/grep before making structural assumptions.
3. When you are ready to propose a plan, you MUST follow the "superpowers:executing-plans" format exactly.

---
${buildCiToolsDescription(config.harnessApiUrl)}
`;
}

const WS_RETRY_DELAYS = [5_000, 15_000, 30_000, 60_000, 120_000];

async function ensureRunningWithRetry(
  manager: ReturnType<typeof getAcpAgentManager>,
  planningAgentId: string,
  agentType: string,
  envVars: string[],
  ws: WebSocket
): Promise<boolean> {
  for (let attempt = 0; attempt <= WS_RETRY_DELAYS.length; attempt++) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      await manager.ensureRunning(planningAgentId, agentType, "planning", envVars);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`[ws] ensureRunning failed for ${planningAgentId} (attempt ${attempt + 1}):`, msg);
      if (attempt < WS_RETRY_DELAYS.length) {
        send(ws, {
          type: "error",
          message: msg,
          retrying: true,
          attempt: attempt + 1,
          maxAttempts: WS_RETRY_DELAYS.length + 1,
        });
        // Wait for retry delay, but abort early if the client disconnects
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, WS_RETRY_DELAYS[attempt]);
          ws.once("close", () => { clearTimeout(timer); resolve(); });
        });
        if (ws.readyState !== WebSocket.OPEN) return false;
      } else {
        // All retries exhausted — persist the error and close
        const projectId = planningAgentId.replace(/^planning-/, "");
        try {
          await updateProject(projectId, { lastError: msg });
        } catch { /* ignore */ }
        send(ws, {
          type: "error",
          message: `Failed to start agent after ${WS_RETRY_DELAYS.length + 1} attempts: ${msg}`,
        });
        ws.close(1011, "Failed to start planning agent");
        return false;
      }
    }
  }
  return false;
}

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  // Handle the HTTP upgrade and authenticate before passing to wss
  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token");

    let wsUser: AuthUser;
    try {
      wsUser = await resolveWsUser(token, config.authEnabled);
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as WebSocket & { user: AuthUser }).user = wsUser;
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const projectId = url.searchParams.get("projectId");

    if (!projectId) {
      ws.close(1008, "Missing projectId");
      return;
    }

    const project = await getProject(projectId);
    if (!project) {
      ws.close(1008, "Project not found");
      return;
    }

    // Register connection
    if (!projectConnections.has(projectId)) projectConnections.set(projectId, new Set());
    projectConnections.get(projectId)!.add(ws);

    const manager = getAcpAgentManager();
    const planningAgentId = "planning-" + projectId;
    const agentConfig = resolveAgentConfig("planning", project?.planningAgent);
    const agentType = agentConfig.type;

    const ghToken = process.env.GITHUB_TOKEN;
    const allRepos = (await listRepositories()).filter((r) => project.repositoryIds.includes(r.id));
    const repoUrls = allRepos.map((r) => ({
      id: r.id,
      name: r.name,
      url: ghToken && r.cloneUrl.startsWith("https://github.com/")
        ? r.cloneUrl.replace("https://github.com/", `https://x-access-token:${ghToken}@github.com/`)
        : r.cloneUrl
    }));

    // Build env vars for the planning agent container
    const providerEnvVars = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENCODE_API_KEY",
      "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY",
      "COPILOT_GITHUB_TOKEN",
      "GEMINI_API_KEY",
    ]
      .filter(k => process.env[k])
      .map(k => `${k}=${process.env[k]}`);

    const envVars = [
      `GIT_CLONE_URLS=${JSON.stringify(repoUrls)}`,
      `PROJECT_ID=${projectId}`,
      `BACKEND_URL=http://backend:3000`,
      `PI_CODING_AGENT_DIR=/pi-agent`,
      `AGENT_PROVIDER=${agentType}`,
      `AGENT_MODEL=${agentConfig.model}`,
      ...providerEnvVars,
    ];

    // Buffer messages that arrive while the container is starting up, so we
    // don't lose the initial prompt on new projects (container can take 5-120s).
    const earlyMessages: Buffer[] = [];
    const earlyMessageHandler = (data: Buffer) => earlyMessages.push(data);
    ws.on("message", earlyMessageHandler);

    const started = await ensureRunningWithRetry(manager, planningAgentId, agentType, envVars, ws);
    ws.off("message", earlyMessageHandler);

    if (!started) {
      projectConnections.get(projectId)?.delete(ws);
      return;
    }

    // Increment manager's connection count to prevent idle timeout
    manager.incrementConnections(planningAgentId);

    // Initial output listener setup (only once per project)
    if (!projectBroadcasters.has(projectId)) {
      projectBroadcasters.add(projectId);
      manager.on(planningAgentId, (event: WsAcpEvent) => {
        let logMsg = `[ws] Broadcasting ACP event to project ${projectId}: type=${event.type}`;
        if (event.type === "acp:agent_message_chunk") {
          const text = typeof event.content === "string"
            ? event.content
            : (event.content as { text?: string } | null)?.text ?? "";
          logMsg += ` text="${String(text).slice(0, 50)}..."`;
        }
        console.log(logMsg);

        // Accumulate text chunks for persistence
        if (event.type === "acp:agent_message_chunk") {
          const chunk = typeof event.content === "string"
            ? event.content
            : (event.content as { text?: string } | null)?.text ?? "";
          projectMessageBuffers.set(projectId, (projectMessageBuffers.get(projectId) ?? "") + String(chunk));
        } else if (event.type === "acp:turn_complete") {
          const buffer = projectMessageBuffers.get(projectId) ?? "";
          if (buffer) {
            appendMessage(projectId, "assistant", buffer).catch(err => {
              console.error(`[ws] Failed to persist assistant message for ${projectId}:`, err);
            });
          }
          projectMessageBuffers.delete(projectId);
        }

        // acp:error → send as WS error type so the frontend shows it in the banner
        if (event.type === "acp:error") {
          broadcastToProject(projectId, { type: "error", message: event.message });
          return;
        }

        // Forward all ACP events as-is (they have the right shape for the frontend)
        broadcastToProject(projectId, {
          ...event,
          agentType: "master",
          agentId: planningAgentId,
        });
      });
    }

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WsClientMessage;
        if (msg.type === "prompt" && msg.text) {
          console.log(`[ws] Received prompt for project ${projectId}: "${msg.text?.slice(0, 100)}..."`);

          // Reactivate completed projects when the user sends a new message
          const currentProject = await getProject(projectId);
          if (currentProject?.status === "completed") {
            await updateProject(projectId, { status: "executing" });
            console.log(`[ws] Reactivating completed project ${projectId} → executing on user prompt`);
          }

          try {
            await appendMessage(projectId, "user", msg.text);
          } catch (err) {
            console.error(`[ws] Failed to persist user message for ${projectId}:`, err);
          }
          // Master agent prompt — include context as part of the message
          const context = buildMasterAgentContext(project, allRepos);
          const fullPrompt = context + "\n\n---\n\n" + msg.text;
          console.log(`[ws] Dispatching message to planning agent for project ${projectId}`);
          await manager.sendPrompt(planningAgentId, fullPrompt);
        } else if (msg.type === "steer" && msg.text) {
          console.log(`[ws] Received steer for project ${projectId}: "${msg.text?.slice(0, 100)}..."`);
          // Mid-stream steering
          await manager.sendPrompt(planningAgentId, msg.text);
        } else if (msg.type === "resume" && msg.lastSeqId !== undefined) {
          // Replay missed messages
          const missed = await listMessagesSince(projectId, msg.lastSeqId);
          if (missed.length > 0) {
            send(ws, { type: "replay", messages: missed });
          }
        }
      } catch (err) {
        console.error(`[ws] message handler error for ${projectId}:`, err);
      }
    });

    ws.on("close", () => {
      const connections = projectConnections.get(projectId);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) projectConnections.delete(projectId);
      }
      manager.decrementConnections(planningAgentId);
    });

    // Replay any messages that arrived before the container was ready
    if (earlyMessages.length > 0) {
      console.log(`[ws] Replaying ${earlyMessages.length} early message(s) for project ${projectId}`);
      for (const data of earlyMessages) ws.emit("message", data);
    }
  });

  return wss;
}
