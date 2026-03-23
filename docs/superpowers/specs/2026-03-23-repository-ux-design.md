# Multi-Agent Harness Specification

## Overview

The **Multi-Agent Harness** is a PR-based planning and coordination system for orchestrating autonomous software engineering agents. It guides a Master Agent through a structured workflow—spec design, implementation planning, and parallel task execution—while managing sub-agents that implement individual tasks in isolated containers.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Frontend (React)                     │
│  Dashboard │ NewProject │ Chat │ Execution │ Settings   │
└─────────────────────┬───────────────────────────────────┘
                      │ REST + WebSocket
┌─────────────────────▼───────────────────────────────────┐
│                 Backend (Node.js/TypeScript)             │
│  ┌─────────────┐  ┌────────────┐  ┌──────────────────┐  │
│  │ MasterAgent │  │TaskDispatch│  │  PlanningTool    │  │
│  └─────────────┘  └────────────┘  └──────────────────┘  │
│  ┌─────────────────────────────────────────────────────┐│
│  │              VCS Connectors                          ││
│  │  GitHub  │  Bitbucket Server  │  Jira (issues)      ││
│  └─────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────┐│
│  │              Store (SQLite via better-sqlite3)       ││
│  │  Projects │ Repositories │ Sessions │ PullRequests   ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────┬───────────────────────────────────┘
                      │ Docker API
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
  ┌───────────┐ ┌───────────┐ ┌───────────┐
  │Sub-Agent  │ │Sub-Agent  │ │Sub-Agent  │
  │Container  │ │Container  │ │Container  │
  │(Task 1)   │ │(Task 2)   │ │(Task N)   │
  └───────────┘ └───────────┘ └───────────┘
```

---

## Core Domain Model

### Project
A software development initiative that follows the harness workflow.
- **States**: `brainstorming` → `spec_in_progress` → `awaiting_spec_approval` → `plan_in_progress` → `awaiting_plan_approval` → `executing` → `completed` | `failed` | `cancelled`
- **Source**: Jira tickets, GitHub issues, or freeform description
- **Repositories**: One or more repos where work will be performed
- **Planning PR**: A PR opened on the primary repository containing the spec and plan documents

### Repository
A VCS repository (GitHub or Bitbucket Server) that can be cloned and branched.
- Provider-specific configuration (owner/repo for GitHub, projectKey/repoSlug for Bitbucket)
- Auth resolved from environment variables at runtime

### AgentSession
A running or completed instance of either the Master Agent or a Sub-Agent.
- Tracks container ID, status, and session path for resumption

### PullRequest
A PR created by a sub-agent task or the planning process.
- Linked to project, repository, and agent session

### Plan & PlanTask
An implementation plan parsed from Markdown, containing tasks assigned to specific repositories.
- Tasks execute in parallel (MVP: no dependency ordering)

---

## Workflow Phases

### Phase 1 — Spec Design
1. User creates a project (via API or UI) with source (Jira/GitHub/freeform) and target repositories
2. Master Agent is initialized with a `write_planning_document` tool and custom skills
3. Agent explores repositories, asks clarifying questions, and calls `write_planning_document(type="spec", content)`
4. Backend commits spec to a planning branch, opens a PR, updates project status to `awaiting_spec_approval`
5. User reviews the PR, provides LGTM (or requests changes)
6. On approval, status moves to `plan_in_progress`

### Phase 2 — Implementation Planning
1. Master Agent continues, calling `write_planning_document(type="plan", content)`
2. Backend commits plan, parses tasks (via regex: `### Task N:` blocks with **Repository** and **Description** fields), stores them
3. Project status → `awaiting_plan_approval`
4. User reviews and approves
5. On approval, status → `executing`

### Phase 3 — Execution
1. TaskDispatcher dispatches all tasks in parallel (one per container)
2. Each container clones the repo, checks out/creates a feature branch, and receives a structured prompt instructing TDD workflow
3. Container runs the sub-agent (pi-coding-agent or OpenCode), which implements the task and commits
4. On completion, a PR is created for the branch (non-fatal if branch has no commits)
5. Project status → `completed` if all tasks succeed, `failed` if any fail

---

## Agent System

### Master Agent
- Initialized per project via `@mariozechner/pi-coding-agent`
- Receives custom tools: `write_planning_document`, `get_task_status`, `get_pull_requests`, `dispatch_tasks`
- Subscribes to session events (delta, message_complete, tool_call, error)
- Streams deltas via WebSocket to frontend
- Session persisted to disk for resume capability

### Sub-Agent
- Runs in isolated Docker container
- Image: `multi-agent-harness/sub-agent:latest` (configurable)
- Receives structured task prompt with TDD instructions and task description
- Clones repository, creates/uses branch, implements, commits
- Logs streamed to backend stdout for observability
- Configurable timeout (default: 30 minutes)

### Sub-Agent Bridge
- REST endpoint for sub-agents to report status and receive steering commands
- Allows re-prompting during task execution

---

## Connectors

### GitHub Connector
- Create branches, PRs, comments
- Fetch PR comments and review feedback
- Auth via `GITHUB_TOKEN` environment variable

### Bitbucket Server Connector
- Similar operations via Bitbucket REST API
- Auth via `BITBUCKET_TOKEN`

### Jira Connector (read-only MVP)
- Fetch issue details
- Uses `JIRA_BASE_URL`, `JIRA_TOKEN` env vars

### GitHub Issues Connector (read-only)
- Fetch issue content for spec context

---

## API Endpoints

### Projects
- `POST /api/projects` — Create project
- `GET /api/projects` — List projects
- `GET /api/projects/:id` — Get project
- `PATCH /api/projects/:id` — Update project (e.g., approve spec/plan)

### Repositories
- `POST /api/repositories` — Register repository
- `GET /api/repositories` — List repositories
- `DELETE /api/repositories/:id` — Remove repository

### Chat
- `POST /api/agents/:projectId/chat` — Send message to master agent
- `GET /api/agents/:projectId/stream` — SSE/WebSocket stream for responses

### Tasks & Execution
- `POST /api/projects/:id/dispatch` — Trigger task dispatch
- `GET /api/tasks/:id/status` — Get task status
- `GET /api/projects/:id/pull-requests` — List PRs created by tasks

### Settings
- `GET /api/settings` — Get configuration
- `PATCH /api/settings` — Update configuration

### Webhooks
- `POST /webhooks/github` — GitHub webhook receiver (for PR events)

---

## Frontend Pages

1. **Dashboard** — Project list with status indicators
2. **NewProject** — Create new project form
3. **Chat** — Interact with master agent via text
4. **PlanApproval** — View spec/plan, approve or request changes
5. **Execution** — Monitor running tasks and PR creation
6. **PrOverview** — View all PRs for a project
7. **Settings** — Configure harness settings

---

## Configuration (Environment Variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Backend HTTP port |
| `DATA_DIR` | `./data` | Data directory for SQLite DB and sessions |
| `DOCKER_PROXY_URL` | `http://docker-proxy:2375` | Docker daemon URL |
| `SUB_AGENT_IMAGE` | `multi-agent-harness/sub-agent:latest` | Sub-agent container image |
| `SUB_AGENT_NETWORK` | `multi-agent-harness_harness-agents` | Docker network for sub-agents |
| `SUB_AGENT_TIMEOUT_MS` | `1800000` (30 min) | Task timeout |
| `SUB_AGENT_MEMORY_BYTES` | `4294967296` (4 GB) | Container memory limit |
| `AGENT_PROVIDER` | `opencode-go` | Agent provider: `pi`, `opencode-go`, `opencode-zen` |
| `OPENCODE_API_KEY` | — | OpenCode API key |
| `GITHUB_TOKEN` | — | GitHub personal access token |
| `BITBUCKET_TOKEN` | — | Bitbucket personal access token |
| `HARNESS_UI_BASE_URL` | — | Base URL for harness UI links in PRs |

---

## Data Storage

- **SQLite** via `better-sqlite3`
- Tables: `projects`, `repositories`, `agent_sessions`, `pull_requests`, `review_comments`
- Session logs persisted as JSONL files in `data/sessions/{projectId}/master.jsonl`

---

## Non-Functional Requirements

- **Idempotency**: PR creation is non-fatal if branch has no changes
- **Observability**: Container logs streamed to backend stdout with `[container:label]` prefix
- **Resumability**: Master agent sessions persisted to disk
- **Parallelism**: Tasks execute in parallel; plan approval is sequential (human gate)
