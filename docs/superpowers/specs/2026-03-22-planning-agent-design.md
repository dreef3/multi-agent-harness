# Planning Agent — Design

**Date:** 2026-03-22
**Status:** Approved

---

## Problem

The current master agent is an in-process LLM wrapper (`MasterAgent` in `websocket.ts`) that has no access to the project's cloned repositories. It cannot read source code, write files, or run tools that require a filesystem. When it needs to dispatch sub-agents it calls internal Node functions directly, tightly coupling planning logic to backend implementation. It has no workspace of its own — repo URLs arrive as text in its system prompt and it must ask users for paths or context that should already be available.

---

## Goals

1. Give the planning agent access to cloned project repositories at a well-known filesystem path
2. Move planning logic out of the backend process and into an isolated Docker container (same infrastructure as implementation sub-agents)
3. Allow the planning agent to dispatch and communicate with implementation sub-agents via typed SDK tools calling the backend API
4. Allow implementation sub-agents to report completion back to the planning agent automatically
5. Keep the existing WebSocket chat interface working — users continue chatting through the browser, with streaming tokens and tool call indicators

---

## Non-Goals

- Persistent planning agent process between unrelated projects (one container per project)
- Planning agent writing to repo branches directly (only implementation sub-agents write code)
- GUI changes beyond the existing chat UX

---

## Architecture

```
Browser ──WS──▶ backend/websocket.ts ──JSON-RPC (stdin/stdout)──▶ planning-agent container
                                                                    │
                                                                    │  SDK custom tools → HTTP
                                                                    ▼
                                                          http://backend:3000/api/
                                                                    │
                                                                    ▼
                                                          RecoveryService ──▶ implementation containers
                                                                    │
                                                                    └─ completion events ──▶ planning-agent stdin (JSON-RPC prompt)
```

The backend communicates with the planning agent container via the pi SDK's JSON-RPC protocol over Docker stdin/stdout attach. The planning agent has typed SDK tools that call backend API endpoints over HTTP. Implementation sub-agent completions are injected as new prompts into the planning agent via the same RPC channel.

---

## Planning Agent Container

### Image

`planning-agent/` at the repo root — a new top-level directory alongside `backend/`, `sub-agent/`, and `frontend/`. Contains:

```
planning-agent/
  Dockerfile          # FROM node:22-slim; installs git + pi package
  runner.mjs          # entrypoint: clone repos, create session with custom tools, run RPC mode
  system-prompt.md    # planning-specific system prompt template
```

The container mirrors the `sub-agent/` pattern: a `runner.mjs` script imports `@mariozechner/pi-coding-agent`, creates an `AgentSession` with custom tools and a custom system prompt, then calls `runRpcMode(session)`. This exposes the pi JSON-RPC protocol on stdin/stdout for the backend to speak.

The entrypoint (`runner.mjs`):

1. Clones all project repositories into `/workspace/{repoName}/` using `GIT_CLONE_URLS` env var (JSON array of `{name, url}`)
2. Creates an `AgentSession` with:
   - Custom system prompt (from `system-prompt.md`, with project context injected)
   - `codingTools` (read, bash, edit, write) scoped to `/workspace/`
   - Custom tools for backend API calls (see Tools section)
   - Session persisted to `/pi-agent/sessions/planning-{projectId}.jsonl` on the shared volume
3. Calls `runRpcMode(session)` — blocks, speaking JSON-RPC on stdin/stdout until the process exits

### Repository Access

Repos are cloned at container startup using credentials passed via env:

- `GIT_CLONE_URLS` — JSON array of `{ name: string; url: string }` objects (authenticated HTTPS URLs including token)
- Each repo lands at `/workspace/{repoName}/` and is readable by the agent

The system prompt tells the agent: "Project repositories are available at `/workspace/`. Use standard file tools to read source code."

### Tools

The planning agent has four custom SDK tools (registered via `customTools` in `createAgentSession`) that call the backend API:

| Tool | Endpoint | Purpose |
|------|----------|---------|
| `dispatch_tasks` | `POST /api/projects/:id/tasks` | Submit or re-submit tasks for dispatch (handles both new tasks and retrying failed ones) |
| `get_task_status` | `GET /api/projects/:id/tasks` | Poll task completion status |
| `get_pull_requests` | `GET /api/pull-requests/project/:id` | List PRs created by sub-agents (endpoint already exists) |

Each tool's `execute` function makes a `fetch` call to `http://backend:3000/api/` on the `harness-agents` Docker network (same network used by implementation sub-agents). `PROJECT_ID` and `BACKEND_URL` are passed as env vars.

### Container Lifecycle

- **Start:** Backend starts the container when a project needs a planning agent (first WebSocket connection for a project, or after a LGTM triggers task dispatch). Container runs with `docker run -d --name planning-{projectId} ...`.
- **Keep-alive:** Container stays running while there is any activity: at least one active WebSocket connection for the project OR at least one running/starting implementation sub-agent session for the project.
- **Stop:** `PlanningAgentManager` tracks an open-connections counter per project. When it reaches zero AND `RecoveryService.checkAllTerminal` fires (all tasks terminal), `PlanningAgentManager.stopContainer(projectId)` is called. `RecoveryService.checkAllTerminal` calls a new `PlanningAgentManager.onProjectTerminal(projectId)` hook to trigger this check. WebSocket connect/disconnect events update the counter and also trigger the same stop check.
- **Restart:** If the backend restarts and a `planning-{projectId}` container already exists (from a prior run), the backend attaches to it rather than creating a new one. This reuses the existing filesystem context including already-cloned repos.

### Session Continuity

The pi session JSONL is stored on the existing `harness-pi-auth` Docker named volume (same volume already used by sub-agents and the backend), mounted at `/pi-agent/` in the planning agent container. Session file path: `/pi-agent/sessions/planning-{projectId}.jsonl`. `runner.mjs` uses `SessionManager.open(sessionPath)` to continue an existing session or `SessionManager.create(cwd, sessionDir)` to start a new one.

---

## PlanningAgentManager

A new backend module at `backend/src/orchestrator/planningAgentManager.ts` manages the lifecycle and communication for planning agent containers.

### Singleton Pattern

```typescript
let instance: PlanningAgentManager | null = null;
export function setPlanningAgentManager(mgr: PlanningAgentManager): void { instance = mgr; }
export function getPlanningAgentManager(): PlanningAgentManager { ... }
```

Initialized in `index.ts` alongside `RecoveryService`.

### Interface

```typescript
class PlanningAgentManager {
  // Send a user or system message to the planning agent for a project
  async sendPrompt(projectId: string, message: string): Promise<void>

  // Register callbacks for streaming output and tool call events from the planning agent
  onOutput(projectId: string, handler: (event: PlanningAgentEvent) => void): () => void

  // True if the container for this project is running
  isRunning(projectId: string): boolean

  // Stop the container for this project
  async stopContainer(projectId: string): Promise<void>

  // Called by RecoveryService when all tasks reach terminal state
  onProjectTerminal(projectId: string): void
}

type PlanningAgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; toolName: string; args?: Record<string, unknown> }
  | { type: "message_complete" }
  | { type: "conversation_complete" }
```

### Concurrency

Each project has at most one active planning container. `sendPrompt` queues messages if the agent is currently streaming (RPC `isStreaming` state) — it does not interrupt mid-turn. The queue drains in FIFO order using the RPC `follow_up` command for system injections and `prompt` for user messages.

### Communication Protocol

The backend attaches to the container via `docker.getContainer(id).attach({ stream: true, stdin: true, stdout: true, stderr: true })`. The pi SDK's **JSON-RPC protocol** runs over this channel:

- **Input (stdin):** `sendPrompt` writes a JSON-RPC command followed by `\n`:
  - User messages: `{"type": "prompt", "message": "<text>"}\n`
  - System injections during streaming: `{"type": "follow_up", "message": "<text>"}\n`
- **Output (stdout):** A stream of newline-delimited JSON events. The backend parses each line and maps to `PlanningAgentEvent`:
  - `{"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "..."}}` → `{ type: "delta", text }`
  - `{"type": "tool_execution_start", "toolName": "...", "args": {...}}` → `{ type: "tool_call", toolName, args }`
  - `{"type": "message_end"}` → `{ type: "message_complete" }`
  - `{"type": "agent_end"}` → `{ type: "conversation_complete" }`

stderr is captured separately for logging but not forwarded to the frontend.

---

## WebSocket Changes

`backend/src/api/websocket.ts` replaces its `MasterAgent` usage with `PlanningAgentManager`:

### Inbound (browser → planning agent)

When a WebSocket message arrives with `type: "prompt"`, instead of calling `agent.prompt(message)`, the backend calls `getPlanningAgentManager().sendPrompt(projectId, message)`.

### Outbound (planning agent → browser)

`PlanningAgentManager.onOutput` emits typed `PlanningAgentEvent` objects. The backend maps these to the existing WS message types:

- `delta` → `{ type: "delta", text }` — forwarded to all connected clients
- `tool_call` → `{ type: "tool_call", toolName, args }` — forwarded to all connected clients
- `message_complete` → `{ type: "message_complete" }` — triggers message persistence + broadcast
- `conversation_complete` → `{ type: "conversation_complete" }` — broadcast

This preserves the existing frontend behaviour: streaming bubble, tool call indicators, message persistence on completion.

### LGTM Approval

When polling detects a LGTM comment and transitions the project to `executing`, it injects a system message via `getPlanningAgentManager().sendPrompt(projectId, "[SYSTEM] Plan approved. Begin dispatching tasks.")` rather than calling `getOrInitAgent().prompt()`.

### Sub-Agent Completion Injection

When `RecoveryService.checkAllTerminal` or `notifyMasterPartialFailure` wants to notify the planning agent, it calls `getPlanningAgentManager().sendPrompt(projectId, message)`. This injects the completion status as a new turn for the planning agent to act on.

---

## New API Endpoints

### `POST /api/projects/:id/tasks`

Accepts a task list and dispatches them via `RecoveryService.dispatchTasksForProject`. Called by the planning agent `dispatch_tasks` tool.

**Request body:**
```json
{
  "tasks": [
    { "id": "...", "repositoryId": "...", "description": "..." }
  ]
}
```

**Response:** `{ "dispatched": number }`

### `GET /api/projects/:id/tasks`

Returns the current task list with statuses. Called by the planning agent `get_task_status` tool.

**Response:** `{ "tasks": PlanTask[] }`

---

## Migration from MasterAgent

1. `MasterAgent` class and its `getOrInitAgent` factory are removed
2. `websocket.ts` imports `PlanningAgentManager` instead
3. `restartFailedTasksTool.ts` and `RecoveryService.dispatchFailedTasks` are deleted — superseded by the planning agent calling `dispatch_tasks` directly
4. `RecoveryService.notifyMaster` implementation switches from `getOrInitAgent().prompt()` to `getPlanningAgentManager().sendPrompt()`

---

## Testing

- Unit tests for `PlanningAgentManager`: mock Docker client, verify `sendPrompt` queuing, `onOutput` event mapping (delta, tool_call, message_complete, conversation_complete), `stopContainer`
- Unit tests for new `/api/projects/:id/tasks` and `/api/projects/:id/tasks/restart` endpoints
- Integration test (extends existing E2E pattern): project created → planning agent started → LGTM posted → planning agent dispatches task → sub-agent completes → completion injected back → project reaches `completed`

---

## Open Questions (resolved during design)

- **Per-turn vs persistent process:** Persistent process (container stays running) to preserve repo state and conversation context — avoids re-cloning on every turn.
- **Communication channel:** pi JSON-RPC protocol over Docker stdin/stdout attach — structured events, no fragile text parsing.
- **Turn end detection:** `agent_end` RPC event — reliable, no idle timeout heuristic needed.
- **Streaming and tool call visibility:** Both work natively via RPC events (`text_delta` → WS `delta`, `tool_execution_start` → WS `tool_call`). No extra work required in the frontend.
- **Tool mechanism:** Typed SDK `customTools` in `runner.mjs` — fetch calls to `http://backend:3000/api/` on the `harness-agents` network.
- **Session continuity:** Pi session JSONL stored on the existing `harness-pi-auth` named volume at a per-project path.
