# Architecture

## Overview

Multi-Agent Harness is an orchestration system for AI coding agents. A **planning agent** collaborates with a human user through a web UI to design a spec and implementation plan, then dispatches **sub-agents** in isolated Docker containers to execute coding tasks. Sub-agents create pull requests, and the system monitors PR reviews to trigger automated fix runs.

The system supports five interchangeable agent backends (Pi, Gemini, Claude, Copilot, OpenCode), all communicating over the **ACP (Agent Communication Protocol)** JSON-RPC 2.0 protocol. Each agent type runs in its own Docker image derived from a shared base image.

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Browser                                                                │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  React Frontend (Vite + Tailwind)                                │   │
│  │  Dashboard │ NewProject │ Chat │ Execution │ PrOverview │ Settings│  │
│  └──────────┬────────────────────────────┬──────────────────────────┘   │
│             REST                       WebSocket                        │
└─────────────┼────────────────────────────┼──────────────────────────────┘
              │                            │
     ┌────────▼────────────────────────────▼────────────────────────────┐
     │  nginx (frontend container, port 9999)                           │
     │  /api/* → proxy to backend:3000                                  │
     │  /ws    → proxy to backend:3000 (upgrade)                        │
     └────────┬────────────────────────────┬────────────────────────────┘
              │                            │
     ┌────────▼────────────────────────────▼────────────────────────────┐
     │  Express Backend (port 3000)                                     │
     │                                                                  │
     │  ┌─────────┐  ┌──────────────┐  ┌────────────┐  ┌───────────┐  │
     │  │ REST API │  │ WebSocket    │  │ Polling    │  │ Webhooks  │  │
     │  │ (CRUD)  │  │ (streaming)  │  │ (60s loop) │  │ (GitHub)  │  │
     │  └────┬────┘  └──────┬───────┘  └─────┬──────┘  └─────┬─────┘  │
     │       │               │                │               │        │
     │  ┌────▼───────────────▼────────────────▼───────────────▼─────┐  │
     │  │                   Orchestrator Layer                      │  │
     │  │  AcpAgentManager  │ RecoveryService │ TaskDispatcher      │  │
     │  │  ContainerManager │ HeartbeatMonitor│ DebounceEngine      │  │
     │  └──────┬───────────────────────────┬───────────────────────┘   │
     │         │                           │                           │
     │  ┌──────▼──────┐    ┌───────────────▼────────────┐              │
     │  │ Store       │    │ VCS Connectors              │              │
     │  │ (SQLite)    │    │ GitHub │ Bitbucket          │              │
     │  └─────────────┘    └────────────────────────────┘              │
     │                                                                  │
     │  ┌───────────────────────────────────────────────────────────┐  │
     │  │  MCP SSE Server  (/api/mcp)                               │  │
     │  │  Planning tools: dispatch_tasks, get_task_status,         │  │
     │  │  get_pull_requests, write_planning_document,              │  │
     │  │  reply_to_subagent, web_fetch, get_build_status,          │  │
     │  │  get_build_logs                                            │  │
     │  │  Token auth: MCP_TOKEN per agent session (UUID)           │  │
     │  └───────────────────────────────────────────────────────────┘  │
     └─────────┬───────────────────────────┬───────────────────────────┘
               │ Docker API                │ TCP ACP (port 3333)
               │ (via socket proxy)        │
     ┌─────────▼─────────┐      ┌─────────▼──────────────────────────┐
     │ docker-proxy       │      │ Planning Agent Container           │
     │ (tecnativa)        │      │ agent-{pi,gemini,claude,copilot,   │
     │ /var/run/docker.sock│     │          opencode}                  │
     └────────────────────┘      │ stdio-TCP bridge → ACP subprocess  │
                                 │ MCP SSE → backend:3000/mcp         │
                                 └────────────────────────────────────┘
                                          │
                                          │ dispatch_tasks (MCP tool)
                                          ▼
                                 ┌────────────────────────────────────┐
                                 │ Sub-Agent Containers (1..N)        │
                                 │ Short-lived, one task per container│
                                 │ Repo cloned to /workspace/repo     │
                                 │ Events → backend HTTP API          │
                                 │ Heartbeat every 2 min              │
                                 └────────────────────────────────────┘
```

## Core Concepts

### Project Lifecycle

A project progresses through a state machine:

```
brainstorming
    │  user sends first message via WebSocket
    ▼
spec_in_progress
    │  planning agent calls write_planning_document(type="spec")
    ▼
awaiting_spec_approval
    │  LGTM comment on PR (detected by polling)
    ▼
plan_in_progress
    │  planning agent calls write_planning_document(type="plan")
    ▼
awaiting_plan_approval
    │  LGTM comment on PR (detected by polling)
    ▼
executing
    │  planning agent calls dispatch_tasks → sub-agents run
    ▼
completed ◄── all PRs merged (detected by polling)
    or
failed ◄── all tasks terminal, at least one failed
```

Users can reactivate a `completed` project by sending a new message. Failed projects can be retried via the Dashboard.

### Supported Agents

Five agent types are supported, selected per-project via the UI or env vars:

| Type | Image | Auth |
|------|-------|------|
| `pi` | `multi-agent-harness/agent-pi` | `COPILOT_GITHUB_TOKEN` or `PI_ENABLED=true` |
| `gemini` | `multi-agent-harness/agent-gemini` | `GEMINI_API_KEY` |
| `claude` | `multi-agent-harness/agent-claude` | `ANTHROPIC_API_KEY` |
| `copilot` | `multi-agent-harness/agent-copilot` | `COPILOT_GITHUB_TOKEN` |
| `opencode` | `multi-agent-harness/agent-opencode` | `ANTHROPIC_API_KEY` or `OPENCODE_ENABLED=true` |

Each agent image is built `FROM multi-agent-harness/agent-base` which provides Node.js, git, gh CLI, and the stdio-TCP bridge.

### AcpAgentManager

`AcpAgentManager` (replacing the old `PlanningAgentManager`) manages the lifecycle of planning agent containers and communicates with them over the ACP JSON-RPC 2.0 protocol:

1. **Container start**: `ensureRunning(agentId, agentType, role, envVars)` starts the container and waits for the TCP port to be ready.
2. **Message send**: `sendPrompt(agentId, text)` sends an `acp/run` request over the TCP connection.
3. **Output streaming**: `onOutput(agentId, callback)` subscribes to ACP notification events forwarded to all WebSocket clients for the project.
4. **Idle timeout**: Containers are torn down after 1 hour of no active WebSocket connections.

### stdio-TCP Bridge Pattern

Agents that use CLI tools (Pi, Gemini, Claude, OpenCode) do not natively listen on a TCP port. The `stdio-tcp-bridge.mjs` script wraps any ACP subprocess:

```
TCP :3333 ←→ stdio-tcp-bridge.mjs ←→ agent subprocess (stdin/stdout)
```

The Copilot agent supports native ACP over TCP and does not use the bridge.

### Planning Agent

Each project gets a dedicated Docker container. The backend communicates with it over TCP port 3333 using the ACP (Agent Communication Protocol) JSON-RPC 2.0 protocol.

**MCP tools available to the planning agent** (via SSE at `/api/mcp`):

| Tool | Purpose |
|------|---------|
| `write_planning_document` | Commit spec/plan markdown to a PR branch |
| `dispatch_tasks` | Submit implementation tasks to sub-agents |
| `get_task_status` | Query current status of all tasks |
| `get_pull_requests` | List PRs created by sub-agents |
| `reply_to_subagent` | Answer a sub-agent's blocking question |
| `web_fetch` | HTTP fetch with SSRF protection |
| `get_build_status` | Get CI build status for a pull request |
| `get_build_logs` | Fetch CI build logs for a specific build URL |

### Sub-Agents

Each task spawns a short-lived Docker container that:
1. Clones the target repository and checks out the feature branch
2. Runs the task via the implementation agent prompt with TDD instructions
3. Commits changes and pushes to the branch
4. Container exits, harness creates the PR

Sub-agents have an `ask_planning_agent` MCP tool for blocking clarification requests (5-min timeout). Activity events (tool calls, text deltas) are streamed to the backend via HTTP for real-time UI updates.

**Resource limits:** 4 GB memory, 2 CPU cores, 30-min timeout (all configurable).

### Per-Project Agent Configuration

Each project can independently configure its planning and implementation agents via the UI (Settings → Agent Configuration) or the API:

```
PUT /api/projects/:id/agent-config
{ "planningAgent": { "type": "claude", "model": "claude-opus-4" },
  "implementationAgent": { "type": "gemini", "model": "gemini-2.5-flash" } }
```

Agent availability is reported by `GET /api/config/available-agents`. An agent is available if its required API key env var is set, or if `{TYPE}_ENABLED=true` is set (for device-auth flows like Pi and OpenCode that don't require a static API key).

### Concurrency Control

Two-tier semaphore system in `RecoveryService`:
- **Global limit**: max 3 concurrent sub-agent containers (configurable via `MAX_CONCURRENT_SUB_AGENTS`)
- **Per-project limit**: max 1 concurrent sub-agent per project (configurable via `MAX_IMPL_AGENTS_PER_PROJECT`)

Tasks queue behind semaphores and execute as slots become available.

## Communication Patterns

### WebSocket (Browser ↔ Backend)

Endpoint: `ws://backend:3000/ws?projectId={id}`

The backend bridges WebSocket to the planning agent's TCP ACP connection, streaming events to all connected clients for a project.

| Direction | Message Types |
|-----------|--------------|
| Server → Client | `acp:agent_message_chunk`, `acp:tool_call`, `acp:tool_call_update`, `acp:plan`, `acp:turn_complete`, `agent:stopped`, `agent:crashed`, `agent_activity`, `stuck_agent`, `replay`, `error` |
| Client → Server | `prompt`, `steer`, `resume` |

Early messages are buffered while the planning agent container starts (can take 5-120s).

### TCP ACP (Backend ↔ Planning Agent)

Port 3333 inside the planning agent container. ACP JSON-RPC 2.0 over a persistent TCP socket. The backend sends `acp/run` requests and receives notifications (`acp/agentMessageChunk`, `acp/toolCall`, `acp/turnComplete`, etc.).

### MCP SSE (Planning Agent ↔ Backend)

Endpoint: `GET /api/mcp?token={MCP_TOKEN}&projectId={id}&role={planning|implementation}`

The MCP server uses SSE for server-to-client streaming and `POST /api/mcp/messages` for client-to-server messages. Each agent session receives a unique `MCP_TOKEN` (UUID) via the `MCP_TOKEN` env var. The token is validated on every connection attempt and revoked when the agent stops.

### REST (Sub-Agent ↔ Backend)

Sub-agents call the backend API to:
- Post activity events: `POST /api/agents/:id/events`
- Send heartbeats: `POST /api/agents/:id/heartbeat`
- Ask planning agent: `POST /api/agents/:id/message` (blocks up to 5 min)

### Polling (Backend → VCS)

Every 60 seconds the backend polls all open PRs:
- Fetches new review comments and upserts them
- Syncs PR status (open/merged/declined)
- Detects LGTM comments to advance spec/plan approval
- Marks project `completed` when all PRs reach terminal state

New comments trigger the `DebounceEngine` (10-min window) which batches review feedback into fix runs.

## Data Layer

### SQLite Database

Located at `{DATA_DIR}/harness.db` with WAL mode and foreign keys enabled.

| Table | Purpose |
|-------|---------|
| `repositories` | VCS repository metadata and provider config |
| `projects` | Project state, source config, plan JSON, planning PR |
| `agent_sessions` | Master and sub-agent session records with container IDs |
| `messages` | Chat message history (user + assistant, ordered by seq_id) |
| `pull_requests` | PRs created by sub-agents, tracked by external ID |
| `review_comments` | PR review comments with debounce status |
| `agent_events` | Sub-agent activity events (tool calls, text, results) |

### Key Relationships

```
Project 1──* Repository      (via repositoryIds JSON array)
Project 1──* AgentSession    (master + sub sessions)
Project 1──* PullRequest     (via projectId FK)
Project 1──* Message         (chat history)
PullRequest 1──* ReviewComment
AgentSession 1──* AgentEvent
```

## VCS Connector Abstraction

The `VcsConnector` interface (`backend/src/connectors/types.ts`) abstracts version control operations:

| Method | Purpose |
|--------|---------|
| `createBranch` | Create feature branch from default branch |
| `createPullRequest` | Open a PR with title/description |
| `getPullRequest` | Get PR status (open/merged/declined) |
| `findPullRequestByBranch` | Look up PR by head branch name |
| `getComments` | Fetch review comments (optionally since timestamp) |
| `addComment` | Post a comment on a PR |
| `commitFile` | Commit a file to a branch (optionally creating the branch) |

Implementations: `GitHubConnector` (via Octokit) and `BitbucketConnector` (REST API v1.0).

## Security Model

### Guard Hooks

Planning agents run with guard hooks that block destructive operations:

**Claude** (`agents/claude/guard-hook.sh`, triggered via `PreToolUse` hook):
- Blocks `WebSearch` and `WebFetch` built-in tools (use MCP `web_fetch` instead)
- Blocks dangerous bash patterns: `git push --force`, `git branch -D`, `gh pr create`, `gh repo delete`, `gh api`

**Pi** (`agents/pi/guard-hook.mjs`, BashSpawnHook format):
- Blocks `curl`, `wget`, `WebSearch`, `WebFetch`
- Blocks all of the above git/gh patterns

Claude's `settings.json` also sets `"disabledTools": ["WebSearch", "WebFetch"]` as an additional layer.

### MCP Token Authentication

Each planning agent session receives a unique UUID `MCP_TOKEN` via environment variable. The MCP SSE server validates this token on every connection:
- Token is registered in `validTokens` before the container starts
- Token is passed to the container as `MCP_TOKEN` env var
- Agents include `?token=...` in their MCP server URL
- Token is revoked when the agent stops, crashes, or the WebSocket client disconnects

### Credential Isolation

- `GITHUB_TOKEN` is consumed during container setup then deleted from the process environment before the AI agent starts
- API keys are passed as env vars from the host, forwarded to containers via a whitelist: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `COPILOT_GITHUB_TOKEN`, `GEMINI_API_KEY`

### Network

- Sub-agents run on a dedicated Docker network (`harness-agents`)
- Docker API access is proxied through `tecnativa/docker-socket-proxy` (not direct socket mount)

### Token Reduction

- **RTK binary**: Prepended to bash commands via spawnHook, applies intelligent output filtering (40-90% token savings)
- **Output filter extension**: Truncates oversized `read`/`find` tool results (12K/4K character thresholds)

## Observability

### OpenTelemetry

The backend exports traces and metrics via OTLP HTTP:
- **Traces**: `task.dispatch`, `container.run` spans with project/task/session attributes
- **Metrics**: `harness.tasks.dispatched` counter, `harness.agents.active` gauge, `harness.agents.active_per_project` gauge
- **Export endpoint**: `http://host.docker.internal:4318` (configurable via `OTEL_EXPORTER_OTLP_ENDPOINT`)

### Logging

Console-based logging with `[module]` prefixes. Container logs are streamed to backend stdout with `[container:label]` prefix for centralized visibility.

### Health Monitoring

- Sub-agent heartbeat every 2 minutes → `HeartbeatMonitor` detects stuck agents after 4 minutes of silence
- `RecoveryService` scans for stale sessions (>35 min) on boot and in each polling cycle
- Planning agent has retry with exponential backoff (5s → 15s → 30s → 60s → 120s)

## Docker Infrastructure

```yaml
services:
  backend        # Express server, port 3000
  frontend       # nginx serving React build, port 9999
  docker-proxy   # Socket proxy for Docker API access
  agent-base     # Build-only base image (node:22-slim + git + gh)
  agent-base-ubi   # Build-only UBI8 variant (ubi8/nodejs-22-minimal)
  agent-base-wolfi # Build-only Wolfi variant (cgr.dev/chainguard/node)
  agent-pi       # Build-only: pi-acp planning agent
  agent-gemini   # Build-only: gemini-cli ACP agent
  agent-claude   # Build-only: claude-code ACP agent
  agent-copilot  # Build-only: GitHub Copilot ACP agent
  agent-opencode # Build-only: opencode ACP agent

networks:
  default        # Backend ↔ frontend ↔ docker-proxy
  harness-agents # Backend ↔ agent containers

volumes:
  harness-data   # SQLite database
  harness-pi-auth # Shared OAuth tokens (e.g., GitHub Copilot)
```

Agent images are built by `docker compose build --profile build-only` but started dynamically by the backend via the Docker API — not by Compose itself.

## Key File Paths

| Area | Path | Purpose |
|------|------|---------|
| Backend entry | `backend/src/index.ts` | Startup, service wiring |
| Config | `backend/src/config.ts` | All env var parsing with defaults |
| Routes | `backend/src/api/routes.ts` | Express route registration |
| WebSocket | `backend/src/api/websocket.ts` | WS ↔ ACP TCP bridge + MCP token lifecycle |
| Agent config API | `backend/src/api/agentConfig.ts` | Per-project agent type selection |
| Orchestrator | `backend/src/orchestrator/` | Container, recovery, dispatch, ACP agent mgr |
| MCP server | `backend/src/mcp/server.ts` | MCP SSE server with token auth |
| MCP tools | `backend/src/mcp/tools/` | Individual tool implementations |
| Store | `backend/src/store/` | SQLite operations per entity |
| Connectors | `backend/src/connectors/` | GitHub + Bitbucket implementations |
| Types | `backend/src/models/types.ts` | All domain interfaces |
| Agent base | `agents/base/Dockerfile.base` | Shared base image (debian) |
| Agent base UBI | `agents/base/Dockerfile.base.ubi` | UBI8 variant |
| Agent base Wolfi | `agents/base/Dockerfile.base.wolfi` | Wolfi/Chainguard variant |
| stdio-TCP bridge | `agents/stdio-tcp-bridge.mjs` | Wraps CLI agents behind TCP :3333 |
| Claude guard | `agents/claude/guard-hook.sh` | Claude PreToolUse guard hook |
| Pi guard | `agents/pi/guard-hook.mjs` | Pi BashSpawnHook guard |
| Frontend pages | `frontend/src/pages/` | React page components |
| API client | `frontend/src/lib/api.ts` | REST client |
| WS client | `frontend/src/lib/ws.ts` | WebSocket with auto-reconnect |
