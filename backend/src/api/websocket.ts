import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage, Server } from "http";
import { MasterAgent } from "../agents/masterAgent.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createWritePlanningDocumentTool } from "../agents/planningTool.js";
import { createSubAgentStatusTool } from "../agents/subAgentStatusTool.js";
import { createRestartFailedTasksTool } from "../agents/restartFailedTasksTool.js";
import { getProject, updateProject } from "../store/projects.js";
import { appendMessage, listMessagesSince } from "../store/messages.js";
import { listRepositories } from "../store/repositories.js";
import type { Project, Repository } from "../models/types.js";
import path from "path";
import fs from "fs";

const agentSessions = new Map<string, MasterAgent>();
const agentInitPromises = new Map<string, Promise<MasterAgent>>();
let globalDataDir = "";

export async function getOrInitAgent(projectId: string): Promise<MasterAgent> {
  const existing = agentSessions.get(projectId);
  if (existing) { console.log(`[ws] getOrInitAgent(${projectId}): returning cached agent`); return existing; }

  const existingPromise = agentInitPromises.get(projectId);
  if (existingPromise) { console.log(`[ws] getOrInitAgent(${projectId}): awaiting in-progress init`); return existingPromise; }

  console.log(`[ws] getOrInitAgent(${projectId}): starting new init`);
  const promise = (async () => {
    const sessionDir = path.join(globalDataDir, "sessions", projectId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "master.jsonl");
    const planningTool = createWritePlanningDocumentTool(projectId, globalDataDir);
    const statusTool = createSubAgentStatusTool(projectId);
    const restartTool = createRestartFailedTasksTool(projectId);
    // TypeBox generic contravariance prevents direct assignment; cast is safe at runtime
    const agent = new MasterAgent(projectId, sessionPath, [
      planningTool as unknown as ToolDefinition,
      statusTool as unknown as ToolDefinition,
      restartTool as unknown as ToolDefinition,
    ]);
    try {
      await agent.init();
      agentSessions.set(projectId, agent);
      console.log(`[ws] getOrInitAgent(${projectId}): init complete, agent stored`);
      return agent;
    } finally {
      agentInitPromises.delete(projectId);
    }
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
    if (project.source.githubIssues?.length) parts.push(`Issue refs: ${project.source.githubIssues.join(", ")}`);
    if (parts.length > 0) sourceSection = `## GitHub Issues\n${parts.join("\n\n")}`;
  }

  return `## Your Role
You are a master planning agent. You operate in two phases, each driven by a
dedicated superpowers skill. Follow each skill's process exactly.

---

## Phase 1 — Design Spec

Invoke the \`superpowers:brainstorming\` skill. Follow its full process:

1. Explore the project context (repositories, existing code, recent commits).
2. Ask clarifying questions one at a time (multiple-choice preferred).
3. Propose 2–3 design approaches with trade-offs and a recommendation.
4. Present the design in sections; get approval after each section.
5. Write the spec to:
   \`docs/superpowers/specs/{YYYY-MM-DD}-{project-slug}-design.md\`
6. Dispatch the \`spec-document-reviewer\` subagent (from the brainstorming skill's
   \`spec-document-reviewer-prompt.md\`). Fix any issues and re-dispatch until
   approved (max 3 iterations; surface to user if still failing after 3).
7. Ask the user to review the written spec file before proceeding.
8. Once the user approves the written spec, call:
   \`write_planning_document(type: "spec", content: <full spec markdown>)\`
9. After the tool returns, post the PR URL in chat:
   "The spec is ready for review at {url}. Add a LGTM comment to the PR when you
   are happy with it."

---

## Phase 2 — Implementation Plan

Triggered when you receive:
\`[SYSTEM] The spec has been approved (LGTM received on the PR).\`

Invoke the \`superpowers:writing-plans\` skill. Follow its full process:

1. Re-read the approved spec carefully (it is in the repository at
   \`docs/superpowers/specs/\`).
2. Define the file structure and task boundaries.
3. Write a detailed plan with bite-sized tasks (2–5 min each), each containing:
   - Files to create/modify/test
   - Exact code snippets
   - Exact commands with expected output
   - Step-by-step checkboxes
4. Save the plan to:
   \`docs/superpowers/plans/{YYYY-MM-DD}-{project-slug}-plan.md\`
   Include this header for the sub-agents that will execute it:
   > **For agentic workers:** Tasks will be executed by containerised sub-agents.
   > Each sub-agent receives its task via the TASK_DESCRIPTION environment variable.
5. Dispatch the \`plan-document-reviewer\` subagent (from the writing-plans skill's
   \`plan-document-reviewer-prompt.md\`). Fix issues and re-dispatch until approved
   (max 3 iterations).
6. Call \`write_planning_document(type: "plan", content: <full plan markdown>)\`.
   This commits the plan file to the PR branch so the user can review it.
7. After the tool returns, post the PR URL in chat:
   "The plan is ready for review at {url}. Add a LGTM comment to the PR when
   you are ready to start implementation."
   Then stop — do NOT proceed further until you receive a system message.
8. Wait for: \`[SYSTEM] The implementation plan has been approved (LGTM received on the PR).\`
   Do NOT proceed until you receive this exact system message.

**Important:** The \`writing-plans\` skill normally ends by asking the user to choose
between subagent-driven or inline execution. **Skip that step entirely.** In this
harness, execution is handled automatically by containerised Docker sub-agents after
the plan LGTM is received. Do not ask about worktrees or execution modes.

The plan must use this task format exactly (used by the task parser):

### Task 1: [Brief Task Title]
**Repository:** [exact repository name from the list above]
**Description:**
[Detailed description — self-contained enough for a sub-agent with no other context]

### Task 2: ...

---

## Phase 3 — Implementation Started

Triggered when you receive:
\`[SYSTEM] The implementation plan has been approved (LGTM received on the PR).\`

Tell the user:
"The plan has been approved. Implementation is starting — the sub-agents will take
it from here. I'll let you know when they're done."

Do NOT invoke any execution skill. Sub-agent execution is handled automatically
by the harness.

---

## Important Rules
- Do NOT make code changes yourself at any point.
- Do NOT skip the spec-document-reviewer or plan-document-reviewer subagent steps.
- Communicate every state transition explicitly in chat.
- Follow superpowers skill processes exactly — do not shortcut them.

## Available Repositories
${repoList}

${sourceSection}`;
}

interface WsClientMessage { type: "prompt" | "steer" | "resume"; text?: string; lastSeqId?: number; }
interface WsServerMessage { type: "delta" | "message_complete" | "conversation_complete" | "tool_call" | "replay" | "error"; [key: string]: unknown; }

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
        // Transition to spec_in_progress on first user message; guard against replay/test re-entry
        if (isFirstMessage && project.status === "brainstorming") {
          updateProject(projectId, { status: "spec_in_progress" });
        }
      }
    }

    // Per-turn message accumulation: save a separate message on each message_stop,
    // so multi-turn conversations (text → tool → text) show as separate bubbles.
    let currentBuffer = "";
    let totalDeltaCount = 0;

    const onDelta = (text: string) => { currentBuffer += text; totalDeltaCount++; };
    const onTurnComplete = () => {
      if (currentBuffer) {
        console.log(`[ws] saving assistant turn, length=${currentBuffer.length}`);
        appendMessage(projectId, "assistant", currentBuffer);
        broadcastToProject(projectId, { type: "message_complete" });
        currentBuffer = "";
      }
    };
    const onToolCall = (toolName: string, args: unknown) => {
      // Forward tool call info to all connected clients (transient, not persisted)
      const safeArgs = toolName === "write_planning_document"
        ? { type: (args as { type?: string })?.type }
        : {};
      broadcastToProject(projectId, { type: "tool_call", toolName, args: safeArgs });
    };

    agent.on("delta", onDelta);
    agent.on("message_complete", onTurnComplete);
    agent.on("tool_call", onToolCall);
    console.log(`[ws] calling agent.prompt()...`);
    try {
      await agent.prompt(promptText);
      console.log(`[ws] agent.prompt() resolved. totalDeltaCount=${totalDeltaCount}`);
      // Flush any remaining buffer (shouldn't normally happen)
      if (currentBuffer) {
        appendMessage(projectId, "assistant", currentBuffer);
        broadcastToProject(projectId, { type: "message_complete" });
      }
      if (totalDeltaCount === 0) {
        console.warn(`[ws] agent returned empty response`);
      }
      // Signal that the full conversation turn is done (broadcast to all connections)
      broadcastToProject(projectId, { type: "conversation_complete" });
      console.log(`[ws] conversation_complete broadcast`);
    } catch (err) {
      console.error(`[ws] agent.prompt() error:`, err);
      send(ws, { type: "error", message: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      agent.off("delta", onDelta);
      agent.off("message_complete", onTurnComplete);
      agent.off("tool_call", onToolCall);
    }
    return;
  }

  if (msg.type === "steer" && msg.text) {
    await agent.steer(msg.text);
    return;
  }
}

// Track all active WebSocket connections per project so lifecycle events
// (message_complete, conversation_complete, tool_call) reach reconnected clients.
const projectConnections = new Map<string, Set<WebSocket>>();

function broadcastToProject(projectId: string, msg: WsServerMessage) {
  const connections = projectConnections.get(projectId);
  if (!connections) return;
  for (const ws of connections) send(ws, msg);
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

    // Register connection for project-wide broadcasts
    if (!projectConnections.has(projectId)) projectConnections.set(projectId, new Set());
    projectConnections.get(projectId)!.add(ws);

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
      projectConnections.get(projectId)?.delete(ws);
      agent!.off("delta", onDeltaFwd);
      agent!.off("error", onErrorFwd);
    });

    if (pendingMessages.length > 0) {
      console.log(`[ws] flushing ${pendingMessages.length} buffered messages for project=${projectId}`);
    }
    for (const raw of pendingMessages) {
      await handleWsMessage(agent, ws, projectId, raw);
    }
  });
}
