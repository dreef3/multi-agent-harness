import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage, Server } from "http";
import { getPlanningAgentManager } from "../orchestrator/planningAgentManager.js";
import type { PlanningAgentEvent } from "../orchestrator/planningAgentManager.js";
import { getProject, updateProject } from "../store/projects.js";
import { appendMessage, listMessagesSince } from "../store/messages.js";
import { listRepositories } from "../store/repositories.js";
import type { Project, Repository } from "../models/types.js";

interface WsClientMessage { type: "prompt" | "steer" | "resume"; text?: string; lastSeqId?: number; }
interface WsServerMessage { type: "delta" | "message_complete" | "conversation_complete" | "tool_call" | "replay" | "error"; [key: string]: unknown; }

function send(ws: WebSocket, msg: WsServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Track all active WebSocket connections per project
const projectConnections = new Map<string, Set<WebSocket>>();
// Track which projects already have an output broadcaster registered (one per project)
const projectBroadcasters = new Set<string>();

function broadcastToProject(projectId: string, msg: WsServerMessage) {
  const connections = projectConnections.get(projectId);
  if (!connections) return;
  for (const ws of connections) send(ws, msg);
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

export function preInitAgent(projectId: string): void {
  // Pre-init is a no-op now — planning agent starts on first WS connection
  console.log(`[ws] preInitAgent(${projectId}): deferred to first WS connection`);
}

export function setupWebSocket(server: Server, _dataDir: string): void {
  const wss = new WebSocketServer({ server });

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const match = /\/ws\/projects\/([^/]+)\/chat/.exec(req.url ?? "");
    if (!match) { ws.close(4000, "Invalid URL"); return; }
    const projectId = match[1];
    console.log(`[ws] new connection for project=${projectId}`);

    const project = getProject(projectId);
    if (!project) { ws.close(4004, "Project not found"); return; }

    // Register connection
    if (!projectConnections.has(projectId)) projectConnections.set(projectId, new Set());
    projectConnections.get(projectId)!.add(ws);

    const manager = getPlanningAgentManager();

    // ensureRunning can take 30+ seconds (container create/start/attach). Register handlers
    // immediately so messages and close events are never dropped during startup.
    const msgQueue: Buffer[] = [];
    let setupComplete = false;
    let connectionIncremented = false;
    let unsubscribeDelta: () => void = () => {};

    const processMessage = async (raw: Buffer): Promise<void> => {
      let msg: WsClientMessage;
      try { msg = JSON.parse(raw.toString()) as WsClientMessage; }
      catch { send(ws, { type: "error", message: "Invalid JSON" }); return; }

      if (msg.type === "resume" && msg.lastSeqId !== undefined) {
        const missed = listMessagesSince(projectId, msg.lastSeqId);
        send(ws, { type: "replay", messages: missed });
        return;
      }

      if (msg.type === "prompt" && msg.text) {
        console.log(`[ws] prompt received for project=${projectId}, length=${msg.text.length}`);
        const savedUserMsg = appendMessage(projectId, "user", msg.text);

        let promptText = msg.text;
        if (savedUserMsg.seqId === 1) {
          const proj = getProject(projectId);
          if (proj) {
            const repos = listRepositories().filter(r => proj.repositoryIds.includes(r.id));
            const context = buildMasterAgentContext(proj, repos);
            promptText = `${context}\n\n---\n\n${msg.text}`;
            if (proj.status === "brainstorming") {
              updateProject(projectId, { status: "spec_in_progress" });
            }
          }
        }

        try {
          await manager.sendPrompt(projectId, promptText);
        } catch (err) {
          console.error(`[ws] sendPrompt error:`, err);
          send(ws, { type: "error", message: err instanceof Error ? err.message : "Unknown error" });
        }
        return;
      }

      if (msg.type === "steer" && msg.text) {
        try {
          await manager.sendPrompt(projectId, msg.text);
        } catch (err) {
          console.error(`[ws] steer sendPrompt error:`, err);
          send(ws, { type: "error", message: err instanceof Error ? err.message : "Unknown error" });
        }
        return;
      }
    };

    // Register handlers before any async work so no events are missed
    ws.on("message", (raw: Buffer) => {
      if (!setupComplete) { msgQueue.push(raw); } else { void processMessage(raw); }
    });

    ws.on("close", () => {
      const conns = projectConnections.get(projectId);
      if (conns) {
        conns.delete(ws);
        // When the last client disconnects, clear the broadcaster registration so it
        // is re-registered fresh if a new container starts for this project later.
        if (conns.size === 0) projectBroadcasters.delete(projectId);
      }
      unsubscribeDelta();
      if (connectionIncremented) manager.decrementConnections(projectId);
    });

    // Start planning agent if not running
    const allRepos = listRepositories().filter(r => project.repositoryIds.includes(r.id));
    const repoUrls = allRepos.map(r => ({
      name: r.name,
      url: process.env.GITHUB_TOKEN
        ? r.cloneUrl.replace("https://github.com/", `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/`)
        : r.cloneUrl,
    }));
    try {
      await manager.ensureRunning(projectId, repoUrls);
    } catch (err) {
      console.error(`[ws] failed to start planning agent for ${projectId}:`, err);
      send(ws, { type: "error", message: "Failed to start planning agent" });
      ws.close(1011, "Failed to start planning agent");
      return;
    }

    // If client navigated away during startup, don't increment connections
    if (ws.readyState !== WebSocket.OPEN) {
      console.log(`[ws] WS closed during startup for project=${projectId}, skipping setup`);
      return;
    }

    connectionIncremented = true;
    manager.incrementConnections(projectId);

    // Forward planning agent delta events to this WS client
    unsubscribeDelta = manager.onOutput(projectId, (event: PlanningAgentEvent) => {
      if (event.type === "delta") send(ws, { type: "delta", text: event.text });
    });

    // Register project-wide event broadcaster exactly once per project.
    if (!projectBroadcasters.has(projectId)) {
      projectBroadcasters.add(projectId);
      let messageBuffer = "";
      manager.onOutput(projectId, (event: PlanningAgentEvent) => {
        switch (event.type) {
          case "delta":
            messageBuffer += event.text;
            break;
          case "message_complete":
            if (messageBuffer) {
              appendMessage(projectId, "assistant", messageBuffer);
              messageBuffer = "";
            }
            broadcastToProject(projectId, { type: "message_complete" });
            break;
          case "tool_call":
            broadcastToProject(projectId, { type: "tool_call", toolName: event.toolName, args: event.args ?? {} });
            break;
          case "conversation_complete":
            broadcastToProject(projectId, { type: "conversation_complete" });
            break;
        }
      });
    }

    setupComplete = true;

    // Flush messages that arrived during startup (resume + initial prompt)
    for (const raw of msgQueue) {
      await processMessage(raw);
    }
  });
}
