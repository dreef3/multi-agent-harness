# Web UI + Master Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Node.js backend API (REST + WebSocket) and React frontend that lets a user start a project, brainstorm interactively with the master pi-coding-agent, review and approve a plan, and watch sub-agent execution in real time.

**Architecture:** The master pi-coding-agent runs in-process via the SDK (`createAgentSession`). Backend subscribes to session events and proxies them as WebSocket messages to the frontend. All chat messages are persisted with sequential IDs so the frontend can reconnect and replay missed messages. The React frontend uses Vite + TailwindCSS and communicates via REST and WebSocket.

**Tech Stack:** Express, ws, @mariozechner/pi-coding-agent (SDK), better-sqlite3, React 18, Vite, TailwindCSS, react-markdown

**Prerequisite:** Plan 1 (Foundation) must be complete — db.ts, store layer, containerManager, subAgentBridge, and Docker Compose are all in place.

---

## File Map

| File | Responsibility |
|------|---------------|
| `backend/src/store/db.ts` | Add projects + messages migrations |
| `backend/src/store/projects.ts` | Project CRUD + plan storage |
| `backend/src/store/messages.ts` | Append-only chat message log with seqId |
| `backend/src/agents/masterAgent.ts` | pi SDK session wrapper — creates/resumes sessions, proxies events |
| `backend/src/agents/planParser.ts` | Parses plan markdown into PlanTask[] |
| `backend/src/api/websocket.ts` | WebSocket upgrade handler — chat bridge |
| `backend/src/api/projects.ts` | REST: project CRUD, approve |
| `backend/src/api/repositories.ts` | REST: repository CRUD |
| `backend/src/api/agents.ts` | REST: list sessions, stream logs |
| `backend/src/api/routes.ts` | Add new routes to existing router |
| `backend/src/index.ts` | Add WebSocket server to existing bootstrap |
| `backend/src/__tests__/projects.test.ts` | Project store + plan parser tests |
| `backend/src/__tests__/masterAgent.test.ts` | Master agent tests (mocked pi SDK) |
| `frontend/package.json` | Frontend dependencies |
| `frontend/tsconfig.json` | TypeScript config |
| `frontend/vite.config.ts` | Vite config with proxy to backend |
| `frontend/index.html` | HTML entry point |
| `frontend/tailwind.config.ts` | Tailwind config |
| `frontend/postcss.config.js` | PostCSS for Tailwind |
| `frontend/src/main.tsx` | React entry point |
| `frontend/src/App.tsx` | Router setup |
| `frontend/src/lib/api.ts` | Typed REST client |
| `frontend/src/lib/ws.ts` | WebSocket client with auto-reconnect + seqId replay |
| `frontend/src/pages/Dashboard.tsx` | Active projects list |
| `frontend/src/pages/NewProject.tsx` | Create project (free-form or JIRA) |
| `frontend/src/pages/Chat.tsx` | Streaming master agent chat |
| `frontend/src/pages/PlanApproval.tsx` | Plan viewer with approve/reject |
| `frontend/src/pages/Execution.tsx` | Per-repo agent log tabs |
| `frontend/src/pages/Settings.tsx` | Repository CRUD + env config |
| `frontend/Dockerfile` | nginx serving built React app |
| `frontend/nginx.conf` | Proxy /api and /ws to backend |

---

### Task 1: DB Migrations for Projects + Messages

**Files:**
- Modify: `backend/src/store/db.ts`
- Modify: `backend/src/__tests__/store.test.ts`

- [ ] **Step 1: Add migration test**

Add to the `db` describe block in `backend/src/__tests__/store.test.ts`:

```typescript
it("creates projects and messages tables", () => {
  initDb(tmpDir);
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const names = tables.map((t) => t.name);
  expect(names).toContain("projects");
  expect(names).toContain("messages");
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd backend && npm test -- --reporter=verbose store.test.ts
```

Expected: FAIL — `projects` and `messages` tables missing.

- [ ] **Step 3: Extend `migrate()` in `backend/src/store/db.ts`**

Add to the `database.exec(...)` string inside `migrate()`:

```sql
    CREATE TABLE IF NOT EXISTS projects (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'brainstorming',
      source_type         TEXT NOT NULL,
      source_json         TEXT NOT NULL,
      repository_ids      TEXT NOT NULL DEFAULT '[]',
      plan_json           TEXT,
      master_session_path TEXT NOT NULL DEFAULT '',
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL,
      seq_id      INTEGER NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      UNIQUE(project_id, seq_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_project_seq
      ON messages (project_id, seq_id);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && npm test -- --reporter=verbose store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/store/db.ts backend/src/__tests__/store.test.ts
git commit -m "feat(web-ui): add projects + messages DB migrations"
```

---

### Task 2: Projects Store

**Files:**
- Create: `backend/src/store/projects.ts`
- Create: `backend/src/__tests__/projects.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/projects.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDb } from "../store/db.js";
import {
  insertProject,
  getProject,
  listProjects,
  updateProject,
} from "../store/projects.js";
import type { Project } from "../models/types.js";
import os from "os";
import path from "path";
import fs from "fs";

describe("projects store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-proj-"));
    initDb(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const project: Project = {
    id: "proj-1",
    name: "My Task",
    status: "brainstorming",
    source: { type: "freeform", freeformDescription: "Add caching" },
    repositoryIds: ["repo-1", "repo-2"],
    masterSessionPath: "/data/sessions/proj-1.jsonl",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("inserts and retrieves a project", () => {
    insertProject(project);
    const found = getProject("proj-1");
    expect(found).toMatchObject({
      id: "proj-1",
      name: "My Task",
      status: "brainstorming",
    });
    expect(found?.repositoryIds).toEqual(["repo-1", "repo-2"]);
    expect(found?.source.freeformDescription).toBe("Add caching");
  });

  it("returns null for missing project", () => {
    expect(getProject("missing")).toBeNull();
  });

  it("lists projects ordered by createdAt desc", () => {
    insertProject(project);
    const list = listProjects();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("proj-1");
  });

  it("updates project status", () => {
    insertProject(project);
    updateProject("proj-1", { status: "planning" });
    expect(getProject("proj-1")?.status).toBe("planning");
  });

  it("stores and retrieves a plan", () => {
    insertProject(project);
    const plan = {
      id: "plan-1",
      projectId: "proj-1",
      content: "## Plan\n### Task 1: Do thing\n**Repository:** repo-1\n**Description:**\nDo the thing",
      tasks: [
        {
          id: "task-1",
          repositoryId: "repo-1",
          description: "Do the thing",
          status: "pending" as const,
        },
      ],
      approved: false,
    };
    updateProject("proj-1", { plan, status: "awaiting_approval" });
    const found = getProject("proj-1");
    expect(found?.plan?.tasks).toHaveLength(1);
    expect(found?.plan?.tasks[0].repositoryId).toBe("repo-1");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd backend && npm test -- --reporter=verbose projects.test.ts
```

Expected: FAIL — `Cannot find module '../store/projects.js'`

- [ ] **Step 3: Write `backend/src/store/projects.ts`**

```typescript
import { getDb } from "./db.js";
import type { Project, Plan } from "../models/types.js";

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  source_type: string;
  source_json: string;
  repository_ids: string;
  plan_json: string | null;
  master_session_path: string;
  created_at: string;
  updated_at: string;
}

function fromRow(row: ProjectRow): Project {
  const source = JSON.parse(row.source_json) as Project["source"];
  return {
    id: row.id,
    name: row.name,
    status: row.status as Project["status"],
    source,
    repositoryIds: JSON.parse(row.repository_ids) as string[],
    plan: row.plan_json
      ? (JSON.parse(row.plan_json) as Plan)
      : undefined,
    masterSessionPath: row.master_session_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertProject(project: Project): void {
  getDb()
    .prepare(
      `INSERT INTO projects
         (id, name, status, source_type, source_json, repository_ids,
          plan_json, master_session_path, created_at, updated_at)
       VALUES
         (@id, @name, @status, @sourceType, @sourceJson, @repositoryIds,
          @planJson, @masterSessionPath, @createdAt, @updatedAt)`
    )
    .run({
      id: project.id,
      name: project.name,
      status: project.status,
      sourceType: project.source.type,
      sourceJson: JSON.stringify(project.source),
      repositoryIds: JSON.stringify(project.repositoryIds),
      planJson: project.plan ? JSON.stringify(project.plan) : null,
      masterSessionPath: project.masterSessionPath,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
}

export function getProject(id: string): Project | null {
  const row = getDb()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(id) as ProjectRow | undefined;
  return row ? fromRow(row) : null;
}

export function listProjects(): Project[] {
  const rows = getDb()
    .prepare("SELECT * FROM projects ORDER BY created_at DESC")
    .all() as ProjectRow[];
  return rows.map(fromRow);
}

export function updateProject(
  id: string,
  updates: Partial<Omit<Project, "id">>
): void {
  const existing = getProject(id);
  if (!existing) throw new Error(`Project not found: ${id}`);
  const merged = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  getDb()
    .prepare(
      `UPDATE projects
         SET name=@name, status=@status, source_type=@sourceType,
             source_json=@sourceJson, repository_ids=@repositoryIds,
             plan_json=@planJson, master_session_path=@masterSessionPath,
             updated_at=@updatedAt
       WHERE id=@id`
    )
    .run({
      id: merged.id,
      name: merged.name,
      status: merged.status,
      sourceType: merged.source.type,
      sourceJson: JSON.stringify(merged.source),
      repositoryIds: JSON.stringify(merged.repositoryIds),
      planJson: merged.plan ? JSON.stringify(merged.plan) : null,
      masterSessionPath: merged.masterSessionPath,
      updatedAt: merged.updatedAt,
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && npm test -- --reporter=verbose projects.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/store/projects.ts backend/src/__tests__/projects.test.ts
git commit -m "feat(web-ui): project store CRUD"
```

---

### Task 3: Messages Store

**Files:**
- Create: `backend/src/store/messages.ts`
- Modify: `backend/src/__tests__/projects.test.ts`

- [ ] **Step 1: Add message store tests**

Append to `backend/src/__tests__/projects.test.ts`:

```typescript
import {
  appendMessage,
  listMessages,
  listMessagesSince,
} from "../store/messages.js";

describe("messages store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-msg-"));
    initDb(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends messages with incrementing seqId per project", () => {
    appendMessage("proj-1", "user", "hello");
    appendMessage("proj-1", "assistant", "hi");
    const msgs = listMessages("proj-1");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].seqId).toBe(1);
    expect(msgs[1].seqId).toBe(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("hello");
  });

  it("listMessagesSince returns only messages after the given seqId", () => {
    appendMessage("proj-1", "user", "msg1");
    appendMessage("proj-1", "assistant", "msg2");
    appendMessage("proj-1", "user", "msg3");
    const msgs = listMessagesSince("proj-1", 1);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].seqId).toBe(2);
  });

  it("seqIds are scoped per project", () => {
    appendMessage("proj-1", "user", "hello");
    appendMessage("proj-2", "user", "world");
    expect(listMessages("proj-1")[0].seqId).toBe(1);
    expect(listMessages("proj-2")[0].seqId).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify new tests fail**

```bash
cd backend && npm test -- --reporter=verbose projects.test.ts
```

Expected: FAIL — `Cannot find module '../store/messages.js'`

- [ ] **Step 3: Write `backend/src/store/messages.ts`**

```typescript
import { getDb } from "./db.js";

export interface ChatMessage {
  id: number;
  projectId: string;
  seqId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface MessageRow {
  id: number;
  project_id: string;
  seq_id: number;
  role: string;
  content: string;
  created_at: string;
}

function fromRow(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    projectId: row.project_id,
    seqId: row.seq_id,
    role: row.role as ChatMessage["role"],
    content: row.content,
    createdAt: row.created_at,
  };
}

export function appendMessage(
  projectId: string,
  role: "user" | "assistant",
  content: string
): ChatMessage {
  const db = getDb();
  // Get next seqId for this project
  const maxRow = db
    .prepare(
      "SELECT COALESCE(MAX(seq_id), 0) as max_seq FROM messages WHERE project_id = ?"
    )
    .get(projectId) as { max_seq: number };
  const seqId = maxRow.max_seq + 1;
  const createdAt = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO messages (project_id, seq_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(projectId, seqId, role, content, createdAt);
  return {
    id: info.lastInsertRowid as number,
    projectId,
    seqId,
    role,
    content,
    createdAt,
  };
}

export function listMessages(projectId: string): ChatMessage[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM messages WHERE project_id = ? ORDER BY seq_id ASC"
    )
    .all(projectId) as MessageRow[];
  return rows.map(fromRow);
}

export function listMessagesSince(
  projectId: string,
  afterSeqId: number
): ChatMessage[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM messages WHERE project_id = ? AND seq_id > ? ORDER BY seq_id ASC"
    )
    .all(projectId, afterSeqId) as MessageRow[];
  return rows.map(fromRow);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && npm test -- --reporter=verbose projects.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/store/messages.ts backend/src/__tests__/projects.test.ts
git commit -m "feat(web-ui): messages store (append-only with seqId for reconnect replay)"
```

---

### Task 4: Plan Parser

**Files:**
- Create: `backend/src/agents/planParser.ts`
- Modify: `backend/src/__tests__/projects.test.ts`

- [ ] **Step 1: Add plan parser tests**

Append to `backend/src/__tests__/projects.test.ts`:

```typescript
import { parsePlan } from "../agents/planParser.js";

describe("parsePlan", () => {
  it("extracts tasks from plan markdown", () => {
    const markdown = `
## Implementation Plan

### Task 1: Add caching layer

**Repository:** my-service
**Description:**
Add Redis caching to the service. Configure TTL.

### Task 2: Update config

**Repository:** config-repo
**Description:**
Add Redis connection string to config.
    `.trim();

    const tasks = parsePlan("proj-1", markdown, [
      { id: "repo-1", name: "my-service" } as never,
      { id: "repo-2", name: "config-repo" } as never,
    ]);

    expect(tasks).toHaveLength(2);
    expect(tasks[0].repositoryId).toBe("repo-1");
    expect(tasks[0].description).toContain("Redis caching");
    expect(tasks[1].repositoryId).toBe("repo-2");
    expect(tasks[1].description).toContain("Redis connection string");
  });

  it("returns empty array when no tasks match", () => {
    const tasks = parsePlan("proj-1", "No structured tasks here", [
      { id: "repo-1", name: "my-service" } as never,
    ]);
    expect(tasks).toHaveLength(0);
  });

  it("skips tasks whose repository name does not match any configured repo", () => {
    const markdown = `
### Task 1: Do thing

**Repository:** unknown-repo
**Description:**
Do the thing.
    `.trim();
    const tasks = parsePlan("proj-1", markdown, [
      { id: "repo-1", name: "my-service" } as never,
    ]);
    expect(tasks).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify new tests fail**

```bash
cd backend && npm test -- --reporter=verbose projects.test.ts
```

Expected: FAIL — `Cannot find module '../agents/planParser.js'`

- [ ] **Step 3: Write `backend/src/agents/planParser.ts`**

```typescript
import { randomUUID } from "crypto";
import type { PlanTask, Repository } from "../models/types.js";

/**
 * Parses the master agent's plan markdown into structured PlanTask objects.
 *
 * Convention the master agent must follow:
 *   ### Task N: <title>
 *   **Repository:** <repo-name>
 *   **Description:**
 *   <free text describing the task>
 *
 * Tasks whose **Repository:** name does not match any configured repository
 * are silently dropped. The UI will warn if the resulting task list is empty.
 */
export function parsePlan(
  projectId: string,
  markdown: string,
  repositories: Pick<Repository, "id" | "name">[]
): PlanTask[] {
  const repoByName = new Map(repositories.map((r) => [r.name.toLowerCase(), r.id]));
  const tasks: PlanTask[] = [];

  // Match ### Task N: title blocks
  const taskBlockRegex =
    /^###\s+Task\s+\d+:\s+.+?\n([\s\S]*?)(?=^###\s+Task\s+\d+:|$)/gm;

  for (const match of markdown.matchAll(taskBlockRegex)) {
    const block = match[0];

    const repoMatch = /\*\*Repository:\*\*\s+(.+)/i.exec(block);
    const descMatch = /\*\*Description:\*\*\s*\n([\s\S]+?)(?=\n\*\*|\n###|$)/i.exec(block);

    if (!repoMatch) continue;

    const repoName = repoMatch[1].trim();
    const repositoryId = repoByName.get(repoName.toLowerCase());
    if (!repositoryId) continue;

    const description = descMatch ? descMatch[1].trim() : block.trim();

    tasks.push({
      id: randomUUID(),
      repositoryId,
      description,
      status: "pending",
    });
  }

  return tasks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && npm test -- --reporter=verbose projects.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agents/planParser.ts backend/src/__tests__/projects.test.ts
git commit -m "feat(web-ui): plan markdown parser"
```

---

### Task 5: Master Agent Module

**Files:**
- Create: `backend/src/agents/masterAgent.ts`
- Create: `backend/src/__tests__/masterAgent.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/masterAgent.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the pi-coding-agent module before importing masterAgent
vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  SessionManager: {
    file: vi.fn().mockReturnValue("file-session-manager"),
  },
}));

import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { MasterAgent } from "../agents/masterAgent.js";

const mockCreateAgentSession = vi.mocked(createAgentSession);

function makeMockSession() {
  const listeners: ((event: unknown) => void)[] = [];
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn((cb: (event: unknown) => void) => {
      listeners.push(cb);
      return () => {};
    }),
    _emit: (event: unknown) => listeners.forEach((l) => l(event)),
  };
}

describe("MasterAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a pi session on init", async () => {
    const mockSession = makeMockSession();
    mockCreateAgentSession.mockResolvedValue({ session: mockSession } as never);

    const agent = new MasterAgent("proj-1", "/sessions/proj-1.jsonl");
    await agent.init();

    expect(mockCreateAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionManager: expect.anything(),
      })
    );
  });

  it("forwards user prompt to pi session", async () => {
    const mockSession = makeMockSession();
    mockCreateAgentSession.mockResolvedValue({ session: mockSession } as never);

    const agent = new MasterAgent("proj-1", "/sessions/proj-1.jsonl");
    await agent.init();
    await agent.prompt("hello");

    expect(mockSession.prompt).toHaveBeenCalledWith("hello");
  });

  it("emits text_delta events from pi session", async () => {
    const mockSession = makeMockSession();
    mockCreateAgentSession.mockResolvedValue({ session: mockSession } as never);

    const agent = new MasterAgent("proj-1", "/sessions/proj-1.jsonl");
    await agent.init();

    const deltas: string[] = [];
    agent.on("delta", (text: string) => deltas.push(text));

    mockSession._emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello " },
    });
    mockSession._emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "world" },
    });

    expect(deltas).toEqual(["hello ", "world"]);
  });

  it("emits message_complete when assistant message stops", async () => {
    const mockSession = makeMockSession();
    mockCreateAgentSession.mockResolvedValue({ session: mockSession } as never);

    const agent = new MasterAgent("proj-1", "/sessions/proj-1.jsonl");
    await agent.init();

    let completed = false;
    agent.on("message_complete", () => (completed = true));

    mockSession._emit({
      type: "message_update",
      assistantMessageEvent: { type: "message_stop" },
    });

    expect(completed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd backend && npm test -- --reporter=verbose masterAgent.test.ts
```

Expected: FAIL — `Cannot find module '../agents/masterAgent.js'`

- [ ] **Step 3: Write `backend/src/agents/masterAgent.ts`**

```typescript
import { EventEmitter } from "events";
import {
  createAgentSession,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import path from "path";

interface PiEvent {
  type: string;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
  };
}

/**
 * Wraps a pi-coding-agent SDK session for a single project's master agent.
 *
 * Events:
 *   "delta"            — string text delta from the assistant
 *   "message_complete" — assistant message finished streaming
 *   "error"            — session error
 */
export class MasterAgent extends EventEmitter {
  private session: Awaited<
    ReturnType<typeof createAgentSession>
  >["session"] | null = null;

  constructor(
    private readonly projectId: string,
    private readonly sessionFilePath: string
  ) {
    super();
  }

  async init(): Promise<void> {
    const sessionDir = path.dirname(this.sessionFilePath);
    const { session } = await createAgentSession({
      sessionManager: SessionManager.file(sessionDir),
    });

    session.subscribe((event: unknown) => {
      const e = event as PiEvent;
      if (
        e.type === "message_update" &&
        e.assistantMessageEvent?.type === "text_delta" &&
        e.assistantMessageEvent.delta
      ) {
        this.emit("delta", e.assistantMessageEvent.delta);
      }
      if (
        e.type === "message_update" &&
        e.assistantMessageEvent?.type === "message_stop"
      ) {
        this.emit("message_complete");
      }
    });

    this.session = session;
  }

  async prompt(text: string): Promise<void> {
    if (!this.session) throw new Error("MasterAgent not initialized");
    await this.session.prompt(text);
  }

  async steer(text: string): Promise<void> {
    if (!this.session) throw new Error("MasterAgent not initialized");
    await this.session.steer(text);
  }

  dispose(): void {
    this.session?.dispose();
    this.session = null;
  }
}
```

- [ ] **Step 4: Install pi-coding-agent**

```bash
cd backend && npm install @mariozechner/pi-coding-agent
```

Expected: package installed. Verify `node_modules/@mariozechner/pi-coding-agent` exists.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd backend && npm test -- --reporter=verbose masterAgent.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/agents/masterAgent.ts backend/src/__tests__/masterAgent.test.ts backend/package.json backend/package-lock.json
git commit -m "feat(web-ui): master agent module (pi SDK wrapper)"
```

---

### Task 6: WebSocket Server + Chat Bridge

**Files:**
- Create: `backend/src/api/websocket.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Install `ws` dependency**

```bash
cd backend && npm install ws && npm install --save-dev @types/ws
```

Expected: `ws` and `@types/ws` appear in `package.json`.

- [ ] **Step 2: Write `backend/src/api/websocket.ts`**

```typescript
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage, Server } from "http";
import { randomUUID } from "crypto";
import { MasterAgent } from "../agents/masterAgent.js";
import { getProject, updateProject } from "../store/projects.js";
import { appendMessage, listMessagesSince } from "../store/messages.js";
import { parsePlan } from "../agents/planParser.js";
import { listRepositories } from "../store/repositories.js";
import path from "path";
import fs from "fs";

// Map projectId → MasterAgent (one per project, reused across connections)
const agentSessions = new Map<string, MasterAgent>();

interface WsClientMessage {
  type: "prompt" | "steer" | "resume";
  text?: string;
  lastSeqId?: number;
}

interface WsServerMessage {
  type: "delta" | "message_complete" | "replay" | "error" | "plan_ready";
  [key: string]: unknown;
}

function send(ws: WebSocket, msg: WsServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function setupWebSocket(server: Server, dataDir: string): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    // Extract projectId from URL: /ws/projects/:id/chat
    const match = /\/ws\/projects\/([^/]+)\/chat/.exec(req.url ?? "");
    if (!match) {
      ws.close(4000, "Invalid URL");
      return;
    }
    const projectId = match[1];

    const project = getProject(projectId);
    if (!project) {
      ws.close(4004, "Project not found");
      return;
    }

    // Get or create master agent for this project
    let agent = agentSessions.get(projectId);
    if (!agent) {
      const sessionDir = path.join(dataDir, "sessions", projectId);
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionPath = path.join(sessionDir, "master.jsonl");
      agent = new MasterAgent(projectId, sessionPath);
      await agent.init();
      agentSessions.set(projectId, agent);
    }

    // Wire per-connection forwarding — must happen for every connection,
    // not just on first create, so reconnects receive live streaming too.
    const onDeltaFwd = (text: string) => send(ws, { type: "delta", text });
    const onCompleteFwd = () => send(ws, { type: "message_complete" });
    const onErrorFwd = (err: Error) => send(ws, { type: "error", message: err.message });
    agent.on("delta", onDeltaFwd);
    agent.on("message_complete", onCompleteFwd);
    agent.on("error", onErrorFwd);

    // Clean up forwarding listeners when this connection closes
    ws.on("close", () => {
      agent!.off("delta", onDeltaFwd);
      agent!.off("message_complete", onCompleteFwd);
      agent!.off("error", onErrorFwd);
    });

    ws.on("message", async (raw: Buffer) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as WsClientMessage;
      } catch {
        send(ws, { type: "error", message: "Invalid JSON" });
        return;
      }

      if (msg.type === "resume" && msg.lastSeqId !== undefined) {
        // Replay messages the client missed
        const missed = listMessagesSince(projectId, msg.lastSeqId);
        send(ws, { type: "replay", messages: missed });
        return;
      }

      if (msg.type === "prompt" && msg.text) {
        appendMessage(projectId, "user", msg.text);
        // Collect full assistant response for persistence
        let fullResponse = "";
        const onDelta = (text: string) => (fullResponse += text);
        agent!.on("delta", onDelta);
        try {
          await agent!.prompt(msg.text);
          agent!.off("delta", onDelta);
          if (fullResponse) {
            const saved = appendMessage(projectId, "assistant", fullResponse);
            // Check if this looks like a completed plan
            if (
              fullResponse.includes("### Task") &&
              fullResponse.includes("**Repository:**")
            ) {
              const repos = listRepositories();
              const tasks = parsePlan(projectId, fullResponse, repos);
              if (tasks.length > 0) {
                const plan = {
                  id: randomUUID(),
                  projectId,
                  content: fullResponse,
                  tasks,
                  approved: false,
                };
                updateProject(projectId, { plan, status: "awaiting_approval" });
                send(ws, { type: "plan_ready", plan });
              }
            }
          }
        } catch (err) {
          agent!.off("delta", onDelta);
          send(ws, {
            type: "error",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
        return;
      }

      if (msg.type === "steer" && msg.text) {
        await agent!.steer(msg.text);
        return;
      }
    });

    ws.on("close", () => {
      // Keep agent alive for reconnect — do not dispose here
    });
  });
}
```

- [ ] **Step 2: Modify `backend/src/index.ts` to add WebSocket**

Add `import { createServer } from "http"` and `import { setupWebSocket } from "./api/websocket.js"`.

Replace the `app.listen(...)` block with:

```typescript
  const server = createServer(app);
  setupWebSocket(server, config.dataDir);
  server.listen(config.port, () => {
    console.log(`[startup] Backend listening on port ${config.port}`);
  });
```

Full updated `backend/src/index.ts`:

```typescript
import express from "express";
import { createServer } from "http";
import Dockerode from "dockerode";
import { config } from "./config.js";
import { initDb } from "./store/db.js";
import { ensureSubAgentImage } from "./orchestrator/imageBuilder.js";
import { createRouter } from "./api/routes.js";
import { setupWebSocket } from "./api/websocket.js";

async function main() {
  console.log("[startup] Initializing database...");
  initDb(config.dataDir);

  console.log("[startup] Connecting to Docker proxy...");
  const dockerUrl = new URL(config.dockerProxyUrl);
  const docker = new Dockerode({
    host: dockerUrl.hostname,
    port: parseInt(dockerUrl.port, 10),
  });

  console.log("[startup] Ensuring sub-agent image exists...");
  try {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const subAgentPath = require
      .resolve("../../sub-agent/Dockerfile")
      .replace("/Dockerfile", "");
    await ensureSubAgentImage(docker, config.subAgentImage, subAgentPath);
  } catch (err) {
    console.error("[startup] Failed to ensure sub-agent image:", err);
    process.exit(1);
  }

  const app = express();
  app.use(express.json());
  app.use("/api", createRouter());

  const server = createServer(app);
  setupWebSocket(server, config.dataDir);
  server.listen(config.port, () => {
    console.log(`[startup] Backend listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/api/websocket.ts backend/src/index.ts
git commit -m "feat(web-ui): WebSocket chat bridge with seqId replay"
```

---

### Task 7: REST API Routes

**Files:**
- Create: `backend/src/api/projects.ts`
- Create: `backend/src/api/repositories.ts`
- Create: `backend/src/api/agents.ts`
- Modify: `backend/src/api/routes.ts`

- [ ] **Step 1: Write `backend/src/api/projects.ts`**

```typescript
import { Router } from "express";
import { randomUUID } from "crypto";
import { insertProject, getProject, listProjects, updateProject } from "../store/projects.js";
import { listAgentSessions } from "../store/agents.js";
import path from "path";

export function projectsRouter(dataDir: string): Router {
  const router = Router();

  // List all projects
  router.get("/", (_req, res) => {
    res.json(listProjects());
  });

  // Get single project
  router.get("/:id", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Not found" });
    return res.json(project);
  });

  // Create project
  router.post("/", (req, res) => {
    const { name, source, repositoryIds } = req.body as {
      name: string;
      source: { type: string; jiraTickets?: string[]; freeformDescription?: string };
      repositoryIds: string[];
    };
    const id = randomUUID();
    const now = new Date().toISOString();
    const sessionDir = path.join(dataDir, "sessions", id);
    const project = {
      id,
      name,
      status: "brainstorming" as const,
      source: source as never,
      repositoryIds,
      masterSessionPath: path.join(sessionDir, "master.jsonl"),
      createdAt: now,
      updatedAt: now,
    };
    insertProject(project);
    res.status(201).json(project);
  });

  // Approve plan — triggers execution (execution handled in Plan 1's taskDispatcher, wired in Plan 3)
  router.post("/:id/approve", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Not found" });
    if (!project.plan) return res.status(400).json({ error: "No plan to approve" });

    const approvedPlan = {
      ...project.plan,
      approved: true,
      approvedAt: new Date().toISOString(),
    };
    updateProject(req.params.id, {
      plan: approvedPlan,
      status: "executing",
    });

    // TODO(plan-3): wire taskDispatcher here to spawn sub-agents
    return res.json({ ok: true, projectId: req.params.id });
  });

  // Cancel project
  router.post("/:id/cancel", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Not found" });
    updateProject(req.params.id, { status: "cancelled" });
    return res.json({ ok: true });
  });

  // Get agent sessions for a project
  router.get("/:id/agents", (req, res) => {
    res.json(listAgentSessions(req.params.id));
  });

  return router;
}
```

- [ ] **Step 2: Write `backend/src/api/repositories.ts`**

```typescript
import { Router } from "express";
import { randomUUID } from "crypto";
import {
  insertRepository,
  getRepository,
  listRepositories,
  updateRepository,
  deleteRepository,
} from "../store/repositories.js";
import type { Repository } from "../models/types.js";

export function repositoriesRouter(): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(listRepositories());
  });

  router.get("/:id", (req, res) => {
    const repo = getRepository(req.params.id);
    if (!repo) return res.status(404).json({ error: "Not found" });
    return res.json(repo);
  });

  router.post("/", (req, res) => {
    const body = req.body as Omit<Repository, "id" | "createdAt" | "updatedAt">;
    const now = new Date().toISOString();
    const repo: Repository = {
      id: randomUUID(),
      ...body,
      createdAt: now,
      updatedAt: now,
    };
    insertRepository(repo);
    res.status(201).json(repo);
  });

  router.put("/:id", (req, res) => {
    try {
      updateRepository(req.params.id, req.body as Partial<Repository>);
      return res.json(getRepository(req.params.id));
    } catch {
      return res.status(404).json({ error: "Not found" });
    }
  });

  router.delete("/:id", (req, res) => {
    deleteRepository(req.params.id);
    return res.status(204).send();
  });

  return router;
}
```

- [ ] **Step 3: Write `backend/src/api/agents.ts`**

```typescript
import { Router } from "express";
import { listAgentSessions, getAgentSession } from "../store/agents.js";

export function agentsRouter(): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    // List all agent sessions (flattened — used by dashboard)
    res.json([]);
  });

  router.get("/:id", (req, res) => {
    const session = getAgentSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });
    return res.json(session);
  });

  return router;
}
```

- [ ] **Step 4: Update `backend/src/api/routes.ts`**

```typescript
import { Router } from "express";
import { projectsRouter } from "./projects.js";
import { repositoriesRouter } from "./repositories.js";
import { agentsRouter } from "./agents.js";

export function createRouter(dataDir: string): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  router.use("/projects", projectsRouter(dataDir));
  router.use("/repositories", repositoriesRouter());
  router.use("/agents", agentsRouter());

  return router;
}
```

- [ ] **Step 5: Update `backend/src/index.ts` to pass dataDir to createRouter**

Change:
```typescript
app.use("/api", createRouter());
```
To:
```typescript
app.use("/api", createRouter(config.dataDir));
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/api/projects.ts backend/src/api/repositories.ts backend/src/api/agents.ts backend/src/api/routes.ts backend/src/index.ts
git commit -m "feat(web-ui): REST API routes (projects, repositories, agents)"
```

---

### Task 8: Frontend Scaffold

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tailwind.config.ts`
- Create: `frontend/postcss.config.js`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`

- [ ] **Step 1: Create `frontend/package.json`**

```json
{
  "name": "@multi-agent-harness/frontend",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.21.0",
    "react-markdown": "^9.0.1"
  },
  "devDependencies": {
    "@types/react": "^18.2.48",
    "@types/react-dom": "^18.2.18",
    "@vitejs/plugin-react": "^4.2.1",
    "autoprefixer": "^10.4.17",
    "postcss": "^8.4.33",
    "tailwindcss": "^3.4.1",
    "typescript": "^5.3.3",
    "vite": "^5.0.11"
  }
}
```

- [ ] **Step 2: Install frontend dependencies**

```bash
cd frontend && npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Create `frontend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `frontend/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
});
```

- [ ] **Step 5: Create `frontend/tailwind.config.ts`**

```typescript
import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 6: Create `frontend/postcss.config.js`**

```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 7: Create `frontend/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Multi-Agent Harness</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 8: Create `frontend/src/main.tsx`**

```typescript
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.js";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
```

- [ ] **Step 9: Create `frontend/src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 10: Create `frontend/src/App.tsx`**

```typescript
import { Routes, Route, Link } from "react-router-dom";
import Dashboard from "./pages/Dashboard.js";
import NewProject from "./pages/NewProject.js";
import Chat from "./pages/Chat.js";
import PlanApproval from "./pages/PlanApproval.js";
import Execution from "./pages/Execution.js";
import Settings from "./pages/Settings.js";

export default function App() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <nav className="border-b border-gray-800 px-6 py-3 flex gap-6">
        <Link className="font-semibold text-blue-400" to="/">
          Multi-Agent Harness
        </Link>
        <Link className="text-gray-400 hover:text-white" to="/projects/new">
          + New Project
        </Link>
        <Link className="text-gray-400 hover:text-white" to="/settings">
          Settings
        </Link>
      </nav>
      <main className="p-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/projects/new" element={<NewProject />} />
          <Route path="/projects/:id/chat" element={<Chat />} />
          <Route path="/projects/:id/plan" element={<PlanApproval />} />
          <Route path="/projects/:id/execute" element={<Execution />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
```

- [ ] **Step 11: Verify frontend builds**

```bash
cd frontend && npm run build
```

Expected: `dist/` created. Ignore "pages not found" errors — stubs come next.

- [ ] **Step 12: Commit**

```bash
git add frontend/
git commit -m "feat(web-ui): React + Vite + TailwindCSS frontend scaffold"
```

---

### Task 9: WebSocket Client Lib + REST Client

**Files:**
- Create: `frontend/src/lib/api.ts`
- Create: `frontend/src/lib/ws.ts`

- [ ] **Step 1: Write `frontend/src/lib/api.ts`**

```typescript
// Typed REST client for the backend API

export interface Project {
  id: string;
  name: string;
  status: string;
  source: {
    type: string;
    jiraTickets?: string[];
    freeformDescription?: string;
  };
  repositoryIds: string[];
  plan?: {
    id: string;
    content: string;
    tasks: Array<{
      id: string;
      repositoryId: string;
      description: string;
      status: string;
    }>;
    approved: boolean;
  };
  masterSessionPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repository {
  id: string;
  name: string;
  cloneUrl: string;
  provider: "github" | "bitbucket-server";
  providerConfig: Record<string, string | undefined>;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  projects: {
    list: () => request<Project[]>("/projects"),
    get: (id: string) => request<Project>(`/projects/${id}`),
    create: (body: {
      name: string;
      source: Project["source"];
      repositoryIds: string[];
    }) =>
      request<Project>("/projects", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    approve: (id: string) =>
      request<{ ok: boolean }>(`/projects/${id}/approve`, {
        method: "POST",
      }),
    cancel: (id: string) =>
      request<{ ok: boolean }>(`/projects/${id}/cancel`, {
        method: "POST",
      }),
    agents: (id: string) => request<unknown[]>(`/projects/${id}/agents`),
  },
  repositories: {
    list: () => request<Repository[]>("/repositories"),
    create: (body: Omit<Repository, "id" | "createdAt" | "updatedAt">) =>
      request<Repository>("/repositories", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    update: (id: string, body: Partial<Repository>) =>
      request<Repository>(`/repositories/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    delete: (id: string) =>
      request<void>(`/repositories/${id}`, { method: "DELETE" }),
  },
  health: () => request<{ status: string }>("/health"),
};
```

- [ ] **Step 2: Write `frontend/src/lib/ws.ts`**

```typescript
// WebSocket client with auto-reconnect and seqId-based replay

export type WsMessage =
  | { type: "delta"; text: string }
  | { type: "message_complete" }
  | { type: "replay"; messages: Array<{ seqId: number; role: string; content: string }> }
  | { type: "plan_ready"; plan: unknown }
  | { type: "error"; message: string };

export class ChatSocket {
  private ws: WebSocket | null = null;
  private lastSeqId = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private projectId: string,
    private onMessage: (msg: WsMessage) => void
  ) {}

  connect(): void {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${location.host}/ws/projects/${this.projectId}/chat`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      // Request replay of any missed messages
      this.ws!.send(
        JSON.stringify({ type: "resume", lastSeqId: this.lastSeqId })
      );
    };

    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as WsMessage;
      if (msg.type === "replay") {
        // Update lastSeqId from replayed messages
        for (const m of msg.messages) {
          if (m.seqId > this.lastSeqId) this.lastSeqId = m.seqId;
        }
      }
      this.onMessage(msg);
    };

    this.ws.onclose = () => {
      if (!this.closed) {
        // Auto-reconnect after 2s
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  send(type: "prompt" | "steer", text: string): void {
    this.ws?.send(JSON.stringify({ type, text }));
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/ws.ts
git commit -m "feat(web-ui): typed REST client + WebSocket client with reconnect"
```

---

### Task 10: Frontend Pages

**Files:**
- Create: `frontend/src/pages/Dashboard.tsx`
- Create: `frontend/src/pages/NewProject.tsx`
- Create: `frontend/src/pages/Chat.tsx`
- Create: `frontend/src/pages/PlanApproval.tsx`
- Create: `frontend/src/pages/Execution.tsx`
- Create: `frontend/src/pages/Settings.tsx`

- [ ] **Step 1: Write `frontend/src/pages/Dashboard.tsx`**

```typescript
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Project } from "../lib/api.js";

const STATUS_COLORS: Record<string, string> = {
  brainstorming: "bg-purple-800 text-purple-200",
  planning: "bg-blue-800 text-blue-200",
  awaiting_approval: "bg-yellow-800 text-yellow-200",
  executing: "bg-green-800 text-green-200",
  completed: "bg-gray-700 text-gray-300",
  failed: "bg-red-800 text-red-200",
  cancelled: "bg-gray-700 text-gray-400",
};

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.projects.list().then(setProjects).finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-gray-400">Loading...</p>;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Projects</h1>
        <Link
          to="/projects/new"
          className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded text-sm font-medium"
        >
          + New Project
        </Link>
      </div>
      {projects.length === 0 ? (
        <p className="text-gray-500">No projects yet. Create one to get started.</p>
      ) : (
        <div className="space-y-3">
          {projects.map((p) => (
            <div
              key={p.id}
              className="border border-gray-800 rounded-lg p-4 flex justify-between items-center"
            >
              <div>
                <p className="font-medium">{p.name}</p>
                <p className="text-sm text-gray-400">
                  {new Date(p.createdAt).toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <span
                  className={`text-xs px-2 py-1 rounded ${STATUS_COLORS[p.status] ?? "bg-gray-700"}`}
                >
                  {p.status}
                </span>
                <Link
                  to={`/projects/${p.id}/chat`}
                  className="text-blue-400 hover:text-blue-300 text-sm"
                >
                  Open →
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write `frontend/src/pages/NewProject.tsx`**

```typescript
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Repository } from "../lib/api.js";

export default function NewProject() {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<Repository[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.repositories.list().then(setRepos);
  }, []);

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const project = await api.projects.create({
        name: name.trim(),
        source: { type: "freeform", freeformDescription: description },
        repositoryIds: selectedRepos,
      });
      navigate(`/projects/${project.id}/chat`);
    } finally {
      setCreating(false);
    }
  }

  function toggleRepo(id: string) {
    setSelectedRepos((prev) =>
      prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]
    );
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">New Project</h1>
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-gray-400 mb-1">Project Name</label>
          <input
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Add Redis caching"
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Description</label>
          <textarea
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white h-28 resize-none"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe what you want to build..."
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-2">
            Repositories (select all that apply)
          </label>
          {repos.length === 0 ? (
            <p className="text-gray-500 text-sm">
              No repositories configured. <a href="/settings" className="text-blue-400">Add one in Settings →</a>
            </p>
          ) : (
            <div className="space-y-2">
              {repos.map((r) => (
                <label key={r.id} className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedRepos.includes(r.id)}
                    onChange={() => toggleRepo(r.id)}
                    className="w-4 h-4"
                  />
                  <span>{r.name}</span>
                  <span className="text-gray-500 text-sm">{r.cloneUrl}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={handleCreate}
          disabled={creating || !name.trim()}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-6 py-2 rounded font-medium"
        >
          {creating ? "Creating..." : "Start Project"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write `frontend/src/pages/Chat.tsx`**

```typescript
import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Markdown from "react-markdown";
import { ChatSocket, type WsMessage } from "../lib/ws.js";
import { api, type Project } from "../lib/api.js";

interface Message {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
}

export default function Chat() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [project, setProject] = useState<Project | null>(null);
  const [planReady, setPlanReady] = useState(false);
  const socketRef = useRef<ChatSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return;

    api.projects.get(id).then(setProject);

    const socket = new ChatSocket(id, handleMessage);
    socketRef.current = socket;
    socket.connect();

    return () => socket.disconnect();
  }, [id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleMessage(msg: WsMessage) {
    if (msg.type === "delta") {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.isStreaming) {
          return [
            ...prev.slice(0, -1),
            { ...last, content: last.content + msg.text },
          ];
        }
        return [
          ...prev,
          { role: "assistant", content: msg.text, isStreaming: true },
        ];
      });
    }
    if (msg.type === "message_complete") {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.isStreaming) {
          return [...prev.slice(0, -1), { ...last, isStreaming: false }];
        }
        return prev;
      });
    }
    if (msg.type === "replay") {
      setMessages(
        msg.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }))
      );
    }
    if (msg.type === "plan_ready") {
      setPlanReady(true);
    }
  }

  function send() {
    if (!input.trim()) return;
    setMessages((prev) => [
      ...prev,
      { role: "user", content: input.trim() },
    ]);
    socketRef.current?.send("prompt", input.trim());
    setInput("");
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-xl font-bold">{project?.name ?? "Chat"}</h1>
        {planReady && (
          <button
            onClick={() => navigate(`/projects/${id}/plan`)}
            className="bg-green-700 hover:bg-green-600 px-4 py-2 rounded text-sm font-medium"
          >
            View Plan →
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto space-y-4 mb-4">
        {messages.map((msg, i) => (
          <div key={i} className={msg.role === "user" ? "text-right" : ""}>
            <div
              className={`inline-block max-w-3xl text-left px-4 py-3 rounded-lg text-sm ${
                msg.role === "user"
                  ? "bg-blue-800 text-white"
                  : "bg-gray-800 text-gray-100"
              }`}
            >
              <Markdown>{msg.content}</Markdown>
              {msg.isStreaming && (
                <span className="inline-block w-2 h-4 bg-gray-400 animate-pulse ml-1" />
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="flex gap-2">
        <input
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
          placeholder="Ask the agent to brainstorm or write a plan..."
        />
        <button
          onClick={send}
          className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-medium"
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write `frontend/src/pages/PlanApproval.tsx`**

```typescript
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Markdown from "react-markdown";
import { api, type Project } from "../lib/api.js";

export default function PlanApproval() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    if (id) api.projects.get(id).then(setProject);
  }, [id]);

  async function handleApprove() {
    if (!id) return;
    setApproving(true);
    try {
      await api.projects.approve(id);
      navigate(`/projects/${id}/execute`);
    } finally {
      setApproving(false);
    }
  }

  if (!project) return <p className="text-gray-400">Loading...</p>;
  if (!project.plan)
    return (
      <div>
        <p className="text-gray-400 mb-4">No plan available yet.</p>
        <button
          onClick={() => navigate(`/projects/${id}/chat`)}
          className="text-blue-400 hover:text-blue-300"
        >
          ← Back to Chat
        </button>
      </div>
    );

  return (
    <div className="max-w-4xl">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Review Plan: {project.name}</h1>
        <div className="flex gap-3">
          <button
            onClick={() => navigate(`/projects/${id}/chat`)}
            className="border border-gray-700 px-4 py-2 rounded text-sm"
          >
            ← Revise in Chat
          </button>
          <button
            onClick={handleApprove}
            disabled={approving}
            className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-2 rounded font-medium"
          >
            {approving ? "Starting..." : "Approve & Execute"}
          </button>
        </div>
      </div>

      <div className="mb-6">
        <h2 className="text-lg font-semibold mb-3">Tasks ({project.plan.tasks.length})</h2>
        <div className="space-y-2">
          {project.plan.tasks.map((task) => (
            <div
              key={task.id}
              className="border border-gray-800 rounded p-3 flex justify-between"
            >
              <span className="text-sm">{task.description.slice(0, 80)}...</span>
              <span className="text-xs text-gray-500 ml-4">{task.repositoryId}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="prose prose-invert max-w-none">
        <Markdown>{project.plan.content}</Markdown>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Write `frontend/src/pages/Execution.tsx`**

```typescript
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api.js";

interface AgentSession {
  id: string;
  repositoryId?: string;
  status: string;
  type: string;
}

export default function Execution() {
  const { id } = useParams<{ id: string }>();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const interval = setInterval(() => {
      api.projects
        .agents(id)
        .then((s) => setSessions(s as AgentSession[]))
        .catch(() => {});
    }, 2000);
    return () => clearInterval(interval);
  }, [id]);

  const subAgents = sessions.filter((s) => s.type === "sub");

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Execution</h1>
      {subAgents.length === 0 ? (
        <p className="text-gray-400">No sub-agents running yet.</p>
      ) : (
        <div>
          <div className="flex gap-2 mb-4 border-b border-gray-800 pb-2">
            {subAgents.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveTab(s.id)}
                className={`px-3 py-1 rounded-t text-sm ${
                  activeTab === s.id
                    ? "bg-gray-800 text-white"
                    : "text-gray-500 hover:text-gray-300"
                }`}
              >
                {s.repositoryId ?? s.id.slice(0, 8)}
                <span
                  className={`ml-2 text-xs ${
                    s.status === "running"
                      ? "text-green-400"
                      : s.status === "failed"
                        ? "text-red-400"
                        : "text-gray-500"
                  }`}
                >
                  {s.status}
                </span>
              </button>
            ))}
          </div>
          {activeTab && (
            <div className="bg-gray-900 rounded p-4 font-mono text-sm text-gray-300 h-96 overflow-y-auto">
              {/* Log streaming via WebSocket goes here — wired in Plan 3 */}
              <p className="text-gray-500">Agent {activeTab} — logs stream here</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Write `frontend/src/pages/Settings.tsx`**

```typescript
import { useEffect, useState } from "react";
import { api, type Repository } from "../lib/api.js";

type ProviderType = "github" | "bitbucket-server";

export default function Settings() {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    cloneUrl: "",
    provider: "github" as ProviderType,
    owner: "",
    repo: "",
    projectKey: "",
    repoSlug: "",
    baseUrl: "",
    defaultBranch: "main",
  });

  useEffect(() => {
    api.repositories.list().then(setRepos);
  }, []);

  async function handleAdd() {
    const providerConfig =
      form.provider === "github"
        ? { owner: form.owner, repo: form.repo }
        : {
            projectKey: form.projectKey,
            repoSlug: form.repoSlug,
            baseUrl: form.baseUrl,
          };
    await api.repositories.create({
      name: form.name,
      cloneUrl: form.cloneUrl,
      provider: form.provider,
      providerConfig,
      defaultBranch: form.defaultBranch,
    });
    setShowForm(false);
    api.repositories.list().then(setRepos);
  }

  async function handleDelete(id: string) {
    await api.repositories.delete(id);
    api.repositories.list().then(setRepos);
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

      <div className="mb-6">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-lg font-semibold">Repositories</h2>
          <button
            onClick={() => setShowForm(!showForm)}
            className="bg-blue-600 hover:bg-blue-500 px-3 py-1 rounded text-sm"
          >
            + Add Repository
          </button>
        </div>

        {showForm && (
          <div className="border border-gray-700 rounded p-4 mb-4 space-y-3">
            <input
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2"
              placeholder="Name (e.g. my-service)"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <input
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2"
              placeholder="Clone URL"
              value={form.cloneUrl}
              onChange={(e) => setForm({ ...form, cloneUrl: e.target.value })}
            />
            <select
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2"
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value as ProviderType })}
            >
              <option value="github">GitHub</option>
              <option value="bitbucket-server">Bitbucket Server</option>
            </select>
            {form.provider === "github" ? (
              <>
                <input
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2"
                  placeholder="Owner (org or user)"
                  value={form.owner}
                  onChange={(e) => setForm({ ...form, owner: e.target.value })}
                />
                <input
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2"
                  placeholder="Repo name"
                  value={form.repo}
                  onChange={(e) => setForm({ ...form, repo: e.target.value })}
                />
              </>
            ) : (
              <>
                <input
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2"
                  placeholder="Bitbucket Base URL"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                />
                <input
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2"
                  placeholder="Project Key"
                  value={form.projectKey}
                  onChange={(e) => setForm({ ...form, projectKey: e.target.value })}
                />
                <input
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2"
                  placeholder="Repo Slug"
                  value={form.repoSlug}
                  onChange={(e) => setForm({ ...form, repoSlug: e.target.value })}
                />
              </>
            )}
            <input
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2"
              placeholder="Default branch (e.g. main)"
              value={form.defaultBranch}
              onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })}
            />
            <button
              onClick={handleAdd}
              className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded text-sm font-medium"
            >
              Save Repository
            </button>
          </div>
        )}

        {repos.length === 0 ? (
          <p className="text-gray-500 text-sm">No repositories configured.</p>
        ) : (
          <div className="space-y-2">
            {repos.map((r) => (
              <div
                key={r.id}
                className="border border-gray-800 rounded p-3 flex justify-between items-center"
              >
                <div>
                  <p className="font-medium">{r.name}</p>
                  <p className="text-sm text-gray-500">{r.cloneUrl}</p>
                </div>
                <button
                  onClick={() => handleDelete(r.id)}
                  className="text-red-400 hover:text-red-300 text-sm"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Verify frontend builds without errors**

```bash
cd frontend && npm run build
```

Expected: `dist/` built successfully.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/
git commit -m "feat(web-ui): all frontend pages (Dashboard, NewProject, Chat, PlanApproval, Execution, Settings)"
```

---

### Task 11: Frontend Docker + nginx

**Files:**
- Create: `frontend/Dockerfile`
- Create: `frontend/nginx.conf`

- [ ] **Step 1: Write `frontend/nginx.conf`**

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Proxy /api requests to backend
    location /api/ {
        proxy_pass http://backend:3000/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Proxy WebSocket connections
    location /ws {
        proxy_pass http://backend:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    # SPA fallback — send all routes to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

- [ ] **Step 2: Write `frontend/Dockerfile`**

```dockerfile
FROM node:20.18-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:stable-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

- [ ] **Step 3: Build the frontend image to verify**

```bash
docker build -t multi-agent-harness/frontend:latest ./frontend
```

Expected: image builds successfully.

- [ ] **Step 4: Commit**

```bash
git add frontend/Dockerfile frontend/nginx.conf
git commit -m "feat(web-ui): frontend Docker image + nginx config"
```

---

### Task 12: End-to-End Smoke Test

**Files:** No new files.

- [ ] **Step 1: Start all services**

```bash
docker compose up --build
```

Expected: backend + docker-proxy + frontend start without errors.

- [ ] **Step 2: Open the frontend**

Navigate to `http://localhost:8080` in a browser.

Expected: Dashboard page loads showing "No projects yet."

- [ ] **Step 3: Create a repository in Settings**

Navigate to Settings → Add Repository. Fill in a test GitHub repo. Save.

Expected: Repository appears in the list.

- [ ] **Step 4: Create a new project**

Navigate to New Project. Enter a name and description, select the repository. Click "Start Project".

Expected: Redirected to Chat page.

- [ ] **Step 5: Chat with the master agent**

Type a message in the chat input and press Enter.

Expected: Response streams in from the pi-coding-agent.

- [ ] **Step 6: Stop services**

```bash
docker compose down
```

- [ ] **Step 7: Commit**

```bash
git commit --allow-empty -m "chore(web-ui): end-to-end smoke test passed"
```
