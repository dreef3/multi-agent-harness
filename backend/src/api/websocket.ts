import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage, Server } from "http";
import { randomUUID } from "crypto";
import { MasterAgent } from "../agents/masterAgent.js";
import { getProject, updateProject } from "../store/projects.js";
import { appendMessage, listMessagesSince } from "../store/messages.js";
import { parsePlan } from "../agents/planParser.js";
import { listRepositories } from "../store/repositories.js";
import type { Project, Repository } from "../models/types.js";
import path from "path";
import fs from "fs";

const agentSessions = new Map<string, MasterAgent>();
const agentInitPromises = new Map<string, Promise<MasterAgent>>();
let globalDataDir = "";

async function getOrInitAgent(projectId: string): Promise<MasterAgent> {
  const existing = agentSessions.get(projectId);
  if (existing) { console.log(`[ws] getOrInitAgent(${projectId}): returning cached agent`); return existing; }

  const existingPromise = agentInitPromises.get(projectId);
  if (existingPromise) { console.log(`[ws] getOrInitAgent(${projectId}): awaiting in-progress init`); return existingPromise; }

  console.log(`[ws] getOrInitAgent(${projectId}): starting new init`);
  const promise = (async () => {
    const sessionDir = path.join(globalDataDir, "sessions", projectId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "master.jsonl");
    const agent = new MasterAgent(projectId, sessionPath);
    await agent.init();
    agentSessions.set(projectId, agent);
    agentInitPromises.delete(projectId);
    console.log(`[ws] getOrInitAgent(${projectId}): init complete, agent stored`);
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

function buildMasterAgentContext(project: Project, repos: Repository[]): string {
  const repoList = repos.length > 0
    ? repos.map((r) => `- **${r.name}**: ${r.cloneUrl} (default branch: ${r.defaultBranch})`).join("\n")
    : "  (no repositories configured for this project)";

  let sourceSection = "";
  if (project.source.type === "freeform" && project.source.freeformDescription) {
    sourceSection = `## Project Description\n${project.source.freeformDescription}`;
  } else if (project.source.type === "jira" && project.source.jiraTickets?.length) {
    sourceSection = `## JIRA Tickets\n${project.source.jiraTickets.map((t) => `- ${t}`).join("\n")}`;
  } else if (project.source.type === "github") {
    const parts: string[] = [];
    if (project.source.freeformDescription) parts.push(project.source.freeformDescription);
    if (project.source.githubIssues?.length) {
      parts.push(`Issue refs: ${project.source.githubIssues.join(", ")}`);
    }
    if (parts.length > 0) sourceSection = `## GitHub Issues\n${parts.join("\n\n")}`;
  }

  return `## Your Role
You are a master planning agent. Your ONLY job is to understand requirements and produce a structured implementation plan that sub-agents will execute. You must NOT write files, make code changes, or use any tools — output your plan directly as text in your response.

## Available Repositories
${repoList}

${sourceSection}

## How to Present a Plan
When you are ready to present a plan, include it directly in your response text using exactly this format (it will be parsed automatically):

### Task 1: [Brief Task Title]
**Repository:** [repository-name-exactly-as-listed-above]
**Description:**
[Detailed description of what to implement]

### Task 2: [Brief Task Title]
**Repository:** [repository-name-exactly-as-listed-above]
**Description:**
[Detailed description]

Important rules:
- Use the exact repository name from the list above (case-sensitive)
- Output the plan as plain text in your response — do NOT write it to a file
- Do NOT attempt to make code changes yourself; sub-agents handle execution
- You may ask clarifying questions before presenting the plan`;
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
    console.log(`[ws] prompt received for project=${projectId}, text length=${msg.text.length}`);
    const savedUserMsg = appendMessage(projectId, "user", msg.text);
    const isFirstMessage = savedUserMsg.seqId === 1;
    console.log(`[ws] user message saved seqId=${savedUserMsg.seqId}, isFirstMessage=${isFirstMessage}`);

    let promptText = msg.text;
    if (isFirstMessage) {
      const project = getProject(projectId);
      if (project) {
        const allRepos = listRepositories();
        const projectRepos = allRepos.filter((r) => project.repositoryIds.includes(r.id));
        console.log(`[ws] injecting context: sourceType=${project.source.type}, repos=[${projectRepos.map((r) => r.name).join(", ")}]`);
        const context = buildMasterAgentContext(project, projectRepos);
        promptText = `${context}\n\n---\n\n${msg.text}`;
        console.log(`[ws] final prompt length with context=${promptText.length}`);
      }
    }

    let fullResponse = "";
    let deltaCount = 0;
    const onDelta = (text: string) => { fullResponse += text; deltaCount++; };
    agent.on("delta", onDelta);
    console.log(`[ws] calling agent.prompt()...`);
    try {
      await agent.prompt(promptText);
      console.log(`[ws] agent.prompt() resolved. deltaCount=${deltaCount}, fullResponse length=${fullResponse.length}`);
      if (fullResponse) {
        appendMessage(projectId, "assistant", fullResponse);
        console.log(`[ws] assistant message saved`);
        if (fullResponse.includes("### Task") && fullResponse.includes("**Repository:**")) {
          const repos = listRepositories();
          const tasks = parsePlan(projectId, fullResponse, repos);
          console.log(`[ws] plan detected, parsed ${tasks.length} tasks`);
          if (tasks.length > 0) {
            const plan = { id: randomUUID(), projectId, content: fullResponse, tasks, approved: false };
            updateProject(projectId, { plan, status: "awaiting_approval" });
            send(ws, { type: "plan_ready", plan });
            console.log(`[ws] plan_ready sent`);
          }
        }
      } else {
        console.warn(`[ws] agent returned empty response (deltaCount=${deltaCount})`);
      }
      // Send message_complete AFTER appendMessage so the client can safely reload messages
      send(ws, { type: "message_complete" });
      console.log(`[ws] message_complete sent`);
    } catch (err) {
      console.error(`[ws] agent.prompt() error:`, err);
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
    console.log(`[ws] new connection for project=${projectId}`);
    const project = getProject(projectId);
    if (!project) { console.error(`[ws] project not found: ${projectId}`); ws.close(4004, "Project not found"); return; }

    // Buffer messages received before agent is ready to avoid losing them during init
    const pendingMessages: Buffer[] = [];
    let agent: MasterAgent | undefined = agentSessions.get(projectId);
    console.log(`[ws] agent already cached: ${!!agent}`);

    ws.on("message", async (raw: Buffer) => {
      if (!agent) {
        console.log(`[ws] message buffered (agent not ready yet) for project=${projectId}`);
        pendingMessages.push(raw);
        return;
      }
      await handleWsMessage(agent, ws, projectId, raw);
    });

    if (!agent) {
      console.log(`[ws] awaiting agent init for project=${projectId}`);
      agent = await getOrInitAgent(projectId);
      console.log(`[ws] agent ready for project=${projectId}`);
    }

    const onDeltaFwd = (text: string) => send(ws, { type: "delta", text });
    const onErrorFwd = (err: Error) => send(ws, { type: "error", message: err.message });
    agent.on("delta", onDeltaFwd);
    agent.on("error", onErrorFwd);

    ws.on("close", () => {
      agent!.off("delta", onDeltaFwd);
      agent!.off("error", onErrorFwd);
    });

    if (pendingMessages.length > 0) {
      console.log(`[ws] flushing ${pendingMessages.length} buffered messages for project=${projectId}`);
    }
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
