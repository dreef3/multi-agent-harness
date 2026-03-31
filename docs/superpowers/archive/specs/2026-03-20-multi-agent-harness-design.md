# Multi-Agent Coding Harness — Design Spec

## Goal

An autonomous multi-agent coding harness where a master agent brainstorms and plans interactively with a user via a web UI, then dispatches sub-agents in Docker containers to execute coding tasks across multiple repositories. Sub-agents create PRs and fix human review comments with configurable debounce.

## Architecture

A Node.js backend orchestrates everything. The master agent runs pi-coding-agent in-process (SDK mode) for interactive brainstorming and plan writing. Sub-agents run pi-coding-agent in Docker containers (RPC mode), one per repository. Communication follows ACP (Agent Client Protocol) over pi's built-in RPC. The React frontend connects via WebSocket for streaming and REST for CRUD operations.

## Tech Stack

- **Frontend:** React + TypeScript, Vite, TailwindCSS
- **Backend:** Node.js + TypeScript, Express, WebSocket
- **AI Agent:** pi-coding-agent (SDK mode for master, RPC mode for sub-agents)
- **Protocol:** ACP over pi built-in RPC
- **Containers:** Docker, managed via dockerode
- **Persistence:** SQLite (via better-sqlite3)
- **VCS:** Octokit (GitHub), Bitbucket Server REST API v1.0
- **Issue Tracking:** JIRA Server REST API v2
- **Orchestration:** Docker Compose
- **MVP Language Support:** Kotlin/Java + Maven

---

## Sub-Projects

This system is decomposed into three sub-projects, each independently shippable:

1. **Foundation** — Docker setup, sub-agent container image, pi-agent RPC bridge, orchestrator
2. **Web UI + Master Agent** — Node.js backend API, React frontend, interactive brainstorm/plan/approve flow
3. **Connectors + PR Lifecycle** — JIRA, GitHub, Bitbucket Server connectors, debounce engine

---

## 1. Data Model

### Project

The top-level unit of work. Created from JIRA ticket(s) or a free-form request.

```typescript
interface Project {
  id: string;
  name: string;
  status: "brainstorming" | "planning" | "awaiting_approval" | "executing" | "completed" | "failed" | "cancelled";
  source: {
    type: "jira" | "freeform";
    jiraTickets?: string[];       // JIRA issue keys
    freeformDescription?: string;
  };
  repositoryIds: string[];        // repos involved
  plan?: Plan;
  masterSessionPath: string;      // pi session file path
  createdAt: string;
  updatedAt: string;
}
```

### Plan

Produced by the master agent during the planning phase.

```typescript
interface Plan {
  id: string;
  projectId: string;
  content: string;                // full plan markdown
  tasks: PlanTask[];
  approved: boolean;
  approvedAt?: string;
}

interface PlanTask {
  id: string;
  repositoryId: string;
  description: string;            // what the sub-agent should do
  status: "pending" | "executing" | "completed" | "failed" | "cancelled";
  dependsOn?: string[];           // task IDs that must complete first (MVP: not used, all tasks independent)
}
```

### Repository

A configured git repository with VCS provider details.

```typescript
interface Repository {
  id: string;
  name: string;
  cloneUrl: string;
  provider: "github" | "bitbucket-server";
  providerConfig: {
    // GitHub
    owner?: string;
    repo?: string;
    // Bitbucket Server
    projectKey?: string;
    repoSlug?: string;
    baseUrl?: string;
  };
  defaultBranch: string;
  // Credentials resolved from environment variables at runtime:
  // GitHub: GITHUB_TOKEN env var
  // Bitbucket: BITBUCKET_TOKEN env var
  // Clone auth: token embedded in cloneUrl or git credential helper
}
```

### AgentSession

Wraps a running pi-coding-agent instance.

```typescript
interface AgentSession {
  id: string;
  projectId: string;
  type: "master" | "sub";
  repositoryId?: string;          // for sub-agents
  taskId?: string;                // for sub-agents
  containerId?: string;           // Docker container ID for sub-agents
  status: "starting" | "running" | "completed" | "failed" | "stopped";
  sessionPath?: string;           // pi session file path (enables resume)
  createdAt: string;
  updatedAt: string;
}
```

### PullRequest

A PR created by a sub-agent.

```typescript
interface PullRequest {
  id: string;
  projectId: string;
  repositoryId: string;
  agentSessionId: string;
  provider: "github" | "bitbucket-server";
  externalId: string;             // PR number or ID on the VCS
  url: string;
  branch: string;
  status: "open" | "merged" | "declined";
  createdAt: string;
  updatedAt: string;
}
```

### ReviewComment

A human review comment on a PR, collected for debounce.

```typescript
interface ReviewComment {
  id: string;
  pullRequestId: string;
  externalId: string;             // comment ID on VCS
  author: string;
  body: string;
  filePath?: string;
  lineNumber?: number;
  status: "pending" | "batched" | "fixing" | "fixed" | "ignored";
  receivedAt: string;
}
```

---

## 2. Backend Structure

```
backend/
  src/
    index.ts                  # entry point, server bootstrap
    config.ts                 # environment + settings
    api/
      routes.ts               # REST route registration (includes GET /health)

      websocket.ts            # WebSocket handler
      projects.ts             # project CRUD + chat proxy
      repositories.ts         # repository CRUD
      agents.ts               # agent status + logs
      pullRequests.ts         # PR listing + manual trigger
      jira.ts                 # JIRA search proxy
      settings.ts             # configuration endpoints
    agents/
      masterAgent.ts          # pi SDK wrapper for master agent
      subAgentBridge.ts       # pi RPC bridge for sub-agents (ACP over stdio)
    orchestrator/
      containerManager.ts     # dockerode: create/start/stop/remove containers
      imageBuilder.ts         # build/pull sub-agent Docker image (runs on backend startup, fails fast if Docker unavailable)
      taskDispatcher.ts       # plan → container mapping, parallel launch
    connectors/
      types.ts                # shared VCS connector interface
      github.ts               # Octokit: branches, commits, PRs, webhooks
      bitbucket.ts            # Bitbucket Server REST: branches, commits, PRs, polling
      jira.ts                 # JIRA Server REST: search, read, update
    debounce/
      engine.ts               # timer management, batch collection
      strategies.ts           # configurable debounce strategies
    store/
      db.ts                   # SQLite connection + migrations
      projects.ts             # project queries
      repositories.ts         # repository queries
      agents.ts               # agent session queries
      pullRequests.ts         # PR + comment queries
    models/
      types.ts                # all TypeScript interfaces (above)
```

---

## 3. Master Agent Integration

The master agent runs pi-coding-agent in-process using its SDK.

### Initialization

```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent";

const { session } = await createAgentSession({
  cwd: projectWorkDir,
  sessionManager: SessionManager.file(sessionDir),
  // skills loaded from pi's resource loader (brainstorming, writing-plans)
});
```

### WebSocket Bridge

1. Frontend opens `WS /api/projects/:id/chat`
2. Backend creates or resumes a pi session for the project
3. User messages from WebSocket → `session.prompt(text)`
4. Backend subscribes to session events → streams text deltas to WebSocket
5. All agent messages persisted to SQLite as an append-only log with sequential `seqId`
6. On WebSocket reconnect, client sends `{ type: "resume", lastSeqId: N }` → backend replays messages from `seqId > N`
7. When plan is complete, backend parses the plan document and creates PlanTask records

### Plan Parsing

The master agent produces a plan as markdown. The backend extracts structured tasks using a convention:

- Each task is a `### Task N: <title>` heading
- Each task contains a `**Repository:** <repo-name>` line matching a configured repository name
- Each task contains a `**Description:**` block with the sub-agent instructions

The backend parses this with a simple regex/markdown parser. If parsing fails (missing repo match, malformed structure), the project stays in `awaiting_approval` and the UI shows a warning asking the user to ask the master agent to reformat the plan.

### Session Lifecycle

- **brainstorming**: master agent runs brainstorming skill interactively
- **planning**: master agent writes implementation plan
- **awaiting_approval**: plan rendered in UI, user approves or requests changes
- On steer/interrupt: `session.steer(text)` for mid-stream corrections

---

## 4. Sub-Agent Containers

### Docker Image

```dockerfile
FROM node:20.18-slim

RUN apt-get update && apt-get install -y \
    git \
    openjdk-17-jdk-headless \
    maven=3.9.* \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @mariozechner/pi-coding-agent

WORKDIR /workspace
ENTRYPOINT ["pi", "--rpc"]
```

### Container Lifecycle

1. **Create**: `dockerode.createContainer()` with:
   - Image: `multi-agent-harness/sub-agent:latest`
   - Volumes: git credentials mounted read-only at `/run/secrets/git-credentials`
   - Secrets: `ANTHROPIC_API_KEY` injected via mounted file at `/run/secrets/api-key` (not env var — env vars are visible via `docker inspect`)
   - Environment: repo clone URL, branch name (non-secret config only)
   - Working dir: `/workspace`
   - Network: `harness-agents` (isolated, outbound internet only — no access to backend or other containers)
   - Resource limits: 4GB RAM, 2 CPU cores, 10GB disk (configurable in settings)

2. **Start**: container starts, pi enters RPC mode, waits for input

3. **Initialize**: backend attaches to container stdio, sends ACP `session/initialize`

4. **Clone & Execute**: backend sends initial prompt:
   - Clone the repository
   - Checkout new branch `agent/<project-id>/<task-id>`
   - Execute the plan task
   - Commit and push when done

5. **Monitor**: backend streams sub-agent output to frontend via WebSocket

6. **Completion Detection**: the sub-agent signals completion by sending a final RPC message with `type: "session/update"` containing `status: "completed"`. The backend also watches for the pi process exiting (exit code 0 = success, non-zero = failure).

7. **PR Creation**: on completion signal, backend creates PR via VCS connector

8. **Keep Alive**: container stays running for potential fix runs from debounce

9. **Teardown**: on project close or configurable timeout (default 1 hour idle), container stopped and removed

### Parallel Execution

- One container per repository
- All containers launched in parallel after plan approval (MVP assumes all tasks are independent — if the plan contains cross-repo dependencies, the user should reorder/approve accordingly)
- Backend tracks status of each independently
- Frontend shows per-repo tabs with live logs

### Error Handling

- **Container crash**: dockerode watches container state via events API. On unexpected exit, mark AgentSession as `failed`, notify frontend, log last 100 lines of container output.
- **Agent hang**: configurable execution timeout (default 30 minutes). If no RPC message received within timeout, send `session/cancel`, wait 10s, force-kill container. Mark task as `failed`.
- **Partial failure**: if some sub-agents succeed and others fail, completed tasks proceed to PR creation. Failed tasks shown in UI with error details. User can retry individual tasks.
- **Retry**: `POST /api/projects/:id/tasks/:taskId/retry` — spins up a new container for the failed task. Max 3 retries per task.
- **Network errors**: if clone/push fails, sub-agent reports error via RPC. Backend surfaces in UI with actionable message (check credentials, repo access).

---

## 5. VCS Connectors

### Shared Interface

```typescript
interface VcsConnector {
  createBranch(repo: Repository, branchName: string, fromRef: string): Promise<void>;
  createPullRequest(repo: Repository, params: {
    title: string;
    description: string;
    sourceBranch: string;
    targetBranch: string;
  }): Promise<{ id: string; url: string }>;
  getPullRequest(repo: Repository, prId: string): Promise<{ status: string; url: string }>;
  getComments(repo: Repository, prId: string, since?: string): Promise<VcsComment[]>;
  addComment(repo: Repository, prId: string, body: string): Promise<void>;
}
```

### GitHub Connector

- Uses `@octokit/rest` SDK
- Auth: PAT or GitHub App installation token
- PR comments: webhook `pull_request_review_comment` + `pull_request_review` events
- Webhook endpoint: `POST /api/webhooks/github`

### Bitbucket Server Connector

- Direct REST API v1.0 calls (`/rest/api/1.0/projects/{key}/repos/{slug}/...`)
- Auth: PAT (HTTP Bearer)
- PR comments: **polling** on interval (Bitbucket Server webhooks are unreliable for comments)
- Poll interval: configurable, default 60s
- Deduplication: comments upserted by `externalId` (unique constraint in SQLite) to prevent duplicates across polls or backend restarts

---

## 6. JIRA Server Connector

- REST API v2 (`/rest/api/2/search`, `/rest/api/2/issue/{key}`)
- Auth: PAT (HTTP Bearer) or Basic Auth
- Used at project creation time:
  - `GET /api/jira/search?jql=...` → proxied to JIRA search
  - Frontend renders ticket list, user selects one or more
  - Selected ticket descriptions + comments fed to master agent as context
- Optional: update ticket status when project starts/completes

---

## 7. Debounce Engine

### Configuration

```typescript
interface DebounceConfig {
  strategy: "timer";
  delayMs: number;               // default: 600000 (10 minutes)
}
```

Configurable per-repository in settings.

### Flow

1. **Receive**: webhook (GitHub) or poll (Bitbucket) delivers new comment
2. **Store**: comment saved to SQLite with status `pending`
3. **Reset Timer**: if a timer exists for this PR, cancel and restart with `delayMs`
4. **Fire**: when timer expires:
   - Collect all `pending` comments for the PR → mark as `batched`
   - Format as fix instructions
   - Send to the sub-agent container (reuse existing or spin up new one)
   - Sub-agent reads comments, makes fixes, commits, pushes
   - Comments marked `fixed` on success
5. **Manual Trigger**: `POST /api/projects/:id/prs/:prId/fix` fires immediately, bypasses timer

### Persistence

Timers reconstructed on backend restart by checking `pending` comments and their `receivedAt` timestamps against the configured delay.

---

## 8. React Frontend

### Views

| Route | View | Description |
|-------|------|-------------|
| `/` | Dashboard | Active projects, status badges, sub-agent health |
| `/projects/new` | New Project | JIRA search + ticket picker, free-form input, repo multi-select |
| `/projects/:id/chat` | Chat | Streaming master agent conversation, markdown rendering |
| `/projects/:id/plan` | Plan Approval | Plan viewer, task breakdown per repo, approve/reject buttons |
| `/projects/:id/execute` | Execution | Tabbed sub-agent logs (one per repo), progress indicators |
| `/projects/:id/prs` | PR Overview | All PRs, comment list, debounce countdown, manual fix trigger |
| `/settings` | Settings | VCS credentials, JIRA config, debounce strategy, API keys |

### Tech

- React 18+ with TypeScript
- Vite for build/dev
- TailwindCSS for styling
- WebSocket client for streaming agent output
- React Router for navigation
- Markdown rendering for plan display and agent messages (react-markdown)

---

## 9. Docker Compose

```yaml
services:
  backend:
    build: ./backend
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    env_file:
      - .env
    # Docker socket access: using a socket proxy with restricted permissions
    # instead of mounting the raw socket (which gives root-equivalent host access).
    depends_on:
      - docker-proxy

  docker-proxy:
    image: tecnativa/docker-socket-proxy
    environment:
      CONTAINERS: 1
      IMAGES: 1
      NETWORKS: 1
      POST: 1
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    # Backend connects to docker-proxy:2375 instead of raw socket

  frontend:
    build: ./frontend
    ports:
      - "8080:80"
    depends_on:
      - backend
    # nginx serves built React app
    # proxies /api and /ws to backend:3000

networks:
  harness-agents:
    # Isolated network for sub-agent containers.
    # Sub-agents get outbound internet (git clone/push, Anthropic API)
    # but cannot reach backend, docker-proxy, or each other.
    driver: bridge
    internal: false

# Sub-agent containers are NOT defined here.
# They are created dynamically by the backend via Docker API.
# The sub-agent image is built on first run or via:
#   docker build -t multi-agent-harness/sub-agent ./sub-agent
```

### .env

```
ANTHROPIC_API_KEY=
JIRA_BASE_URL=
JIRA_TOKEN=
GITHUB_TOKEN=
BITBUCKET_BASE_URL=
BITBUCKET_TOKEN=
```

---

## 10. Project Directory Structure

```
multi-agent-harness/
  backend/
    src/                      # Node.js backend (structure in Section 2)
    package.json
    tsconfig.json
    Dockerfile
  frontend/
    src/                      # React app
    package.json
    tsconfig.json
    vite.config.ts
    Dockerfile
    nginx.conf
  sub-agent/
    Dockerfile                # Sub-agent container image
  docker-compose.yml
  .env.example
  docs/
    superpowers/
      specs/                  # this file
      plans/                  # implementation plans
```

---

## 11. MVP Scope

For MVP, the following is in scope:

- Single user (no auth on the web UI)
- One JIRA Server instance
- GitHub and Bitbucket Server connectors
- Kotlin/Java + Maven projects only (sub-agent image ships with JDK 17 + Maven)
- SQLite persistence (no external DB)
- Timer-based debounce only (no other strategies)
- No CI/CD integration (PRs created, humans merge)

Out of scope for MVP:

- Multi-user / auth
- JIRA Cloud
- GitHub Actions / CI integration
- Non-JVM language support
- Kubernetes deployment
- Agent cost tracking / budgets
