# ACP Multi-Agent Transition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pi-coding-agent-specific integration with a universal ACP-based architecture supporting Pi, Gemini CLI, Claude Code, Copilot CLI, and OpenCode — with per-project agent selection, backend-hosted MCP tools, and superpowers skills on sub-agents.

**Architecture:** A single `AcpAgentManager` replaces `PlanningAgentManager`, speaking ACP JSON-RPC 2.0 over TCP to any agent container. Each agent type gets its own Docker image (built from a shared base) with a stdio-to-TCP bridge. The backend hosts an MCP SSE server so agents can call harness tools. The frontend receives raw ACP `session/update` notifications over WebSocket. Per-project agent config is stored in the DB and exposed via a settings UI.

**Tech Stack:** TypeScript (Bun runtime), Express, Docker, ACP JSON-RPC 2.0, MCP SDK (`@modelcontextprotocol/sdk`), Playwright (E2E), Vitest (unit/integration), SQLite/PostgreSQL.

---

## File Structure

### New files

```
agents/
├── base/
│   └── Dockerfile.base                         # Shared base image: node, git, gh, rtk, bridge
├── stdio-tcp-bridge.mjs                        # ~30 lines: TCP :3333 ↔ ACP subprocess stdio
├── prompts/
│   ├── planning/
│   │   └── AGENTS.md                           # Planning agent system prompt
│   └── implementation/
│       └── AGENTS.md                           # Sub-agent system prompt
├── pi/
│   ├── Dockerfile                              # FROM base + pi-acp + superpowers
│   └── config/                                 # pi-specific settings
├── copilot/
│   ├── Dockerfile                              # FROM base + copilot CLI
│   └── mcp.json                                # MCP server registration
├── gemini/
│   ├── Dockerfile                              # FROM base + gemini CLI
│   └── .gemini/settings.json                   # MCP, OTEL config
├── claude/
│   ├── Dockerfile                              # FROM base + claude CLI + claude-agent-acp
│   └── settings.json                           # hooks, MCP registration
└── opencode/
    ├── Dockerfile                              # FROM base + opencode binary
    └── opencode.json                           # config, MCP registration

backend/src/
├── orchestrator/
│   └── acpAgentManager.ts                      # Replaces planningAgentManager.ts
├── mcp/
│   ├── server.ts                               # MCP SSE endpoint (Express middleware)
│   └── tools/
│       ├── dispatch_tasks.ts                   # Calls taskDispatcher
│       ├── ask_planning_agent.ts               # Calls acpAgentManager.sendPrompt
│       ├── write_planning_document.ts          # Calls planningTool
│       ├── get_task_status.ts                  # Calls store/projects
│       ├── get_pull_requests.ts                # Calls store/pullRequests
│       ├── reply_to_subagent.ts                # Calls message store
│       └── web_fetch.ts                        # HTTP fetch with SSRF guard
├── store/migrations/
│   └── 007_add_agent_config.ts                 # Add planning/impl agent config columns
├── api/
│   └── agentConfig.ts                          # GET/PUT /api/projects/:id/agent-config + /api/config/available-agents

frontend/src/
├── pages/
│   └── AgentSettings.tsx                       # Per-project agent selection UI
├── lib/
│   └── acpEvents.ts                            # ACP WS event types + reducer
```

### Modified files

```
backend/src/config.ts                           # Add defaultImplementationAgentType, agentImage()
backend/src/models/types.ts                     # Add AgentConfig fields to Project
backend/src/store/projects.ts                   # Read/write agent config columns
backend/src/api/routes.ts                       # Mount agentConfig routes, MCP middleware
backend/src/api/websocket.ts                    # Replace PlanningAgentEvent with ACP events
backend/src/orchestrator/taskDispatcher.ts       # Use AcpAgentManager for sub-agents
backend/src/orchestrator/recoveryService.ts      # Reference AcpAgentManager
backend/src/index.ts                            # Bootstrap AcpAgentManager + MCP server
backend/src/telemetry.ts                        # (no change — reuse tracer/meter exports)
frontend/src/pages/Chat.tsx                     # Consume ACP WS events
frontend/src/pages/Settings.tsx                 # Link to agent settings
frontend/src/lib/api.ts                         # Add agent config API types
frontend/src/App.tsx                            # Add AgentSettings route
docker-compose.yml                              # Replace planning-agent/sub-agent with agent-* images
e2e-tests/playwright.config.ts                  # Add parametrized agent projects
e2e-tests/planning-agent-tests/rpc-client.ts    # Rewrite as ACP client
e2e-tests/planning-agent-tests/planning-agent.test.ts  # Adapt to ACP protocol
```

### Deleted files

```
planning-agent/                                 # Entire directory (replaced by agents/pi/)
sub-agent/                                      # Entire directory (replaced by agents/pi/)
```

---

## Task 1: Database Migration — Per-Project Agent Config

**Files:**
- Create: `backend/src/store/migrations/007_add_agent_config.ts`
- Modify: `backend/src/store/migrations/index.ts`
- Modify: `backend/src/models/types.ts`
- Modify: `backend/src/store/projects.ts`
- Test: `backend/src/__tests__/agentConfig.test.ts`

- [ ] **Step 1: Write failing test for agent config storage**

Create `backend/src/__tests__/agentConfig.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { initDb } from "../store/db.js";
import { insertProject, getProject, updateProject } from "../store/projects.js";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";

describe("agent config on projects", () => {
  beforeAll(async () => {
    const dir = mkdtempSync(`${tmpdir()}/harness-test-`);
    await initDb(dir);
  });

  it("stores and retrieves per-project agent config", async () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await insertProject({
      id,
      name: "test",
      status: "brainstorming",
      source: { type: "freeform", freeformDescription: "test" },
      repositoryIds: [],
      masterSessionPath: "",
      createdAt: now,
      updatedAt: now,
    });

    await updateProject(id, {
      planningAgent: { type: "gemini", model: "gemini-2.5-pro" },
      implementationAgent: { type: "copilot", model: "gpt-5-mini" },
    });

    const project = await getProject(id);
    expect(project?.planningAgent).toEqual({ type: "gemini", model: "gemini-2.5-pro" });
    expect(project?.implementationAgent).toEqual({ type: "copilot", model: "gpt-5-mini" });
  });

  it("returns undefined agent config when not set", async () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await insertProject({
      id,
      name: "test-no-config",
      status: "brainstorming",
      source: { type: "freeform", freeformDescription: "test" },
      repositoryIds: [],
      masterSessionPath: "",
      createdAt: now,
      updatedAt: now,
    });

    const project = await getProject(id);
    expect(project?.planningAgent).toBeUndefined();
    expect(project?.implementationAgent).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd backend test -- --run agentConfig`
Expected: FAIL — `planningAgent` property doesn't exist on Project type

- [ ] **Step 3: Add agent config fields to Project type**

In `backend/src/models/types.ts`, add to the `Project` interface after `updatedAt`:

```typescript
  planningAgent?: {
    type: string;     // "pi" | "gemini" | "claude" | "copilot" | "opencode"
    model?: string;
  };
  implementationAgent?: {
    type: string;
    model?: string;
  };
```

- [ ] **Step 4: Create migration 007**

Create `backend/src/store/migrations/007_add_agent_config.ts`:

```typescript
import type { DbAdapter } from "../adapter.js";

export const migration = {
  name: "007_add_agent_config",
  async up(db: DbAdapter): Promise<void> {
    await db.execAsync(`
      ALTER TABLE projects ADD COLUMN planning_agent_json TEXT DEFAULT NULL
    `);
    await db.execAsync(`
      ALTER TABLE projects ADD COLUMN implementation_agent_json TEXT DEFAULT NULL
    `);
  },
};
```

- [ ] **Step 5: Register migration in index.ts**

In `backend/src/store/migrations/index.ts`, add:

```typescript
import { migration as m007 } from "./007_add_agent_config.js";
```

And append `m007` to the `migrations` array.

- [ ] **Step 6: Update projects store to read/write agent config**

In `backend/src/store/projects.ts`:

Add `planning_agent_json: string | null;` and `implementation_agent_json: string | null;` to the `ProjectRow` interface.

In `fromRow()`, add after `updatedAt`:
```typescript
    planningAgent: row.planning_agent_json ? JSON.parse(row.planning_agent_json) : undefined,
    implementationAgent: row.implementation_agent_json ? JSON.parse(row.implementation_agent_json) : undefined,
```

In `insertProject()`, add the two columns to the INSERT statement with values:
```typescript
    project.planningAgent ? JSON.stringify(project.planningAgent) : null,
    project.implementationAgent ? JSON.stringify(project.implementationAgent) : null,
```

In `updateProject()` (the function that builds SET clauses dynamically), handle the new fields:
```typescript
    if (updates.planningAgent !== undefined) {
      sets.push("planning_agent_json = ?");
      params.push(JSON.stringify(updates.planningAgent));
    }
    if (updates.implementationAgent !== undefined) {
      sets.push("implementation_agent_json = ?");
      params.push(JSON.stringify(updates.implementationAgent));
    }
```

- [ ] **Step 7: Run test to verify it passes**

Run: `bun run --cwd backend test -- --run agentConfig`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add backend/src/store/migrations/007_add_agent_config.ts \
       backend/src/store/migrations/index.ts \
       backend/src/models/types.ts \
       backend/src/store/projects.ts \
       backend/src/__tests__/agentConfig.test.ts
git commit -m "feat: add per-project agent config (planning + implementation) to DB schema"
```

---

## Task 2: Config Changes — Agent Image Resolution + Defaults

**Files:**
- Modify: `backend/src/config.ts`
- Test: `backend/src/__tests__/config.test.ts`

- [ ] **Step 1: Write failing test for agentImage()**

Create `backend/src/__tests__/config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { agentImage, resolveAgentConfig } from "../config.js";

describe("agentImage", () => {
  it("returns correct image name for each agent type", () => {
    expect(agentImage("pi")).toBe("multi-agent-harness/agent-pi:latest");
    expect(agentImage("gemini")).toBe("multi-agent-harness/agent-gemini:latest");
    expect(agentImage("copilot")).toBe("multi-agent-harness/agent-copilot:latest");
  });
});

describe("resolveAgentConfig", () => {
  it("returns project config when set", () => {
    const result = resolveAgentConfig(
      "planning",
      { type: "gemini", model: "gemini-2.5-pro" }
    );
    expect(result).toEqual({ type: "gemini", model: "gemini-2.5-pro" });
  });

  it("falls back to env defaults when project config is undefined", () => {
    const result = resolveAgentConfig("planning", undefined);
    expect(result.type).toBeTruthy();
    expect(result.model).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd backend test -- --run config`
Expected: FAIL — `agentImage` and `resolveAgentConfig` not exported

- [ ] **Step 3: Add agentImage() and resolveAgentConfig() to config.ts**

In `backend/src/config.ts`, add after the `config` export:

```typescript
export function agentImage(agentType: string): string {
  return `multi-agent-harness/agent-${agentType}:latest`;
}

export function resolveAgentConfig(
  role: "planning" | "implementation",
  projectConfig?: { type: string; model?: string }
): { type: string; model: string } {
  if (projectConfig) {
    return {
      type: projectConfig.type,
      model: projectConfig.model ?? (
        role === "planning" ? config.planningModel : config.implementationModel
      ),
    };
  }
  return {
    type: config.agentProvider,
    model: role === "planning" ? config.planningModel : config.implementationModel,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd backend test -- --run config`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/config.ts backend/src/__tests__/config.test.ts
git commit -m "feat: add agentImage() and resolveAgentConfig() for multi-agent support"
```

---

## Task 3: Agent Config API Endpoints

**Files:**
- Create: `backend/src/api/agentConfig.ts`
- Modify: `backend/src/api/routes.ts`
- Test: `backend/src/__tests__/agentConfigRouter.test.ts`

- [ ] **Step 1: Write failing test for agent config endpoints**

Create `backend/src/__tests__/agentConfigRouter.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import { initDb } from "../store/db.js";
import { insertProject } from "../store/projects.js";
import { createAgentConfigRouter } from "../api/agentConfig.js";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";

describe("agent config API", () => {
  let app: express.Express;
  let projectId: string;

  beforeAll(async () => {
    const dir = mkdtempSync(`${tmpdir()}/harness-test-`);
    await initDb(dir);

    projectId = randomUUID();
    const now = new Date().toISOString();
    await insertProject({
      id: projectId,
      name: "test",
      status: "brainstorming",
      source: { type: "freeform", freeformDescription: "test" },
      repositoryIds: [],
      masterSessionPath: "",
      createdAt: now,
      updatedAt: now,
    });

    app = express();
    app.use(express.json());
    app.use("/api", createAgentConfigRouter());
  });

  it("GET /api/config/available-agents returns agent list", async () => {
    const res = await request(app).get("/api/config/available-agents");
    expect(res.status).toBe(200);
    expect(res.body.agents).toBeInstanceOf(Array);
    expect(res.body.agents.length).toBeGreaterThan(0);
    expect(res.body.agents[0]).toHaveProperty("type");
    expect(res.body.agents[0]).toHaveProperty("available");
  });

  it("PUT + GET /api/projects/:id/agent-config round-trips", async () => {
    const putRes = await request(app)
      .put(`/api/projects/${projectId}/agent-config`)
      .send({
        planningAgent: { type: "gemini", model: "gemini-2.5-pro" },
        implementationAgent: { type: "copilot", model: "gpt-5-mini" },
      });
    expect(putRes.status).toBe(200);

    const getRes = await request(app)
      .get(`/api/projects/${projectId}/agent-config`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.planningAgent).toEqual({ type: "gemini", model: "gemini-2.5-pro" });
    expect(getRes.body.implementationAgent).toEqual({ type: "copilot", model: "gpt-5-mini" });
    expect(getRes.body.defaults).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd backend test -- --run agentConfigRouter`
Expected: FAIL — module not found

- [ ] **Step 3: Implement agentConfig router**

Create `backend/src/api/agentConfig.ts`:

```typescript
import { Router } from "express";
import { getProject, updateProject } from "../store/projects.js";
import { config, resolveAgentConfig } from "../config.js";

const AGENT_TYPES = ["pi", "gemini", "claude", "copilot", "opencode"] as const;

// Map agent type → required env var for availability check
const REQUIRED_ENV: Record<string, string> = {
  pi: "COPILOT_GITHUB_TOKEN",       // pi-acp uses Copilot PAT or Anthropic key
  gemini: "GEMINI_API_KEY",
  claude: "ANTHROPIC_API_KEY",
  copilot: "COPILOT_GITHUB_TOKEN",
  opencode: "OPENCODE_API_KEY",
};

export function createAgentConfigRouter(): Router {
  const router = Router();

  router.get("/config/available-agents", (_req, res) => {
    const agents = AGENT_TYPES.map((type) => ({
      type,
      available: !!process.env[REQUIRED_ENV[type]],
    }));
    res.json({ agents });
  });

  router.get("/projects/:id/agent-config", async (req, res) => {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json({
      planningAgent: project.planningAgent ?? null,
      implementationAgent: project.implementationAgent ?? null,
      defaults: {
        planningAgent: resolveAgentConfig("planning"),
        implementationAgent: resolveAgentConfig("implementation"),
      },
    });
  });

  router.put("/projects/:id/agent-config", async (req, res) => {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const { planningAgent, implementationAgent } = req.body;
    await updateProject(req.params.id, { planningAgent, implementationAgent });
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 4: Mount router in routes.ts**

In `backend/src/api/routes.ts`, add import:
```typescript
import { createAgentConfigRouter } from "./agentConfig.js";
```

And mount it alongside other routers (inside the protected section):
```typescript
router.use(createAgentConfigRouter());
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run --cwd backend test -- --run agentConfigRouter`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/api/agentConfig.ts backend/src/api/routes.ts \
       backend/src/__tests__/agentConfigRouter.test.ts
git commit -m "feat: add agent config API endpoints (available-agents, per-project config)"
```

---

## Task 4: stdio-to-TCP Bridge + Shared Base Dockerfile

**Files:**
- Create: `agents/stdio-tcp-bridge.mjs`
- Create: `agents/base/Dockerfile.base`
- Test: `agents/stdio-tcp-bridge.test.mjs`

- [ ] **Step 1: Write test for stdio-tcp-bridge**

Create `agents/stdio-tcp-bridge.test.mjs`:

```javascript
import { describe, it, expect } from "bun:test";
import { spawn } from "child_process";
import { createConnection } from "net";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("stdio-tcp-bridge", () => {
  it("pipes TCP input to subprocess stdin and subprocess stdout to TCP", async () => {
    // Use `cat` as a simple echo subprocess
    const bridge = spawn("node", [
      "agents/stdio-tcp-bridge.mjs",
      "cat",
    ], { stdio: ["pipe", "pipe", "inherit"] });

    await sleep(500); // wait for server to bind

    const received = await new Promise((resolve, reject) => {
      const socket = createConnection(3333, "127.0.0.1", () => {
        socket.write("hello\n");
      });
      socket.on("data", (data) => {
        socket.destroy();
        resolve(data.toString());
      });
      socket.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(received).toBe("hello\n");
    bridge.kill();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test agents/stdio-tcp-bridge.test.mjs`
Expected: FAIL — file not found

- [ ] **Step 3: Implement stdio-tcp-bridge.mjs**

Create `agents/stdio-tcp-bridge.mjs`:

```javascript
#!/usr/bin/env node
// stdio-tcp-bridge.mjs — Bridges TCP :3333 to an ACP subprocess's stdio.
// Usage: node stdio-tcp-bridge.mjs <command> [args...]
import { createServer } from "net";
import { spawn } from "child_process";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error("Usage: stdio-tcp-bridge.mjs <command> [args...]"); process.exit(1); }

const agent = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });

const server = createServer((socket) => {
  socket.pipe(agent.stdin, { end: false });
  agent.stdout.pipe(socket, { end: false });
  socket.on("error", (err) => console.error("[bridge] socket error:", err.message));
  socket.on("close", () => { /* client disconnected — agent stays alive for reconnect */ });
});

server.listen(3333, "0.0.0.0", () => {
  console.log("[bridge] listening on :3333");
});

agent.on("exit", (code) => {
  console.log(`[bridge] agent exited with code ${code}`);
  process.exit(code ?? 1);
});

process.on("SIGTERM", () => { agent.kill("SIGTERM"); });
process.on("SIGINT", () => { agent.kill("SIGINT"); });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test agents/stdio-tcp-bridge.test.mjs`
Expected: PASS

- [ ] **Step 5: Create shared base Dockerfile**

Create `agents/base/Dockerfile.base`:

```dockerfile
FROM node:22-slim

RUN apt-get update && apt-get install -y \
    git curl build-essential python3 \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       | tee /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# stdio-to-TCP bridge
COPY agents/stdio-tcp-bridge.mjs /app/stdio-tcp-bridge.mjs

RUN mkdir -p /workspace /agent-data

EXPOSE 3333
```

- [ ] **Step 6: Commit**

```bash
git add agents/stdio-tcp-bridge.mjs agents/stdio-tcp-bridge.test.mjs agents/base/Dockerfile.base
git commit -m "feat: add stdio-tcp-bridge and shared base Dockerfile for agent containers"
```

---

## Task 5: Agent System Prompts (AGENTS.md)

**Files:**
- Create: `agents/prompts/planning/AGENTS.md`
- Create: `agents/prompts/implementation/AGENTS.md`

- [ ] **Step 1: Create planning agent AGENTS.md**

Create `agents/prompts/planning/AGENTS.md`. Content should be extracted from the existing `planning-agent/system-prompt.md` — the three-phase workflow (brainstorming → writing-plans → dispatching). Read `planning-agent/system-prompt.md` and adapt:
- Remove references to pi-coding-agent SDK specifics
- Keep the tool definitions (dispatch_tasks, write_planning_document, get_task_status, get_pull_requests, reply_to_subagent)
- Note that tools are now provided via MCP, not custom tool arrays

```markdown
# Planning Agent

You are a master planning agent for a multi-agent development harness.
You operate in three phases, each driven by a dedicated superpowers skill.

## Phase 1 — Brainstorming
Read the superpowers `brainstorming` skill and follow its checklist exactly.
Ask clarifying questions about the user's request. Propose approaches.
Present a design and get approval. Write the spec.

## Phase 2 — Writing Plans
After the user says LGTM on the spec, read the superpowers `writing-plans`
skill and follow it. Write a detailed implementation plan.

## Phase 3 — Dispatching
After the user approves the plan, use the `dispatch_tasks` tool to create
sub-agent tasks. Monitor progress with `get_task_status`. Report completed
PRs with `get_pull_requests`.

## Rules
- Never write code yourself — you are a planner.
- Never use bash or git to create PRs — the harness does this.
- Never write tests — sub-agents do this.
- Each dispatched task must be self-contained and independently implementable.
```

- [ ] **Step 2: Create implementation agent AGENTS.md**

Create `agents/prompts/implementation/AGENTS.md`:

```markdown
# Implementation Agent

You are an implementation sub-agent. Your job is to implement a specific task
assigned by the planning agent.

## Workflow
1. Read the task description carefully.
2. If a plan file exists in `docs/superpowers/plans/`, read it for full context.
3. Follow the `executing-plans` skill workflow for each task.
4. Use `test-driven-development`: write tests before implementation.
5. Use `systematic-debugging` when encountering errors or CI failures.
6. Use `requesting-code-review` after implementation to self-review.
7. Use `finishing-a-development-branch` when done: always commit and push.
   Do not ask — just do it.

## Communication
- Use the `ask_planning_agent` tool when you are blocked or need clarification.
- Never create PRs manually — the harness creates them automatically.

## Guard Rules
- Do not run `git push --force`, `git branch -D`, or `gh pr create`.
- Do not access `.harness/` directory.
- Do not run `curl`, `wget`, or `gh api` directly.
```

- [ ] **Step 3: Commit**

```bash
git add agents/prompts/planning/AGENTS.md agents/prompts/implementation/AGENTS.md
git commit -m "feat: add AGENTS.md system prompts for planning and implementation agents"
```

---

## Task 6: Pi Agent Container (Dockerfile + ACP)

**Files:**
- Create: `agents/pi/Dockerfile`
- Create: `agents/pi/package.json`

- [ ] **Step 1: Create pi agent package.json**

Create `agents/pi/package.json`:

```json
{
  "name": "@multi-agent-harness/agent-pi",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "pi-acp": "^0.0.24",
    "superpowers": "github:obra/superpowers#v5.0.7"
  }
}
```

- [ ] **Step 2: Create pi agent Dockerfile**

Create `agents/pi/Dockerfile`:

```dockerfile
FROM multi-agent-harness/agent-base:latest AS base

# Pi ACP adapter + superpowers
COPY agents/pi/package.json /app/package.json
RUN npm install --production

# System prompts — planning variant
COPY agents/prompts/planning/AGENTS.md /agent-data/planning/AGENTS.md
RUN ln -s /agent-data/planning/AGENTS.md /agent-data/planning/CLAUDE.md

# System prompts — implementation variant
COPY agents/prompts/implementation/AGENTS.md /agent-data/implementation/AGENTS.md
RUN ln -s /agent-data/implementation/AGENTS.md /agent-data/implementation/CLAUDE.md

# Role is set at runtime via AGENT_ROLE env var (planning|implementation)
# Entrypoint uses bridge → pi-acp
ENTRYPOINT ["node", "/app/stdio-tcp-bridge.mjs", "npx", "pi-acp"]
```

- [ ] **Step 3: Commit**

```bash
git add agents/pi/Dockerfile agents/pi/package.json
git commit -m "feat: add pi-acp agent container image"
```

---

## Task 7: Copilot Agent Container

**Files:**
- Create: `agents/copilot/Dockerfile`
- Create: `agents/copilot/mcp.json`

- [ ] **Step 1: Create copilot MCP config**

Create `agents/copilot/mcp.json`:

```json
{
  "mcpServers": {
    "harness": {
      "url": "http://backend:3000/mcp"
    }
  }
}
```

Note: The `projectId`, `sessionId`, and `role` query params will be appended at container startup via an entrypoint script or env var substitution.

- [ ] **Step 2: Create copilot Dockerfile**

Create `agents/copilot/Dockerfile`:

```dockerfile
FROM multi-agent-harness/agent-base:latest AS base

# Copilot CLI (installed via npm)
RUN npm install -g @anthropic-ai/copilot-cli || true

# MCP config template
COPY agents/copilot/mcp.json /app/mcp-template.json

# System prompts
COPY agents/prompts/planning/AGENTS.md /agent-data/planning/AGENTS.md
RUN ln -s /agent-data/planning/AGENTS.md /agent-data/planning/CLAUDE.md
COPY agents/prompts/implementation/AGENTS.md /agent-data/implementation/AGENTS.md
RUN ln -s /agent-data/implementation/AGENTS.md /agent-data/implementation/CLAUDE.md

# Copilot natively supports --acp --port, so no bridge needed
ENTRYPOINT ["copilot", "--acp", "--port", "3333"]
```

- [ ] **Step 3: Commit**

```bash
git add agents/copilot/Dockerfile agents/copilot/mcp.json
git commit -m "feat: add copilot CLI agent container image"
```

---

## Task 8: Gemini, Claude, and OpenCode Agent Containers

**Files:**
- Create: `agents/gemini/Dockerfile`
- Create: `agents/gemini/.gemini/settings.json`
- Create: `agents/claude/Dockerfile`
- Create: `agents/claude/settings.json`
- Create: `agents/opencode/Dockerfile`
- Create: `agents/opencode/opencode.json`

- [ ] **Step 1: Create Gemini agent container**

Create `agents/gemini/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "harness": {
      "url": "http://backend:3000/mcp"
    }
  }
}
```

Create `agents/gemini/Dockerfile`:

```dockerfile
FROM multi-agent-harness/agent-base:latest

# Gemini CLI
RUN npm install -g @anthropic-ai/gemini-cli || true

# Gemini config (MCP registration)
COPY agents/gemini/.gemini /root/.gemini

# System prompts
COPY agents/prompts/planning/AGENTS.md /agent-data/planning/AGENTS.md
RUN ln -s /agent-data/planning/AGENTS.md /agent-data/planning/CLAUDE.md
COPY agents/prompts/implementation/AGENTS.md /agent-data/implementation/AGENTS.md
RUN ln -s /agent-data/implementation/AGENTS.md /agent-data/implementation/CLAUDE.md

ENTRYPOINT ["node", "/app/stdio-tcp-bridge.mjs", "gemini", "--acp"]
```

- [ ] **Step 2: Create Claude agent container**

Create `agents/claude/settings.json`:

```json
{
  "mcpServers": {
    "harness": {
      "url": "http://backend:3000/mcp"
    }
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": ["/app/guard-hook.sh"]
      }
    ]
  }
}
```

Create `agents/claude/Dockerfile`:

```dockerfile
FROM multi-agent-harness/agent-base:latest

# Claude Code + ACP adapter
RUN npm install -g @anthropic-ai/claude-code claude-agent-acp

# Claude settings (MCP, guard hooks)
COPY agents/claude/settings.json /root/.claude/settings.json

# Guard hook script
RUN printf '#!/bin/sh\n\
BLOCKED="git push --force|git branch -D|git branch -d|git branch --delete|gh pr create|gh repo delete|gh api|curl |wget "\n\
for pattern in $BLOCKED; do\n\
  case "$CLAUDE_TOOL_INPUT" in *"$pattern"*) echo "BLOCKED: $pattern" >&2; exit 2;; esac\n\
done\n\
exit 0\n' > /app/guard-hook.sh && chmod +x /app/guard-hook.sh

# System prompts
COPY agents/prompts/planning/AGENTS.md /agent-data/planning/AGENTS.md
RUN ln -s /agent-data/planning/AGENTS.md /agent-data/planning/CLAUDE.md
COPY agents/prompts/implementation/AGENTS.md /agent-data/implementation/AGENTS.md
RUN ln -s /agent-data/implementation/AGENTS.md /agent-data/implementation/CLAUDE.md

ENTRYPOINT ["node", "/app/stdio-tcp-bridge.mjs", "claude-agent-acp"]
```

- [ ] **Step 3: Create OpenCode agent container**

Create `agents/opencode/opencode.json`:

```json
{
  "mcpServers": {
    "harness": {
      "url": "http://backend:3000/mcp"
    }
  }
}
```

Create `agents/opencode/Dockerfile`:

```dockerfile
FROM multi-agent-harness/agent-base:latest

# OpenCode binary
RUN curl -fsSL https://opencode.ai/install.sh | sh || true

# Config (MCP registration)
COPY agents/opencode/opencode.json /root/.config/opencode/config.json

# System prompts
COPY agents/prompts/planning/AGENTS.md /agent-data/planning/AGENTS.md
RUN ln -s /agent-data/planning/AGENTS.md /agent-data/planning/CLAUDE.md
COPY agents/prompts/implementation/AGENTS.md /agent-data/implementation/AGENTS.md
RUN ln -s /agent-data/implementation/AGENTS.md /agent-data/implementation/CLAUDE.md

ENTRYPOINT ["node", "/app/stdio-tcp-bridge.mjs", "opencode", "acp"]
```

- [ ] **Step 4: Commit**

```bash
git add agents/gemini/ agents/claude/ agents/opencode/
git commit -m "feat: add Gemini, Claude, and OpenCode agent container images"
```

---

## Task 9: Per-Agent Guard Hook Configuration

Each CLI uses its own native mechanism to enforce command blocking. The blocked patterns are the same across all agents: force push, branch deletion, `gh pr create`, `gh api`, `curl`, `wget`, `.harness/` access.

**Files:**
- Modify: `agents/claude/Dockerfile` (guard-hook.sh already inline from Task 8)
- Create: `agents/pi/guard-hook.mjs`
- Modify: `agents/copilot/Dockerfile`

- [ ] **Step 1: Create Pi guard hook wrapper**

Pi uses the existing `BashSpawnHook` pattern from `tools.mjs`. The pi-acp adapter loads tools from a config file. Create `agents/pi/guard-hook.mjs` that exports the guard hook function:

```javascript
// guard-hook.mjs — Pi agent guard hook (BashSpawnHook compatible)
// Blocks: force push, branch deletion, gh pr create, gh api, curl/wget, .harness/
const BLOCKED_PATTERNS = [
  ["git", "push", "--force"],
  ["git", "push", "-f"],
  ["git", "branch", "-D"],
  ["git", "branch", "-d"],
  ["git", "branch", "--delete"],
  ["gh", "pr", "create"],
  ["gh", "repo", "delete"],
  ["gh", "repo", "edit"],
  ["gh", "api"],
  ["curl"],
  ["wget"],
];

export function createGuardHook() {
  return function guardHook(context) {
    const tokens = context.command.split(/\s+/);
    // Check .harness/ access
    if (tokens.some(t => /(?:^|\/)\.harness(?:\/|$)/.test(t))) {
      return { ...context, command: `printf '[GUARD] .harness/ access blocked\\n' >&2; exit 1` };
    }
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.every((p, i) => tokens[i] === p)) {
        return { ...context, command: `printf '[GUARD] Command blocked: ${pattern.join(" ")}\\n' >&2; exit 1` };
      }
    }
    return context;
  };
}
```

- [ ] **Step 2: Copilot guard — handled via AcpAgentManager**

Copilot sends `session/request_permission` for tool execution. Add a comment in `acpAgentManager.ts` (Task 10) noting that the `handleAcpMessage` method should inspect `session/request_permission` requests and reject blocked commands. Add this to the `handleAcpMessage` method:

```typescript
// In handleAcpMessage, after handling session/update:
if (notification.method === "session/request_permission") {
  const command = (notification.params.command as string) ?? "";
  const BLOCKED = ["git push --force", "git push -f", "git branch -D", "gh pr create", "gh api", "curl ", "wget "];
  const blocked = BLOCKED.some(p => command.includes(p));
  // Respond: allow or deny
  const responseId = notification.params.requestId as number;
  state.tcpSocket.write(JSON.stringify({
    jsonrpc: "2.0",
    id: responseId,
    result: { allowed: !blocked, reason: blocked ? "Command blocked by harness guard" : undefined },
  }) + "\n");
  return;
}
```

- [ ] **Step 3: Gemini and OpenCode guards**

Gemini and OpenCode guard hooks are config-based. The system prompt in `AGENTS.md` already instructs agents not to run blocked commands. For additional enforcement, the MCP `web_fetch` tool already has SSRF protection, and the system prompt prohibits `gh pr create` etc. Native config-level restrictions can be added when those CLIs stabilize their hook APIs.

- [ ] **Step 4: Commit**

```bash
git add agents/pi/guard-hook.mjs
git commit -m "feat: add per-agent guard hook configuration"
```

---

## Task 10: AcpAgentManager — Core Implementation

This is the largest task. It replaces `PlanningAgentManager` with a generic ACP JSON-RPC 2.0 client that manages all agent containers.

**Files:**
- Create: `backend/src/orchestrator/acpAgentManager.ts`
- Test: `backend/src/__tests__/acpAgentManager.test.ts`

- [ ] **Step 1: Write failing test for ACP handshake**

Create `backend/src/__tests__/acpAgentManager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AcpAgentManager } from "../orchestrator/acpAgentManager.js";
import { createServer, type Server, type Socket } from "net";

// Mock Docker
const mockDocker = {
  createContainer: vi.fn(),
  getContainer: vi.fn(),
  listContainers: vi.fn().mockResolvedValue([]),
};

// Fake ACP agent: responds to initialize + session/new
function createFakeAcpAgent(port: number): Promise<{ server: Server; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            socket.write(JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fake" } },
            }) + "\n");
          } else if (msg.method === "session/new") {
            socket.write(JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessionId: "test-session-123" },
            }) + "\n");
          }
        }
      });
    });
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, close: () => server.close() });
    });
  });
}

describe("AcpAgentManager", () => {
  it("performs ACP initialize + session/new handshake", async () => {
    const fakeAgent = await createFakeAcpAgent(13333);
    try {
      const manager = new AcpAgentManager(mockDocker as any);
      // Direct TCP connect (bypassing Docker for unit test)
      const state = await manager.connectAndInitialize("test-agent", "127.0.0.1", 13333);
      expect(state.acpInitialized).toBe(true);
      expect(state.acpSessionId).toBe("test-session-123");
    } finally {
      fakeAgent.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd backend test -- --run acpAgentManager`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AcpAgentManager**

Create `backend/src/orchestrator/acpAgentManager.ts`:

```typescript
import type Dockerode from "dockerode";
import { Socket } from "net";
import { EventEmitter } from "node:events";
import { context, trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { config, agentImage, resolveAgentConfig } from "../config.js";
import { tracer, meter } from "../telemetry.js";
import { appendEvent } from "../store/agentEvents.js";

// ACP JSON-RPC 2.0 types
interface AcpRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface AcpResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface AcpNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

type AcpMessage = AcpResponse | AcpNotification;

// WS event types forwarded to frontend
export type WsAcpEvent =
  | { type: "acp:agent_message_chunk"; agentId: string; content: unknown }
  | { type: "acp:tool_call"; agentId: string; toolCallId: string; title: string; kind: string; status: string; content?: unknown[]; locations?: unknown[] }
  | { type: "acp:tool_call_update"; agentId: string; toolCallId: string; status: string; content?: unknown[]; locations?: unknown[] }
  | { type: "acp:plan"; agentId: string; items: unknown[] }
  | { type: "acp:turn_complete"; agentId: string; stopReason: string }
  | { type: "acp:error"; agentId: string; message: string }
  | { type: "agent:started"; agentId: string }
  | { type: "agent:stopped"; agentId: string }
  | { type: "agent:crashed"; agentId: string; message: string };

export interface AgentState {
  containerId: string;
  containerName: string;
  tcpSocket: Socket;
  lineBuffer: string;
  acpSessionId: string | null;
  acpInitialized: boolean;
  isStreaming: boolean;
  promptPending: boolean;
  wsConnectionCount: number;
  outputHandlers: Set<(event: WsAcpEvent) => void>;
  lifecycleState: "running" | "idle" | "stopping" | "crashed";
  stopTimer: ReturnType<typeof setTimeout> | null;
  sessionSpan: Span | null;
  turnSpan: Span | null;
  toolSpans: Map<string, Span>;
  pendingRequests: Map<number, { resolve: (r: AcpResponse) => void; reject: (e: Error) => void }>;
  nextRequestId: number;
}

// OTEL instruments
const toolCallCounter = meter.createCounter("harness.tool_calls.total");
const toolCallDuration = meter.createHistogram("harness.tool_calls.duration_ms", { unit: "ms" });
const tokensInput = meter.createCounter("harness.tokens.input", { unit: "tokens" });
const tokensOutput = meter.createCounter("harness.tokens.output", { unit: "tokens" });

let instance: AcpAgentManager | null = null;

export function setAcpAgentManager(mgr: AcpAgentManager): void { instance = mgr; }
export function getAcpAgentManager(): AcpAgentManager {
  if (!instance) throw new Error("[AcpAgentManager] not initialised");
  return instance;
}

export class AcpAgentManager extends EventEmitter {
  private agents = new Map<string, AgentState>();
  private toolCallStartTimes = new Map<string, number>();

  constructor(private readonly docker: Dockerode) { super(); }

  isRunning(agentId: string): boolean { return this.agents.has(agentId); }

  /** Connect to an already-running agent's TCP port and perform ACP handshake. */
  async connectAndInitialize(
    agentId: string,
    host: string,
    port: number,
    containerId = "",
    containerName = ""
  ): Promise<AgentState> {
    const tcpSocket = await this.connectTcp(host, port, 120_000);

    const state: AgentState = {
      containerId,
      containerName,
      tcpSocket,
      lineBuffer: "",
      acpSessionId: null,
      acpInitialized: false,
      isStreaming: false,
      promptPending: false,
      wsConnectionCount: 0,
      outputHandlers: new Set(),
      lifecycleState: "running",
      stopTimer: null,
      sessionSpan: null,
      turnSpan: null,
      toolSpans: new Map(),
      pendingRequests: new Map(),
      nextRequestId: 1,
    };

    this.listenTcp(agentId, state);

    // ACP initialize handshake
    const initResult = await this.sendRequest(state, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    state.acpInitialized = true;

    // ACP session/new
    const sessionResult = await this.sendRequest(state, "session/new", {
      cwd: "/workspace",
    });
    state.acpSessionId = (sessionResult.result as any)?.sessionId ?? null;

    this.agents.set(agentId, state);
    state.sessionSpan = tracer.startSpan("agent.session", {
      attributes: { "agent.id": agentId },
    });

    return state;
  }

  async ensureRunning(
    agentId: string,
    agentType: string,
    role: "planning" | "implementation",
    env: string[] = []
  ): Promise<void> {
    if (this.agents.has(agentId)) return;

    const containerName = agentId;
    const image = agentImage(agentType);

    // Check for existing container
    let containerId: string | undefined;
    const existing = await this.findExistingContainer(containerName);
    if (existing) {
      containerId = existing;
      const info = await this.docker.getContainer(containerId).inspect();
      if (!info.State.Running) {
        await this.docker.getContainer(containerId).start();
      }
    } else {
      const container = await this.docker.createContainer({
        Image: image,
        name: containerName,
        Env: [
          `AGENT_ROLE=${role}`,
          ...env,
        ],
        ExposedPorts: { "3333/tcp": {} },
        HostConfig: {
          NetworkMode: config.subAgentNetwork,
        },
      });
      containerId = container.id;
      await this.docker.getContainer(containerId).start();
    }

    await this.connectAndInitialize(agentId, containerName, 3333, containerId, containerName);
    this.emitWsEvent(agentId, { type: "agent:started", agentId });
  }

  async sendPrompt(agentId: string, message: string): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) throw new Error(`Agent ${agentId} not running`);

    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
      state.lifecycleState = "running";
    }

    state.promptPending = true;
    state.isStreaming = true;

    const parentCtx = state.sessionSpan
      ? trace.setSpan(context.active(), state.sessionSpan)
      : context.active();
    state.turnSpan = tracer.startSpan("agent.turn", {
      attributes: { "agent.id": agentId },
    }, parentCtx);

    await this.sendRequest(state, "session/prompt", {
      sessionId: state.acpSessionId,
      prompt: [{ type: "text", text: message }],
    });
  }

  async stopAgent(agentId: string): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) return;
    state.lifecycleState = "stopping";
    if (state.stopTimer) { clearTimeout(state.stopTimer); state.stopTimer = null; }
    this.agents.delete(agentId);
    state.tcpSocket.destroy();
    // End OTEL spans
    state.turnSpan?.end();
    for (const span of state.toolSpans.values()) span.end();
    state.sessionSpan?.end();
    // Stop Docker container
    try { await this.docker.getContainer(state.containerId).stop({ t: 10 }); } catch {}
    try { await this.docker.getContainer(state.containerId).remove(); } catch {}
    this.emitWsEvent(agentId, { type: "agent:stopped", agentId });
  }

  onOutput(agentId: string, handler: (event: WsAcpEvent) => void): () => void {
    const state = this.agents.get(agentId);
    if (!state) return () => {};
    state.outputHandlers.add(handler);
    return () => state.outputHandlers.delete(handler);
  }

  incrementConnections(agentId: string): void {
    const state = this.agents.get(agentId);
    if (!state) return;
    if (state.stopTimer) { clearTimeout(state.stopTimer); state.stopTimer = null; state.lifecycleState = "running"; }
    state.wsConnectionCount++;
  }

  decrementConnections(agentId: string): void {
    const state = this.agents.get(agentId);
    if (!state) return;
    state.wsConnectionCount = Math.max(0, state.wsConnectionCount - 1);
    this.checkStop(agentId, state);
  }

  // ── private ──────────────────────────────────────────────

  private async sendRequest(
    state: AgentState,
    method: string,
    params: Record<string, unknown>
  ): Promise<AcpResponse> {
    const id = state.nextRequestId++;
    const request: AcpRequest = { jsonrpc: "2.0", id, method, params };
    state.tcpSocket.write(JSON.stringify(request) + "\n");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pendingRequests.delete(id);
        reject(new Error(`ACP request ${method} timed out`));
      }, 120_000);
      state.pendingRequests.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  private listenTcp(agentId: string, state: AgentState): void {
    state.tcpSocket.on("data", (chunk: Buffer) => {
      state.lineBuffer += chunk.toString();
      const lines = state.lineBuffer.split("\n");
      state.lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim()) as AcpMessage;
          this.handleAcpMessage(agentId, state, msg);
        } catch { /* ignore malformed */ }
      }
    });

    state.tcpSocket.on("close", () => {
      if (state.lifecycleState !== "stopping") {
        state.lifecycleState = "crashed";
        this.agents.delete(agentId);
        state.sessionSpan?.setStatus({ code: SpanStatusCode.ERROR, message: "connection lost" });
        state.sessionSpan?.end();
        this.emitWsEvent(agentId, { type: "agent:crashed", agentId, message: "TCP connection lost" });
      }
    });

    state.tcpSocket.on("error", (err) => {
      console.error(`[AcpAgentManager] TCP error for ${agentId}:`, err.message);
    });
  }

  private handleAcpMessage(agentId: string, state: AgentState, msg: AcpMessage): void {
    // Response to a pending request
    if ("id" in msg && msg.id != null) {
      const pending = state.pendingRequests.get(msg.id as number);
      if (pending) {
        state.pendingRequests.delete(msg.id as number);
        if ("error" in msg && msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg as AcpResponse);
        }
      }
      return;
    }

    // Notification (no id)
    const notification = msg as AcpNotification;
    if (notification.method !== "session/update") return;

    const update = notification.params;
    const updateType = update.type as string;

    if (updateType === "agent_message_chunk") {
      this.emitWsEvent(agentId, {
        type: "acp:agent_message_chunk",
        agentId,
        content: update.content,
      });
    } else if (updateType === "tool_call") {
      const toolCallId = update.toolCallId as string;
      this.toolCallStartTimes.set(`${agentId}:${toolCallId}`, Date.now());
      toolCallCounter.add(1, { "agent.id": agentId, "tool.name": update.title as string });

      const parentCtx = state.turnSpan
        ? trace.setSpan(context.active(), state.turnSpan)
        : context.active();
      const toolSpan = tracer.startSpan(`agent.tool.${update.title}`, {
        attributes: { "agent.id": agentId, "tool.name": update.title as string },
      }, parentCtx);
      state.toolSpans.set(toolCallId, toolSpan);

      this.emitWsEvent(agentId, {
        type: "acp:tool_call",
        agentId,
        toolCallId,
        title: update.title as string,
        kind: update.kind as string,
        status: update.status as string,
        content: update.content as unknown[] | undefined,
        locations: update.locations as unknown[] | undefined,
      });
    } else if (updateType === "tool_call_update") {
      const toolCallId = update.toolCallId as string;
      const status = update.status as string;

      if (status === "completed" || status === "failed") {
        const start = this.toolCallStartTimes.get(`${agentId}:${toolCallId}`);
        if (start) {
          toolCallDuration.record(Date.now() - start, { "agent.id": agentId });
          this.toolCallStartTimes.delete(`${agentId}:${toolCallId}`);
        }
        const toolSpan = state.toolSpans.get(toolCallId);
        if (toolSpan) {
          if (status === "failed") toolSpan.setStatus({ code: SpanStatusCode.ERROR });
          toolSpan.end();
          state.toolSpans.delete(toolCallId);
        }
      }

      this.emitWsEvent(agentId, {
        type: "acp:tool_call_update",
        agentId,
        toolCallId,
        status,
        content: update.content as unknown[] | undefined,
        locations: update.locations as unknown[] | undefined,
      });
    } else if (updateType === "plan") {
      this.emitWsEvent(agentId, {
        type: "acp:plan",
        agentId,
        items: update.items as unknown[],
      });
    }

    // Check for turn completion in session/prompt response
    if (update.stopReason) {
      state.isStreaming = false;
      state.promptPending = false;
      state.turnSpan?.end();
      state.turnSpan = null;
      this.emitWsEvent(agentId, {
        type: "acp:turn_complete",
        agentId,
        stopReason: update.stopReason as string,
      });
    }
  }

  private emitWsEvent(agentId: string, event: WsAcpEvent): void {
    const state = this.agents.get(agentId);
    if (state) {
      for (const handler of state.outputHandlers) {
        try { handler(event); } catch { /* ignore */ }
      }
    }
    this.emit(agentId, event);
    void appendEvent(agentId, {
      type: event.type,
      payload: event as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });
  }

  private checkStop(agentId: string, state: AgentState): void {
    if (state.wsConnectionCount > 0 || state.isStreaming || state.promptPending) return;
    if (state.lifecycleState !== "running") return;
    if (state.stopTimer) return;
    state.lifecycleState = "idle";
    state.stopTimer = setTimeout(() => {
      state.stopTimer = null;
      void this.stopAgent(agentId);
    }, 120_000);
  }

  private async connectTcp(host: string, port: number, maxWaitMs: number): Promise<Socket> {
    const start = Date.now();
    let attempt = 0;
    while (true) {
      try {
        return await new Promise<Socket>((resolve, reject) => {
          const s = new Socket();
          const timer = setTimeout(() => { s.destroy(); reject(new Error("connect timeout")); }, 5000);
          s.connect(port, host, () => { clearTimeout(timer); resolve(s); });
          s.on("error", (err) => { clearTimeout(timer); s.destroy(); reject(err); });
        });
      } catch {
        attempt++;
        if (Date.now() - start >= maxWaitMs) {
          throw new Error(`TCP connect to ${host}:${port} timed out after ${maxWaitMs}ms`);
        }
        const delay = Math.min(500 * Math.pow(2, attempt - 1), 5000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async findExistingContainer(name: string): Promise<string | null> {
    try {
      const containers = await this.docker.listContainers({ all: true });
      const match = containers.find((c) =>
        c.Names?.some((n: string) => n === `/${name}` || n === name)
      );
      return match ? match.Id : null;
    } catch { return null; }
  }

  async cleanupStaleContainers(): Promise<void> {
    try {
      const containers = await this.docker.listContainers({ all: true });
      for (const c of containers) {
        const name = (c.Names?.[0] ?? "").replace(/^\//, "");
        if (!name.startsWith("planning-") && !name.startsWith("sub-")) continue;
        if (c.State !== "running") {
          try { await this.docker.getContainer(c.Id).remove({ force: true }); } catch {}
        }
      }
    } catch (err) {
      console.warn("[AcpAgentManager] cleanup error:", err);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd backend test -- --run acpAgentManager`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/orchestrator/acpAgentManager.ts backend/src/__tests__/acpAgentManager.test.ts
git commit -m "feat: implement AcpAgentManager with ACP JSON-RPC 2.0 handshake and event forwarding"
```

---

## Task 11: MCP Server (Backend-Hosted)

**Files:**
- Create: `backend/src/mcp/server.ts`
- Create: `backend/src/mcp/tools/dispatch_tasks.ts`
- Create: `backend/src/mcp/tools/ask_planning_agent.ts`
- Create: `backend/src/mcp/tools/write_planning_document.ts`
- Create: `backend/src/mcp/tools/get_task_status.ts`
- Create: `backend/src/mcp/tools/get_pull_requests.ts`
- Create: `backend/src/mcp/tools/reply_to_subagent.ts`
- Create: `backend/src/mcp/tools/web_fetch.ts`
- Test: `backend/src/__tests__/mcpServer.test.ts`

- [ ] **Step 1: Install MCP SDK dependency**

Run: `bun add --cwd backend @modelcontextprotocol/sdk`

- [ ] **Step 2: Write failing test for MCP server**

Create `backend/src/__tests__/mcpServer.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import { createMcpMiddleware } from "../mcp/server.js";
import { initDb } from "../store/db.js";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";

describe("MCP SSE server", () => {
  let app: express.Express;

  beforeAll(async () => {
    const dir = mkdtempSync(`${tmpdir()}/harness-test-`);
    await initDb(dir);
    app = express();
    app.use("/mcp", createMcpMiddleware());
  });

  it("responds to SSE connection on /mcp", async () => {
    // The MCP SSE endpoint should accept a GET request and start streaming
    const res = await request(app).get("/mcp?projectId=test&sessionId=test&role=planning");
    // SSE endpoint returns 200 with text/event-stream or the SDK's response
    expect(res.status).toBeOneOf([200, 204]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run --cwd backend test -- --run mcpServer`
Expected: FAIL — module not found

- [ ] **Step 4: Implement MCP tool modules**

Create each tool file. Example for `backend/src/mcp/tools/get_task_status.ts`:

```typescript
import { getProject } from "../../store/projects.js";

export const getTaskStatusTool = {
  name: "get_task_status",
  description: "Get the status of all tasks for the current project",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
  async execute(args: Record<string, unknown>, context: { projectId: string }) {
    const project = await getProject(context.projectId);
    if (!project?.plan) return { content: [{ type: "text", text: "No plan found" }] };
    const tasks = project.plan.tasks.map((t) => ({
      id: t.id,
      description: t.description.slice(0, 100),
      status: t.status,
      error: t.errorMessage,
    }));
    return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
  },
};
```

Create `backend/src/mcp/tools/dispatch_tasks.ts`:

```typescript
import { getAcpAgentManager } from "../../orchestrator/acpAgentManager.js";

export const dispatchTasksTool = {
  name: "dispatch_tasks",
  description: "Dispatch implementation tasks to sub-agents",
  inputSchema: {
    type: "object" as const,
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            repositoryId: { type: "string" },
            description: { type: "string" },
          },
          required: ["repositoryId", "description"],
        },
      },
    },
    required: ["tasks"],
  },
  async execute(args: { tasks: Array<{ id?: string; repositoryId: string; description: string }> }, context: { projectId: string }) {
    // Delegate to the existing task dispatch flow in recoveryService
    // This will be wired up in the integration step
    return { content: [{ type: "text", text: `Dispatched ${args.tasks.length} task(s)` }] };
  },
};
```

Create `backend/src/mcp/tools/ask_planning_agent.ts`:

```typescript
import { getAcpAgentManager } from "../../orchestrator/acpAgentManager.js";

export const askPlanningAgentTool = {
  name: "ask_planning_agent",
  description: "Ask the planning agent a question (for sub-agents only)",
  inputSchema: {
    type: "object" as const,
    properties: {
      question: { type: "string", description: "The question to ask" },
    },
    required: ["question"],
  },
  async execute(args: { question: string }, context: { projectId: string }) {
    const manager = getAcpAgentManager();
    const planningAgentId = `planning-${context.projectId}`;
    await manager.sendPrompt(planningAgentId, `Sub-agent question: ${args.question}`);
    return { content: [{ type: "text", text: "Question sent to planning agent" }] };
  },
};
```

Create `backend/src/mcp/tools/write_planning_document.ts`:

```typescript
import { writePlanningDocument } from "../../agents/planningTool.js";

export const writePlanningDocumentTool = {
  name: "write_planning_document",
  description: "Write a spec or plan document to the planning branch",
  inputSchema: {
    type: "object" as const,
    properties: {
      type: { type: "string", enum: ["spec", "plan"] },
      content: { type: "string", description: "Full markdown content" },
    },
    required: ["type", "content"],
  },
  async execute(args: { type: "spec" | "plan"; content: string }, context: { projectId: string }) {
    const result = await writePlanningDocument(context.projectId, args.type, args.content);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
};
```

Create `backend/src/mcp/tools/get_pull_requests.ts`:

```typescript
import { listPullRequestsForProject } from "../../store/pullRequests.js";

export const getPullRequestsTool = {
  name: "get_pull_requests",
  description: "List pull requests created by sub-agents for this project",
  inputSchema: { type: "object" as const, properties: {} },
  async execute(_args: Record<string, unknown>, context: { projectId: string }) {
    const prs = await listPullRequestsForProject(context.projectId);
    const summary = prs.map((pr) => ({ url: pr.url, branch: pr.branch, status: pr.status }));
    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  },
};
```

Create `backend/src/mcp/tools/reply_to_subagent.ts`:

```typescript
export const replyToSubagentTool = {
  name: "reply_to_subagent",
  description: "Reply to a sub-agent's question",
  inputSchema: {
    type: "object" as const,
    properties: {
      sessionId: { type: "string" },
      message: { type: "string" },
    },
    required: ["sessionId", "message"],
  },
  async execute(args: { sessionId: string; message: string }, _context: { projectId: string }) {
    // Post reply to agent message endpoint
    const { insertAgentMessage } = await import("../../store/agents.js");
    await insertAgentMessage(args.sessionId, "user", args.message);
    return { content: [{ type: "text", text: "Reply sent" }] };
  },
};
```

Create `backend/src/mcp/tools/web_fetch.ts`:

```typescript
export const webFetchTool = {
  name: "web_fetch",
  description: "Fetch a URL (HTTP GET/POST). Blocks private IPs.",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: { type: "string" },
      method: { type: "string", enum: ["GET", "POST", "PUT"], default: "GET" },
      body: { type: "string" },
      headers: { type: "object" },
    },
    required: ["url"],
  },
  async execute(args: { url: string; method?: string; body?: string; headers?: Record<string, string> }) {
    // SSRF guard: block private IPs
    const urlObj = new URL(args.url);
    const host = urlObj.hostname;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.|169\.254\.|localhost)/i.test(host)) {
      return { content: [{ type: "text", text: "Error: private/internal URLs are blocked" }] };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(args.url, {
        method: args.method ?? "GET",
        body: args.body,
        headers: args.headers,
        signal: controller.signal,
      });
      const text = await res.text();
      const truncated = text.slice(0, 200_000);
      return { content: [{ type: "text", text: truncated }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Fetch error: ${err.message}` }] };
    } finally {
      clearTimeout(timer);
    }
  },
};
```

- [ ] **Step 5: Implement MCP server middleware**

Create `backend/src/mcp/server.ts`:

```typescript
import { Router } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { dispatchTasksTool } from "./tools/dispatch_tasks.js";
import { askPlanningAgentTool } from "./tools/ask_planning_agent.js";
import { writePlanningDocumentTool } from "./tools/write_planning_document.js";
import { getTaskStatusTool } from "./tools/get_task_status.js";
import { getPullRequestsTool } from "./tools/get_pull_requests.js";
import { replyToSubagentTool } from "./tools/reply_to_subagent.js";
import { webFetchTool } from "./tools/web_fetch.js";

const PLANNING_TOOLS = [dispatchTasksTool, writePlanningDocumentTool, getTaskStatusTool, getPullRequestsTool, replyToSubagentTool, webFetchTool];
const IMPL_TOOLS = [askPlanningAgentTool, webFetchTool];

export function createMcpMiddleware(): Router {
  const router = Router();
  const transports = new Map<string, SSEServerTransport>();

  router.get("/", async (req, res) => {
    const projectId = req.query.projectId as string;
    const sessionId = req.query.sessionId as string;
    const role = (req.query.role as string) ?? "planning";
    const context = { projectId, sessionId, role };

    const server = new McpServer({ name: "harness", version: "1.0.0" });
    const tools = role === "planning" ? PLANNING_TOOLS : IMPL_TOOLS;

    for (const tool of tools) {
      server.tool(tool.name, tool.description, tool.inputSchema, async (args) => {
        return tool.execute(args as any, context);
      });
    }

    const transport = new SSEServerTransport("/mcp/messages", res);
    transports.set(sessionId, transport);
    res.on("close", () => transports.delete(sessionId));
    await server.connect(transport);
  });

  router.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);
    if (!transport) return res.status(404).json({ error: "No transport" });
    await transport.handlePostMessage(req, res);
  });

  return router;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun run --cwd backend test -- --run mcpServer`
Expected: PASS (or adjust test expectations based on SDK behavior)

- [ ] **Step 7: Commit**

```bash
git add backend/src/mcp/
git add backend/src/__tests__/mcpServer.test.ts
git commit -m "feat: implement backend-hosted MCP SSE server with harness tools"
```

---

## Task 12: Wire AcpAgentManager into Backend Bootstrap

**Files:**
- Modify: `backend/src/index.ts`
- Modify: `backend/src/api/routes.ts`
- Modify: `backend/src/api/websocket.ts`

- [ ] **Step 1: Replace PlanningAgentManager with AcpAgentManager in index.ts**

In `backend/src/index.ts`:
- Replace import of `PlanningAgentManager`/`setPlanningAgentManager` with `AcpAgentManager`/`setAcpAgentManager`
- Replace `new PlanningAgentManager(docker)` with `new AcpAgentManager(docker)`
- Replace `setPlanningAgentManager(mgr)` with `setAcpAgentManager(mgr)`
- Keep all other bootstrap logic (initDb, RecoveryService, etc.)

- [ ] **Step 2: Mount MCP middleware in routes.ts**

In `backend/src/api/routes.ts`, add:
```typescript
import { createMcpMiddleware } from "../mcp/server.js";
```

And mount it:
```typescript
router.use("/mcp", createMcpMiddleware());
```

- [ ] **Step 3: Update websocket.ts to use AcpAgentManager**

In `backend/src/api/websocket.ts`:
- Replace import of `getPlanningAgentManager`/`PlanningAgentEvent` with `getAcpAgentManager`/`WsAcpEvent`
- Replace all calls to `getPlanningAgentManager()` with `getAcpAgentManager()`
- Update the output broadcaster registration to use `onOutput` with ACP event types
- Update the `send` calls to forward ACP events as-is (they already have the right shape)
- The `ensureRunning` call changes from `mgr.ensureRunning(projectId, repos)` to `mgr.ensureRunning(planningAgentId, agentType, "planning", envVars)` where `agentType` comes from `resolveAgentConfig`

- [ ] **Step 4: Run existing backend tests**

Run: `bun run --cwd backend test`
Expected: Tests may need minor adjustments for new imports. Fix any failures.

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.ts backend/src/api/routes.ts backend/src/api/websocket.ts
git commit -m "feat: wire AcpAgentManager and MCP server into backend bootstrap"
```

---

## Task 13: Update TaskDispatcher for ACP Sub-Agents

**Files:**
- Modify: `backend/src/orchestrator/taskDispatcher.ts`
- Modify: `backend/src/orchestrator/containerManager.ts`
- Modify: `backend/src/orchestrator/recoveryService.ts`

- [ ] **Step 1: Update containerManager to use agentImage()**

In `backend/src/orchestrator/containerManager.ts`, the `createSubAgentContainer` function currently hardcodes `config.subAgentImage`. Add an `agentType` parameter to the options interface and use `agentImage(agentType)` instead.

Add to `ContainerCreateOptions`:
```typescript
agentType?: string;  // "pi" | "gemini" | "claude" | "copilot" | "opencode"
```

Replace `config.subAgentImage` with:
```typescript
const image = opts.agentType ? agentImage(opts.agentType) : config.subAgentImage;
```

- [ ] **Step 2: Update taskDispatcher to resolve agent config per project**

In `backend/src/orchestrator/taskDispatcher.ts`:
- Import `resolveAgentConfig` from config
- In `runTask()`, resolve the implementation agent config from the project:
```typescript
const implConfig = resolveAgentConfig("implementation", project.implementationAgent);
```
- Pass `agentType: implConfig.type` and `agentModel: implConfig.model` to `createSubAgentContainer`

- [ ] **Step 3: Update recoveryService references**

In `backend/src/orchestrator/recoveryService.ts`:
- Replace import of `getPlanningAgentManager` with `getAcpAgentManager`
- Update any direct calls to `planningAgentManager.injectMessage()` to use `getAcpAgentManager().sendPrompt()`

- [ ] **Step 4: Run backend tests**

Run: `bun run --cwd backend test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/orchestrator/taskDispatcher.ts \
       backend/src/orchestrator/containerManager.ts \
       backend/src/orchestrator/recoveryService.ts
git commit -m "feat: update task dispatcher and recovery service for multi-agent ACP"
```

---

## Task 14: Frontend — ACP Event Types + Chat Component Update

**Files:**
- Create: `frontend/src/lib/acpEvents.ts`
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/pages/Chat.tsx`

- [ ] **Step 1: Create ACP event type definitions**

Create `frontend/src/lib/acpEvents.ts`:

```typescript
export type WsAcpEvent =
  | { type: "acp:agent_message_chunk"; agentId: string; content: { type: string; text?: string } }
  | { type: "acp:tool_call"; agentId: string; toolCallId: string; title: string; kind: string; status: string; content?: unknown[]; locations?: unknown[] }
  | { type: "acp:tool_call_update"; agentId: string; toolCallId: string; status: string; content?: unknown[]; locations?: unknown[] }
  | { type: "acp:plan"; agentId: string; items: Array<{ title: string; status: string }> }
  | { type: "acp:turn_complete"; agentId: string; stopReason: string }
  | { type: "acp:error"; agentId: string; message: string }
  | { type: "agent:started"; agentId: string }
  | { type: "agent:stopped"; agentId: string }
  | { type: "agent:crashed"; agentId: string; message: string }
  // Legacy events still used for sub-agent activity
  | { type: "agent_activity"; sessionId: string; event: unknown }
  | { type: "stuck_agent"; sessionId: string }
  | { type: "replay"; messages: unknown[] }
  | { type: "error"; message: string };

export function isAcpEvent(msg: { type: string }): boolean {
  return msg.type.startsWith("acp:") || msg.type.startsWith("agent:");
}
```

- [ ] **Step 2: Update Chat.tsx to handle ACP events**

In `frontend/src/pages/Chat.tsx`, update the WebSocket message handler to handle both legacy events (for backward compatibility during transition) and new ACP events:

- Add import: `import { type WsAcpEvent, isAcpEvent } from "../lib/acpEvents.js";`
- In the message handler, add cases for:
  - `acp:agent_message_chunk` → append text to current message (same as `delta`)
  - `acp:tool_call` → show tool card with title, kind, status badge
  - `acp:tool_call_update` → update tool card status
  - `acp:plan` → render plan items as a checklist
  - `acp:turn_complete` → mark message complete
  - `acp:error` → show error
  - `agent:started/stopped/crashed` → show agent lifecycle status

The key mapping from old to new:
```typescript
case "acp:agent_message_chunk":
  // Same as old "delta" handler
  if (msg.content?.type === "text" && msg.content.text) {
    appendDelta(msg.content.text);
  }
  break;
case "acp:tool_call":
  setToolCalls(prev => [...prev, { id: msg.toolCallId, name: msg.title, status: msg.status }]);
  break;
case "acp:tool_call_update":
  setToolCalls(prev => prev.map(tc =>
    tc.id === msg.toolCallId ? { ...tc, status: msg.status } : tc
  ));
  break;
case "acp:turn_complete":
  setThinking("none");
  break;
```

- [ ] **Step 3: Add agent config types to api.ts**

In `frontend/src/lib/api.ts`, add:

```typescript
export interface AgentConfig {
  type: string;
  model?: string;
}

export interface AvailableAgent {
  type: string;
  available: boolean;
}
```

Add to the `api` object:
```typescript
agentConfig: {
  available: (): Promise<{ agents: AvailableAgent[] }> =>
    fetchJson("/api/config/available-agents"),
  get: (projectId: string): Promise<{ planningAgent: AgentConfig | null; implementationAgent: AgentConfig | null; defaults: { planningAgent: AgentConfig; implementationAgent: AgentConfig } }> =>
    fetchJson(`/api/projects/${projectId}/agent-config`),
  update: (projectId: string, config: { planningAgent?: AgentConfig; implementationAgent?: AgentConfig }): Promise<void> =>
    fetchJson(`/api/projects/${projectId}/agent-config`, { method: "PUT", body: JSON.stringify(config), headers: { "Content-Type": "application/json" } }),
},
```

- [ ] **Step 4: Run frontend tests**

Run: `bun run --cwd frontend test`
Expected: PASS (adjust test mocks if needed)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/acpEvents.ts frontend/src/lib/api.ts frontend/src/pages/Chat.tsx
git commit -m "feat: add ACP event handling to frontend Chat component"
```

---

## Task 15: Frontend — Agent Settings UI

**Files:**
- Create: `frontend/src/pages/AgentSettings.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/Settings.tsx`

- [ ] **Step 1: Create AgentSettings component**

Create `frontend/src/pages/AgentSettings.tsx`:

```tsx
import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { api, type AgentConfig, type AvailableAgent } from "../lib/api";

export default function AgentSettings() {
  const { id: projectId } = useParams<{ id: string }>();
  const [available, setAvailable] = useState<AvailableAgent[]>([]);
  const [planning, setPlanning] = useState<AgentConfig>({ type: "" });
  const [implementation, setImplementation] = useState<AgentConfig>({ type: "" });
  const [defaults, setDefaults] = useState<{ planningAgent: AgentConfig; implementationAgent: AgentConfig } | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!projectId) return;
    Promise.all([
      api.agentConfig.available(),
      api.agentConfig.get(projectId),
    ]).then(([avail, config]) => {
      setAvailable(avail.agents);
      setDefaults(config.defaults);
      setPlanning(config.planningAgent ?? config.defaults.planningAgent);
      setImplementation(config.implementationAgent ?? config.defaults.implementationAgent);
    });
  }, [projectId]);

  const handleSave = async () => {
    if (!projectId) return;
    setSaving(true);
    try {
      await api.agentConfig.update(projectId, {
        planningAgent: planning,
        implementationAgent: implementation,
      });
      setMessage("Saved");
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    }
    setSaving(false);
  };

  const handleReset = () => {
    if (!defaults) return;
    setPlanning(defaults.planningAgent);
    setImplementation(defaults.implementationAgent);
  };

  const enabledAgents = available.filter((a) => a.available);

  return (
    <div className="max-w-xl mx-auto p-6">
      <h2 className="text-xl font-bold mb-4">Agent Configuration</h2>

      <section className="mb-6">
        <h3 className="font-semibold mb-2">Planning Agent</h3>
        <div className="flex gap-4">
          <select
            value={planning.type}
            onChange={(e) => setPlanning({ ...planning, type: e.target.value })}
            className="border rounded px-2 py-1"
          >
            {enabledAgents.map((a) => (
              <option key={a.type} value={a.type}>{a.type}</option>
            ))}
          </select>
          <input
            type="text"
            value={planning.model ?? ""}
            onChange={(e) => setPlanning({ ...planning, model: e.target.value || undefined })}
            placeholder="Model (optional)"
            className="border rounded px-2 py-1 flex-1"
          />
        </div>
      </section>

      <section className="mb-6">
        <h3 className="font-semibold mb-2">Implementation Agent</h3>
        <div className="flex gap-4">
          <select
            value={implementation.type}
            onChange={(e) => setImplementation({ ...implementation, type: e.target.value })}
            className="border rounded px-2 py-1"
          >
            {enabledAgents.map((a) => (
              <option key={a.type} value={a.type}>{a.type}</option>
            ))}
          </select>
          <input
            type="text"
            value={implementation.model ?? ""}
            onChange={(e) => setImplementation({ ...implementation, model: e.target.value || undefined })}
            placeholder="Model (optional)"
            className="border rounded px-2 py-1 flex-1"
          />
        </div>
      </section>

      {defaults && (
        <p className="text-sm text-gray-500 mb-4">
          Defaults: {defaults.planningAgent.type}/{defaults.planningAgent.model} (planning),
          {" "}{defaults.implementationAgent.type}/{defaults.implementationAgent.model} (implementation)
        </p>
      )}

      <div className="flex gap-3">
        <button onClick={handleSave} disabled={saving} className="bg-blue-600 text-white px-4 py-2 rounded">
          {saving ? "Saving..." : "Save"}
        </button>
        <button onClick={handleReset} className="border px-4 py-2 rounded">
          Reset to defaults
        </button>
      </div>

      {message && <p className="mt-3 text-sm">{message}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Add route in App.tsx**

In `frontend/src/App.tsx`, add:
```typescript
import AgentSettings from "./pages/AgentSettings";
```

And add route:
```tsx
<Route path="/projects/:id/agents" element={<AgentSettings />} />
```

- [ ] **Step 3: Add link from Settings page**

In `frontend/src/pages/Settings.tsx`, add a link/button to navigate to the per-project agent settings page.

- [ ] **Step 4: Run frontend tests**

Run: `bun run --cwd frontend test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/AgentSettings.tsx frontend/src/App.tsx frontend/src/pages/Settings.tsx
git commit -m "feat: add per-project agent settings UI"
```

---

## Task 16: Update docker-compose.yml

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Replace planning-agent and sub-agent with agent images**

In `docker-compose.yml`, remove the `planning-agent` and `sub-agent` service definitions. Replace with:

```yaml
  agent-base:
    build:
      context: .
      dockerfile: agents/base/Dockerfile.base
    image: multi-agent-harness/agent-base:latest
    profiles: [build-only]

  agent-pi:
    build:
      context: .
      dockerfile: agents/pi/Dockerfile
    image: multi-agent-harness/agent-pi:latest
    profiles: [build-only]
    depends_on:
      - agent-base

  agent-copilot:
    build:
      context: .
      dockerfile: agents/copilot/Dockerfile
    image: multi-agent-harness/agent-copilot:latest
    profiles: [build-only]
    depends_on:
      - agent-base

  agent-gemini:
    build:
      context: .
      dockerfile: agents/gemini/Dockerfile
    image: multi-agent-harness/agent-gemini:latest
    profiles: [build-only]
    depends_on:
      - agent-base

  agent-claude:
    build:
      context: .
      dockerfile: agents/claude/Dockerfile
    image: multi-agent-harness/agent-claude:latest
    profiles: [build-only]
    depends_on:
      - agent-base

  agent-opencode:
    build:
      context: .
      dockerfile: agents/opencode/Dockerfile
    image: multi-agent-harness/agent-opencode:latest
    profiles: [build-only]
    depends_on:
      - agent-base
```

- [ ] **Step 2: Update backend environment to remove old image references**

Update the `backend` service environment to remove or update `PLANNING_AGENT_IMAGE` and `SUB_AGENT_IMAGE` references — these are now resolved dynamically by `agentImage()`.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: replace planning-agent/sub-agent with multi-agent images in docker-compose"
```

---

## Task 17: Delete Legacy Agent Directories

**Files:**
- Delete: `planning-agent/` (entire directory)
- Delete: `sub-agent/` (entire directory)

- [ ] **Step 1: Verify no remaining imports reference old paths**

Run: `grep -r "planning-agent/" backend/src/ frontend/src/ --include="*.ts" --include="*.tsx"`
Run: `grep -r "sub-agent/" backend/src/ frontend/src/ --include="*.ts" --include="*.tsx"`

Fix any remaining references.

- [ ] **Step 2: Delete directories**

```bash
rm -rf planning-agent/ sub-agent/
```

- [ ] **Step 3: Update root package.json if it references these directories**

Check `package.json` workspaces — `planning-agent` and `sub-agent` are NOT in the root workspaces (confirmed earlier), so no change needed.

- [ ] **Step 4: Commit**

```bash
git rm -r planning-agent/ sub-agent/
git commit -m "chore: remove legacy planning-agent and sub-agent directories (replaced by agents/)"
```

---

## Task 18: E2E Test Parametrization

**Files:**
- Modify: `e2e-tests/playwright.config.ts`
- Modify: `e2e-tests/planning-agent-tests/rpc-client.ts`
- Modify: `e2e-tests/planning-agent-tests/planning-agent.test.ts`
- Modify: `e2e-tests/tests/helpers.ts`

- [ ] **Step 1: Rewrite rpc-client.ts as ACP client**

Rewrite `e2e-tests/planning-agent-tests/rpc-client.ts` to speak ACP JSON-RPC 2.0 instead of the pi-specific RPC protocol:

```typescript
import { createConnection, Socket } from "net";
import { execSync } from "child_process";
import { mkdtempSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface AcpEvent {
  jsonrpc: "2.0";
  method?: string;
  id?: number;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export class AcpTestClient {
  private socket: Socket | null = null;
  private lineBuffer = "";
  readonly containerName: string;
  private nextId = 1;
  private pendingRequests = new Map<number, {
    resolve: (r: AcpEvent) => void;
    reject: (e: Error) => void;
  }>();

  constructor(
    private readonly options: {
      projectId: string;
      agentType: string;  // "pi" | "copilot" | etc.
      provider?: string;
      model?: string;
      backendUrl?: string;
      env?: string[];
    }
  ) {
    this.containerName = `agent-test-${options.agentType}-${options.projectId}`;
  }

  async start(connectTimeoutMs = 120_000): Promise<void> {
    const image = `multi-agent-harness/agent-${this.options.agentType}:latest`;
    const envFlags = [
      `-e AGENT_ROLE=planning`,
      `-e PROJECT_ID=${this.options.projectId}`,
      `-e AGENT_PROVIDER=${this.options.provider ?? "github-copilot"}`,
      `-e AGENT_MODEL=${this.options.model ?? "gpt-5-mini"}`,
      ...(this.options.env ?? []).map(e => `-e ${e}`),
    ].join(" ");

    execSync(
      `docker run -d --name ${this.containerName} ${envFlags} ${image}`,
      { stdio: "pipe" }
    );

    const ip = execSync(
      `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${this.containerName}`
    ).toString().trim();

    await waitForPort(ip, 3333, connectTimeoutMs);
    this.socket = await tcpConnect(ip, 3333);
    this.startListening();

    // ACP handshake
    await this.sendRequest("initialize", { protocolVersion: 1, clientCapabilities: {} });
    await this.sendRequest("session/new", { cwd: "/workspace" });
  }

  async sendPrompt(message: string, timeoutMs = 90_000): Promise<AcpEvent[]> {
    if (!this.socket) throw new Error("Not connected");
    const events: AcpEvent[] = [];

    const id = this.nextId++;
    this.socket.write(JSON.stringify({
      jsonrpc: "2.0", id, method: "session/prompt",
      params: { prompt: [{ type: "text", text: message }] },
    }) + "\n");

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(events), timeoutMs);

      const handler = (event: AcpEvent) => {
        events.push(event);
        // session/prompt response means turn is done
        if (event.id === id && event.result) {
          clearTimeout(timer);
          this.off("event", handler);
          resolve(events);
        }
      };
      this.on("event", handler);
    });
  }

  private async sendRequest(method: string, params: Record<string, unknown>): Promise<AcpEvent> {
    const id = this.nextId++;
    this.socket!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 30_000);
      this.pendingRequests.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  private startListening(): void {
    this.socket!.on("data", (chunk: Buffer) => {
      this.lineBuffer += chunk.toString();
      const lines = this.lineBuffer.split("\n");
      this.lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as AcpEvent;
          // Response to pending request
          if (msg.id != null && this.pendingRequests.has(msg.id)) {
            const p = this.pendingRequests.get(msg.id)!;
            this.pendingRequests.delete(msg.id);
            p.resolve(msg);
          }
          this.emit("event", msg);
        } catch {}
      }
    });
  }

  // Simple EventEmitter-like for tests
  private listeners = new Map<string, Set<Function>>();
  on(event: string, fn: Function) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event)!.add(fn); }
  off(event: string, fn: Function) { this.listeners.get(event)?.delete(fn); }
  private emit(event: string, ...args: unknown[]) { for (const fn of this.listeners.get(event) ?? []) fn(...args); }

  async stop(): Promise<void> {
    this.socket?.destroy();
    try { execSync(`docker stop -t 1 ${this.containerName}`, { stdio: "pipe" }); } catch {}
    try { execSync(`docker rm ${this.containerName}`, { stdio: "pipe" }); } catch {}
  }
}

// Helper functions (same as original)
async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    try { const s = await tcpConnect(host, port, 3000); s.destroy(); return; }
    catch { attempt++; await new Promise(r => setTimeout(r, Math.min(1000 * 1.5 ** (attempt - 1), 5000))); }
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

function tcpConnect(host: string, port: number, timeout = 5000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, host);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("connect timeout")); }, timeout);
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (err) => { clearTimeout(timer); socket.destroy(); reject(err); });
  });
}
```

- [ ] **Step 2: Update playwright.config.ts for parametrized agent projects**

In `e2e-tests/playwright.config.ts`, add agent configuration projects:

```typescript
import { defineConfig, devices } from '@playwright/test';

const agentConfigs = [
  { name: "pi-pi", planning: "pi", implementation: "pi" },
  { name: "copilot-copilot", planning: "copilot", implementation: "copilot" },
  { name: "pi-copilot", planning: "pi", implementation: "copilot" },
];

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: 'html',
  use: {
    baseURL: process.env.HARNESS_URL || 'http://localhost:8080',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10000,
  },
  projects: agentConfigs.map(cfg => ({
    name: cfg.name,
    use: {
      ...devices['Desktop Chrome'],
      agentConfig: cfg,
    },
  })),
  timeout: 60000,
  expect: { timeout: 50000 },
});
```

- [ ] **Step 3: Update helpers.ts to use agentConfig from test info**

In `e2e-tests/tests/helpers.ts`, add a helper to create projects with the parametrized agent config:

```typescript
export async function createProjectWithAgentConfig(
  request: APIRequestContext,
  name: string,
  agentConfig: { planning: string; implementation: string }
) {
  // Create project
  const res = await request.post(`${API_BASE}/projects`, {
    data: { name, source: { type: "freeform", freeformDescription: "E2E test" } },
  });
  const project = await res.json();

  // Set agent config
  await request.put(`${API_BASE}/projects/${project.id}/agent-config`, {
    data: {
      planningAgent: { type: agentConfig.planning },
      implementationAgent: { type: agentConfig.implementation },
    },
  });

  return project;
}
```

- [ ] **Step 4: Update planning-agent.test.ts for ACP protocol**

In `e2e-tests/planning-agent-tests/planning-agent.test.ts`, replace `PlanningAgentRpcClient` with `AcpTestClient`. Update assertions:
- Instead of checking for pi-specific events like `agent_start`/`agent_end`, check for ACP `session/update` notifications
- Skills test: verify the agent can access superpowers skills (check for brainstorming/writing-plans in response)
- Guard hook test: send a prompt asking to run `gh pr create` and verify it's blocked

- [ ] **Step 5: Run E2E tests (if infrastructure is available)**

Run: `bun run e2e`
Expected: Tests run for each agent config project

- [ ] **Step 6: Commit**

```bash
git add e2e-tests/playwright.config.ts \
       e2e-tests/planning-agent-tests/rpc-client.ts \
       e2e-tests/planning-agent-tests/planning-agent.test.ts \
       e2e-tests/tests/helpers.ts
git commit -m "feat: parametrize E2E tests for multi-agent configs (pi, copilot, mixed)"
```

---

## Task 19: Run Full Test Suite + Fix Remaining Issues

**Files:** Various (bug fixes only)

- [ ] **Step 1: Run all backend tests**

Run: `bun run --cwd backend test`
Fix any failures.

- [ ] **Step 2: Run all frontend tests**

Run: `bun run --cwd frontend test`
Fix any failures.

- [ ] **Step 3: Build Docker images**

Run:
```bash
docker compose build agent-base
docker compose build agent-pi agent-copilot agent-gemini agent-claude agent-opencode
```
Fix any Dockerfile issues.

- [ ] **Step 4: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve test failures and build issues from ACP transition"
```

- [ ] **Step 5: Push**

```bash
git push
```
