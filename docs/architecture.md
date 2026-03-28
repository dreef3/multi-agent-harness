# Architecture

## Overview

Multi-Agent Harness is an orchestration system for AI coding agents. A **planning agent** collaborates with a human user through a web UI to design a spec and implementation plan, then dispatches **sub-agents** in isolated Docker containers to execute coding tasks. Sub-agents create pull requests, and the system monitors PR reviews to trigger automated fix runs.

The system is built on [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) (SDK + RPC mode) and supports multiple AI providers and VCS backends.

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
     │  │  PlanningAgentManager │ RecoveryService │ TaskDispatcher  │  │
     │  │  ContainerManager     │ HeartbeatMonitor│ DebounceEngine  │  │
     │  └──────┬───────────────────────────┬───────────────────────┘   │
     │         │                           │                           │
     │  ┌──────▼──────┐            ┌───────▼────────┐                  │
     │  │ Store       │            │ VCS Connectors  │                  │
     │  │ (SQLite)    │            │ GitHub │ Bitbuc.│                  │
     │  └─────────────┘            └────────────────┘                  │
     └─────────┬───────────────────────────┬───────────────────────────┘
               │ Docker API                │ TCP RPC (port 3333)
               │ (via socket proxy)        │
     ┌─────────▼─────────┐      ┌─────────▼──────────────────────────┐
     │ docker-proxy       │      │ Planning Agent Container           │
     │ (tecnativa)        │      │ pi-coding-agent (RPC mode)         │
     │ /var/run/docker.sock│     │ Custom tools → backend HTTP API    │
     └────────────────────┘      │ Repos cloned to /workspace/        │
                                 └────────────────────────────────────┘
                                          │
                                          │ dispatch_tasks
                                          ▼
                                 ┌────────────────────────────────────┐
                                 │ Sub-Agent Containers (1..N)        │
                                 │ pi-coding-agent (prompt mode)      │
                                 │ One task per container, auto-cleanup│
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

### Planning Agent

Each project gets a dedicated Docker container running pi-coding-agent in RPC mode. The backend communicates with it over a TCP connection to port 3333 inside the container (bypassing Docker attach limitations).

**Custom tools available to the planning agent:**

| Tool | Purpose |
|------|---------|
| `write_planning_document` | Commit spec/plan markdown to a PR branch |
| `dispatch_tasks` | Submit implementation tasks to sub-agents |
| `get_task_status` | Query current status of all tasks |
| `get_pull_requests` | List PRs created by sub-agents |
| `reply_to_subagent` | Answer a sub-agent's blocking question |
| `web_fetch` | HTTP fetch with SSRF protection |

The planning agent also has full access to pi-coding-agent's built-in tools (`read`, `write`, `edit`, `bash`) with a **guard hook** that blocks destructive operations (force push, `gh pr create`, credential URLs in commands).

### Sub-Agents

Each task spawns a short-lived Docker container that:
1. Clones the target repository and checks out the feature branch
2. Runs the task via `session.prompt(TASK_DESCRIPTION)` with TDD instructions
3. Commits changes and pushes to the branch
4. Container exits, harness creates the PR

Sub-agents have a `ask_planning_agent` tool for blocking clarification requests (5-min timeout). Activity events (tool calls, text deltas) are streamed to the backend via HTTP for real-time UI updates.

**Resource limits:** 4 GB memory, 2 CPU cores, 30-min timeout (all configurable).

### Concurrency Control

Two-tier semaphore system in `RecoveryService`:
- **Global limit**: max 3 concurrent sub-agent containers (configurable via `MAX_CONCURRENT_SUB_AGENTS`)
- **Per-project limit**: max 1 concurrent sub-agent per project (configurable via `MAX_IMPL_AGENTS_PER_PROJECT`)

Tasks queue behind semaphores and execute as slots become available.

## Communication Patterns

### WebSocket (Browser ↔ Backend)

Endpoint: `ws://backend:3000/ws?projectId={id}`

The backend bridges WebSocket to the planning agent's TCP RPC connection, streaming events to all connected clients for a project.

| Direction | Message Types |
|-----------|--------------|
| Server → Client | `delta`, `message_complete`, `conversation_complete`, `tool_call`, `tool_result`, `thinking`, `agent_activity`, `stuck_agent`, `replay`, `error` |
| Client → Server | `prompt`, `steer`, `resume` |

Early messages are buffered while the planning agent container starts (can take 5-120s).

### TCP RPC (Backend ↔ Planning Agent)

Port 3333 inside the planning agent container. Newline-delimited JSON (pi-coding-agent's built-in RPC protocol). The planning agent's `runner.mjs` overrides `process.stdout.write` to broadcast RPC output to all connected TCP sockets.

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

## Agent Provider Support

The harness supports multiple AI providers via pi-coding-agent's `ModelRegistry`:

| Provider | Planning Model (default) | Implementation Model (default) |
|----------|------------------------|-------------------------------|
| `pi` | claude-3-opus | claude-3-haiku |
| `opencode-go` | minimax-m2.7 | minimax-m2.7 |
| `google-gemini-cli` | gemini-2.5-pro | gemini-2.5-flash |
| `google-antigravity` | claude-sonnet-4-6 | gemini-3-flash |
| `openai-codex` | gpt-5.1 | gpt-5.1-codex-mini |
| `github-copilot` | (per subscription) | (per subscription) |

Configured via `AGENT_PLANNING_MODEL=<provider>/<model>` and `AGENT_IMPLEMENTATION_MODEL=<provider>/<model>`.

## Security Model

### Agent Sandboxing

Both planning and sub-agents run with a **bash guard hook** (`spawnHook`) that blocks:
- `git push --force`, `git branch -D` (destructive git)
- `gh pr create` (harness manages PRs)
- `gh repo delete/edit`, `gh api` (GitHub API abuse)
- `curl`, `wget` (replaced by `web_fetch` tool with SSRF protection)
- Commands containing embedded credential URLs

### Credential Isolation

- `GITHUB_TOKEN` is consumed during container setup (git credential store + gh auth) then **deleted from `process.env`** before the AI agent starts
- Sub-agents receive `GIT_PUSH_URL` with embedded token for clone/push, deleted after setup
- API keys are passed as env vars from the host, forwarded to containers via `PROVIDER_ENV_VARS` whitelist

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
  planning-agent # Build-only (started dynamically per project)
  sub-agent      # Build-only (started dynamically per task)

networks:
  default        # Backend ↔ frontend ↔ docker-proxy
  harness-agents # Backend ↔ planning-agent ↔ sub-agents

volumes:
  harness-data   # SQLite database
  harness-pi-auth # Shared OAuth tokens (e.g., GitHub Copilot)
```

Planning agent and sub-agent images are built by `docker compose build` but started dynamically by the backend via the Docker API — not by Compose itself.

## Key File Paths

| Area | Path | Purpose |
|------|------|---------|
| Backend entry | `backend/src/index.ts` | Startup, service wiring |
| Config | `backend/src/config.ts` | All env var parsing with defaults |
| Routes | `backend/src/api/routes.ts` | Express route registration |
| WebSocket | `backend/src/api/websocket.ts` | WS ↔ TCP RPC bridge |
| Orchestrator | `backend/src/orchestrator/` | Container, recovery, dispatch, planning mgr |
| Store | `backend/src/store/` | SQLite operations per entity |
| Connectors | `backend/src/connectors/` | GitHub + Bitbucket implementations |
| Types | `backend/src/models/types.ts` | All domain interfaces |
| Planning runner | `planning-agent/runner.mjs` | Container entrypoint + custom tools |
| Sub-agent runner | `sub-agent/runner.mjs` | Container entrypoint + event forwarding |
| Guard hooks | `*/tools.mjs` | Bash command blocking, web_fetch |
| Frontend pages | `frontend/src/pages/` | React page components |
| API client | `frontend/src/lib/api.ts` | REST client |
| WS client | `frontend/src/lib/ws.ts` | WebSocket with auto-reconnect |
