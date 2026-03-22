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
3. Allow the planning agent to dispatch and communicate with implementation sub-agents via HTTP tools calling the backend API
4. Allow implementation sub-agents to report completion back to the planning agent automatically
5. Keep the existing WebSocket chat interface working — users continue chatting through the browser

---

## Non-Goals

- Persistent planning agent process between unrelated projects (one container per project)
- Streaming tokens back to the frontend in real time (full-turn messages only, for now)
- Planning agent writing to repo branches directly (only implementation sub-agents write code)
- GUI changes beyond the existing chat UX

---

## Architecture

```
Browser ──WS──▶ backend/websocket.ts ──attach──▶ planning-agent container
                                                  │
                                                  │  HTTP tools
                                                  ▼
                                        http://backend:3000/api/
                                                  │
                                                  ▼
                                        RecoveryService ──▶ implementation containers
                                                  │
                                                  └─ completion events ──▶ planning-agent stdin
```

The backend proxies WebSocket messages to/from the planning agent container via Docker stdin/stdout attach. The planning agent calls backend API endpoints as tools. Implementation sub-agents push their completion events back into the planning agent's stdin as `[SYSTEM]` messages.

---

## Planning Agent Container

### Image

`planning-agent/` at the repo root — a new top-level directory alongside `backend/` and `frontend/`. Contains:

```
planning-agent/
  Dockerfile          # FROM node:22-slim; installs git + claude-code CLI
  run.sh              # entrypoint: clone repos, exec claude
  system-prompt.md    # planning-specific system prompt template
```

The container runs a single `claude` CLI process with `--dangerously-skip-permissions` for non-interactive approval and with stdin/stdout available for the attach stream. The entrypoint:

1. Clones all project repositories into `/workspace/{repoName}/` using `GIT_CLONE_URLS` env var (JSON array of `{name, url}`)
2. Writes the rendered system prompt to a temp file
3. Execs `claude --dangerously-skip-permissions --system-prompt-file <path>` (or `--print` mode with `--continue` for per-turn invocations — see Container Lifecycle below)

### Repository Access

Repos are cloned at container startup using credentials passed via env:

- `GIT_CLONE_URLS` — JSON array of `{ name: string; url: string }` objects (authenticated HTTPS URLs including token)
- Each repo lands at `/workspace/{repoName}/` and is readable by the agent

The system prompt tells the agent: "Project repositories are available at `/workspace/`. Use standard shell tools to read source code."

### Tools

The planning agent has access to backend API endpoints via HTTP tool calls:

| Tool | Endpoint | Purpose |
|------|----------|---------|
| `dispatch_tasks` | `POST /api/projects/:id/tasks` | Submit plan tasks for dispatch |
| `get_task_status` | `GET /api/projects/:id/tasks` | Poll task completion status |
| `restart_failed_tasks` | `POST /api/projects/:id/tasks/restart` | Re-dispatch permanently-failed tasks |
| `get_pull_requests` | `GET /api/pull-requests/project/:id` | List PRs created by sub-agents |

These tools call `http://backend:3000/api/` from inside the container on the `harness-agents` Docker network (same network used by implementation sub-agents).

Tool definitions are injected via the system prompt as JSON schemas (claude-code MCP format or `--allowedTools` flag, TBD during implementation).

### Container Lifecycle

- **Start:** Backend starts the container when a project needs a planning agent (first WebSocket connection for a project, or after a LGTM triggers task dispatch). Container runs with `docker run -d --name planning-{projectId} ...`.
- **Keep-alive:** Container stays running while there is activity — active WebSocket connections or running implementation sub-agents for the project.
- **Stop:** Backend stops the container when the project reaches a terminal state (`completed` / `failed`) or when the last WebSocket client disconnects and all sub-agents finish.
- **Restart:** If the backend restarts and a `planning-{projectId}` container already exists (created externally or from a prior run), the backend attaches to it rather than creating a new one. This reuses the existing filesystem context, including already-cloned repos.

### Named Volume for Session Continuity

The Claude CLI session JSONL (`~/.claude/projects/.../session.jsonl`) is stored on a Docker named volume `planning-sessions` mounted at `/root/.claude/`. This persists conversation history across container restarts and backend process restarts.

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

  // Register a callback for output from the planning agent
  onOutput(projectId: string, handler: (text: string) => void): () => void

  // True if the container for this project is running
  isRunning(projectId: string): boolean

  // Stop the container for this project
  async stopContainer(projectId: string): Promise<void>
}
```

### Concurrency

Each project has at most one active planning container. `sendPrompt` queues messages if a prior prompt is still streaming — it does not interrupt mid-turn. The queue drains in FIFO order.

### Communication Protocol

The backend attaches to the container's stdin/stdout via `docker.getContainer(id).attach({ stream: true, stdin: true, stdout: true, stderr: true })`. Text from stdout is buffered and emitted via `onOutput` callbacks. Text written to stdin is the raw user/system message text followed by `\n`.

---

## WebSocket Changes

`backend/src/api/websocket.ts` replaces its `MasterAgent` usage with `PlanningAgentManager`:

### Inbound (browser → planning agent)

When a WebSocket message arrives with `type: "prompt"`, instead of calling `agent.prompt(message)`, the backend calls `getPlanningAgentManager().sendPrompt(projectId, message)`.

### Outbound (planning agent → browser)

The `PlanningAgentManager.onOutput` callback streams planning agent output to all connected WebSocket clients for the project, the same way `MasterAgent` output events are currently forwarded.

### LGTM Approval

When polling detects a LGTM comment and transitions the project to `executing`, it injects a system message into the planning agent via `getPlanningAgentManager().sendPrompt(projectId, "[SYSTEM] Plan approved. Begin dispatching tasks.")` rather than calling `getOrInitAgent().prompt()`.

### Sub-Agent Completion Injection

When `RecoveryService.checkAllTerminal` or `notifyMasterPartialFailure` wants to notify the master agent, instead of calling `agent.prompt(message)`, it calls `getPlanningAgentManager().sendPrompt(projectId, message)`. This injects the completion status as a new turn for the planning agent to act on.

---

## New API Endpoints

Two new endpoints support planning agent tool calls:

### `POST /api/projects/:id/tasks`

Accepts a task list and dispatches them via `RecoveryService.dispatchTasksForProject`. Called by the planning agent `dispatch_tasks` tool.

**Request body:**
```json
{
  "tasks": [
    { "id": "...", "repositoryId": "...", "description": "...", "status": "pending" }
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
3. `restartFailedTasksTool` wiring moves from `getOrInitAgent` tool list to planning agent system prompt / tool injection
4. `RecoveryService.notifyMaster` implementation switches from `getOrInitAgent().prompt()` to `getPlanningAgentManager().sendPrompt()`

---

## Testing

- Unit tests for `PlanningAgentManager`: mock Docker client, verify `sendPrompt` queuing, `onOutput` registration, `stopContainer`
- Integration test (extends existing E2E pattern): project created → planning agent started → LGTM posted → planning agent dispatches task → sub-agent completes → completion injected back → project reaches `completed`
- Unit tests for new `/api/projects/:id/tasks` endpoint: verify dispatch call and status response

---

## Open Questions (resolved during design)

- **Per-turn vs persistent process:** Persistent process (container stays running) to preserve repo state and conversation context — avoids re-cloning on every turn.
- **Communication channel:** Docker stdin/stdout attach (bidirectional, low-latency) rather than named pipes or HTTP polling.
- **Session continuity:** Named Docker volume for JSONL session file — persists conversation across backend restarts without manual handoff.
- **Tool mechanism:** HTTP calls from inside container to `http://backend:3000/api/` on the `harness-agents` Docker network — same pattern used by implementation sub-agents.
