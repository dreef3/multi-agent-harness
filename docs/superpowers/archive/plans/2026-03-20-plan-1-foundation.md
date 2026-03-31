# Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend scaffold, sub-agent Docker image, container lifecycle management, and RPC bridge so the backend can spawn, monitor, and communicate with pi-coding-agent containers.

**Architecture:** Node.js/TypeScript (ESM) backend manages Docker containers via a socket proxy (dockerode). Sub-agents run `pi --rpc` inside isolated containers; the backend attaches to their stdio to exchange newline-delimited JSON-RPC messages. SQLite (better-sqlite3) stores repositories and agent sessions.

**Tech Stack:** Node.js 20, TypeScript 5, Express, dockerode, better-sqlite3, vitest, Docker, Docker Compose

---

## File Map

| File | Responsibility |
|------|---------------|
| `backend/package.json` | Dependencies, build/test scripts |
| `backend/tsconfig.json` | TypeScript ESM config |
| `backend/vitest.config.ts` | Test runner config |
| `backend/src/config.ts` | All env-based configuration |
| `backend/src/models/types.ts` | All TypeScript domain interfaces |
| `backend/src/store/db.ts` | SQLite init + migrations |
| `backend/src/store/repositories.ts` | Repository CRUD |
| `backend/src/store/agents.ts` | AgentSession CRUD |
| `backend/src/orchestrator/imageBuilder.ts` | Build/check sub-agent Docker image at startup |
| `backend/src/orchestrator/containerManager.ts` | Container create/start/stop/remove/watch via dockerode |
| `backend/src/agents/subAgentBridge.ts` | Attach to container stdio, send/receive newline-delimited JSON |
| `backend/src/api/routes.ts` | Express router — health endpoint |
| `backend/src/index.ts` | Server bootstrap (DB → Docker → Express) |
| `backend/Dockerfile` | Backend container image |
| `backend/src/__tests__/store.test.ts` | Repository + AgentSession CRUD tests (real SQLite in temp dir) |
| `backend/src/__tests__/containerManager.test.ts` | Container lifecycle tests (mocked dockerode) |
| `backend/src/__tests__/subAgentBridge.test.ts` | RPC bridge tests (mocked PassThrough stream) |
| `sub-agent/Dockerfile` | Sub-agent image: Node 20 + JDK 17 + Maven + pi-coding-agent |
| `docker-compose.yml` | Backend + docker-proxy + frontend services + harness-agents network |
| `.env.example` | Template for `.env` |

---

### Task 1: Backend Project Scaffold

**Files:**
- Create: `backend/package.json`
- Create: `backend/tsconfig.json`
- Create: `backend/vitest.config.ts`

- [ ] **Step 1: Create `backend/package.json`**

```json
{
  "name": "@multi-agent-harness/backend",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "better-sqlite3": "^9.4.3",
    "dockerode": "^4.0.2",
    "express": "^4.18.2",
    "ws": "^8.16.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.8",
    "@types/dockerode": "^3.3.23",
    "@types/express": "^4.17.21",
    "@types/node": "^20.11.0",
    "@types/ws": "^8.5.10",
    "tsx": "^4.7.0",
    "typescript": "^5.3.3",
    "vitest": "^1.2.0"
  }
}
```

- [ ] **Step 2: Create `backend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `backend/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
  },
});
```

- [ ] **Step 4: Install dependencies**

```bash
cd backend && npm install
```

Expected: `node_modules/` created, no errors or warnings about unresolved peers.

- [ ] **Step 5: Commit**

```bash
git add backend/package.json backend/tsconfig.json backend/vitest.config.ts
git commit -m "feat(foundation): backend project scaffold"
```

---

### Task 2: Domain Types

**Files:**
- Create: `backend/src/models/types.ts`

- [ ] **Step 1: Create `backend/src/models/types.ts`**

```typescript
// All domain interfaces for the multi-agent harness

export interface Project {
  id: string;
  name: string;
  status:
    | "brainstorming"
    | "planning"
    | "awaiting_approval"
    | "executing"
    | "completed"
    | "failed"
    | "cancelled";
  source: {
    type: "jira" | "freeform";
    jiraTickets?: string[];
    freeformDescription?: string;
  };
  repositoryIds: string[];
  plan?: Plan;
  masterSessionPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface Plan {
  id: string;
  projectId: string;
  content: string;
  tasks: PlanTask[];
  approved: boolean;
  approvedAt?: string;
}

export interface PlanTask {
  id: string;
  repositoryId: string;
  description: string;
  status: "pending" | "executing" | "completed" | "failed" | "cancelled";
  dependsOn?: string[]; // MVP: unused, all tasks execute in parallel
}

export interface Repository {
  id: string;
  name: string;
  cloneUrl: string;
  provider: "github" | "bitbucket-server";
  providerConfig: {
    owner?: string;        // GitHub
    repo?: string;         // GitHub
    projectKey?: string;   // Bitbucket Server
    repoSlug?: string;     // Bitbucket Server
    baseUrl?: string;      // Bitbucket Server
  };
  defaultBranch: string;
  // Auth resolved from env at runtime: GITHUB_TOKEN, BITBUCKET_TOKEN
  createdAt: string;
  updatedAt: string;
}

export interface AgentSession {
  id: string;
  projectId: string;
  type: "master" | "sub";
  repositoryId?: string;
  taskId?: string;
  containerId?: string;
  status: "starting" | "running" | "completed" | "failed" | "stopped";
  sessionPath?: string; // enables resume
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: string;
  projectId: string;
  repositoryId: string;
  agentSessionId: string;
  provider: "github" | "bitbucket-server";
  externalId: string;
  url: string;
  branch: string;
  status: "open" | "merged" | "declined";
  createdAt: string;
  updatedAt: string;
}

export interface ReviewComment {
  id: string;
  pullRequestId: string;
  externalId: string;
  author: string;
  body: string;
  filePath?: string;
  lineNumber?: number;
  status: "pending" | "batched" | "fixing" | "fixed" | "ignored";
  receivedAt: string;
  updatedAt: string;
}

export interface VcsComment {
  id: string;
  author: string;
  body: string;
  filePath?: string;
  lineNumber?: number;
  createdAt: string;
}

export interface DebounceConfig {
  strategy: "timer";
  delayMs: number; // default 600000 (10 minutes)
}
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/models/types.ts
git commit -m "feat(foundation): domain types"
```

---

### Task 3: Config

**Files:**
- Create: `backend/src/config.ts`

- [ ] **Step 1: Create `backend/src/config.ts`**

```typescript
export const config = {
  port: parseInt(process.env.PORT ?? "3000", 10),
  dataDir: process.env.DATA_DIR ?? "./data",
  dockerProxyUrl: process.env.DOCKER_PROXY_URL ?? "http://docker-proxy:2375",
  subAgentImage:
    process.env.SUB_AGENT_IMAGE ?? "multi-agent-harness/sub-agent:latest",
  subAgentNetwork:
    process.env.SUB_AGENT_NETWORK ?? "multi-agent-harness_harness-agents",
  // 4 GB
  subAgentMemoryBytes: parseInt(
    process.env.SUB_AGENT_MEMORY_BYTES ?? String(4 * 1024 * 1024 * 1024),
    10
  ),
  subAgentCpuCount: parseInt(process.env.SUB_AGENT_CPU_COUNT ?? "2", 10),
  // 30 minutes
  subAgentTimeoutMs: parseInt(
    process.env.SUB_AGENT_TIMEOUT_MS ?? String(30 * 60 * 1000),
    10
  ),
  // 1 hour idle before teardown
  subAgentIdleTimeoutMs: parseInt(
    process.env.SUB_AGENT_IDLE_TIMEOUT_MS ?? String(60 * 60 * 1000),
    10
  ),
  subAgentMaxRetries: parseInt(process.env.SUB_AGENT_MAX_RETRIES ?? "3", 10),
  anthropicApiKeyPath:
    process.env.ANTHROPIC_API_KEY_PATH ?? "/run/secrets/api-key",
};
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/config.ts
git commit -m "feat(foundation): config from environment variables"
```

---

### Task 4: SQLite Store Foundation

**Files:**
- Create: `backend/src/store/db.ts`
- Create: `backend/src/__tests__/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDb, getDb } from "../store/db.js";
import os from "os";
import path from "path";
import fs from "fs";

describe("db", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes and creates all required tables", () => {
    initDb(tmpDir);
    const db = getDb();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("repositories");
    expect(names).toContain("agent_sessions");
  });

  it("is idempotent — running initDb twice does not throw", () => {
    initDb(tmpDir);
    expect(() => initDb(tmpDir)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npm test -- --reporter=verbose store.test.ts
```

Expected: FAIL — `Cannot find module '../store/db.js'`

- [ ] **Step 3: Write `backend/src/store/db.ts`**

```typescript
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized — call initDb() first.");
  return db;
}

export function initDb(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(path.join(dataDir, "harness.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      clone_url     TEXT NOT NULL,
      provider      TEXT NOT NULL,
      provider_config TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL,
      type          TEXT NOT NULL,
      repository_id TEXT,
      task_id       TEXT,
      container_id  TEXT,
      status        TEXT NOT NULL DEFAULT 'starting',
      session_path  TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
  `);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && npm test -- --reporter=verbose store.test.ts
```

Expected: PASS — 2 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/store/db.ts backend/src/__tests__/store.test.ts
git commit -m "feat(foundation): SQLite store with migrations"
```

---

### Task 5: Repository Store

**Files:**
- Create: `backend/src/store/repositories.ts`
- Modify: `backend/src/__tests__/store.test.ts`

- [ ] **Step 1: Add repository tests to `store.test.ts`**

Append a new `describe` block to the existing `store.test.ts`:

```typescript
import {
  insertRepository,
  getRepository,
  listRepositories,
  updateRepository,
  deleteRepository,
} from "../store/repositories.js";
import type { Repository } from "../models/types.js";

describe("repositories store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-repo-"));
    initDb(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const repo: Repository = {
    id: "repo-1",
    name: "my-service",
    cloneUrl: "https://github.com/org/my-service.git",
    provider: "github",
    providerConfig: { owner: "org", repo: "my-service" },
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("inserts and retrieves a repository", () => {
    insertRepository(repo);
    const found = getRepository("repo-1");
    expect(found).toMatchObject({ id: "repo-1", name: "my-service" });
    expect(found?.providerConfig).toEqual({ owner: "org", repo: "my-service" });
  });

  it("returns null for a missing id", () => {
    expect(getRepository("nonexistent")).toBeNull();
  });

  it("lists all repositories ordered by createdAt desc", () => {
    insertRepository(repo);
    const list = listRepositories();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("repo-1");
  });

  it("updates name", () => {
    insertRepository(repo);
    updateRepository("repo-1", { name: "renamed-service" });
    expect(getRepository("repo-1")?.name).toBe("renamed-service");
  });

  it("deletes a repository", () => {
    insertRepository(repo);
    deleteRepository("repo-1");
    expect(getRepository("repo-1")).toBeNull();
  });

  it("throws when updating a nonexistent repository", () => {
    expect(() => updateRepository("missing", { name: "x" })).toThrow(
      "Repository not found"
    );
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

```bash
cd backend && npm test -- --reporter=verbose store.test.ts
```

Expected: FAIL — `Cannot find module '../store/repositories.js'`

- [ ] **Step 3: Write `backend/src/store/repositories.ts`**

```typescript
import { getDb } from "./db.js";
import type { Repository } from "../models/types.js";

interface RepositoryRow {
  id: string;
  name: string;
  clone_url: string;
  provider: string;
  provider_config: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
}

function fromRow(row: RepositoryRow): Repository {
  return {
    id: row.id,
    name: row.name,
    cloneUrl: row.clone_url,
    provider: row.provider as Repository["provider"],
    providerConfig: JSON.parse(
      row.provider_config
    ) as Repository["providerConfig"],
    defaultBranch: row.default_branch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertRepository(repo: Repository): void {
  getDb()
    .prepare(
      `INSERT INTO repositories
         (id, name, clone_url, provider, provider_config, default_branch, created_at, updated_at)
       VALUES
         (@id, @name, @cloneUrl, @provider, @providerConfig, @defaultBranch, @createdAt, @updatedAt)`
    )
    .run({
      id: repo.id,
      name: repo.name,
      cloneUrl: repo.cloneUrl,
      provider: repo.provider,
      providerConfig: JSON.stringify(repo.providerConfig),
      defaultBranch: repo.defaultBranch,
      createdAt: repo.createdAt,
      updatedAt: repo.updatedAt,
    });
}

export function getRepository(id: string): Repository | null {
  const row = getDb()
    .prepare("SELECT * FROM repositories WHERE id = ?")
    .get(id) as RepositoryRow | undefined;
  return row ? fromRow(row) : null;
}

export function listRepositories(): Repository[] {
  const rows = getDb()
    .prepare("SELECT * FROM repositories ORDER BY created_at DESC")
    .all() as RepositoryRow[];
  return rows.map(fromRow);
}

export function updateRepository(
  id: string,
  updates: Partial<Omit<Repository, "id">>
): void {
  const existing = getRepository(id);
  if (!existing) throw new Error(`Repository not found: ${id}`);
  const merged = {
    ...existing,
    ...updates,
    id,
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .prepare(
      `UPDATE repositories
         SET name=@name, clone_url=@cloneUrl, provider=@provider,
             provider_config=@providerConfig, default_branch=@defaultBranch,
             updated_at=@updatedAt
       WHERE id=@id`
    )
    .run({
      id: merged.id,
      name: merged.name,
      cloneUrl: merged.cloneUrl,
      provider: merged.provider,
      providerConfig: JSON.stringify(merged.providerConfig),
      defaultBranch: merged.defaultBranch,
      updatedAt: merged.updatedAt,
    });
}

export function deleteRepository(id: string): void {
  getDb().prepare("DELETE FROM repositories WHERE id = ?").run(id);
}
```

- [ ] **Step 4: Run tests to verify they all pass**

```bash
cd backend && npm test -- --reporter=verbose store.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/store/repositories.ts backend/src/__tests__/store.test.ts
git commit -m "feat(foundation): repository store CRUD"
```

---

### Task 6: Agent Session Store

**Files:**
- Create: `backend/src/store/agents.ts`
- Modify: `backend/src/__tests__/store.test.ts`

- [ ] **Step 1: Add agent session tests to `store.test.ts`**

Append another `describe` block:

```typescript
import {
  insertAgentSession,
  getAgentSession,
  listAgentSessions,
  updateAgentSession,
} from "../store/agents.js";
import type { AgentSession } from "../models/types.js";

describe("agent sessions store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sess-"));
    initDb(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const session: AgentSession = {
    id: "session-1",
    projectId: "project-1",
    type: "sub",
    repositoryId: "repo-1",
    taskId: "task-1",
    status: "starting",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("inserts and retrieves a session", () => {
    insertAgentSession(session);
    const found = getAgentSession("session-1");
    expect(found).toMatchObject({ id: "session-1", status: "starting" });
    expect(found?.repositoryId).toBe("repo-1");
  });

  it("returns null for a missing id", () => {
    expect(getAgentSession("missing")).toBeNull();
  });

  it("lists sessions by projectId", () => {
    insertAgentSession(session);
    const list = listAgentSessions("project-1");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("session-1");
  });

  it("updates status and containerId", () => {
    insertAgentSession(session);
    updateAgentSession("session-1", {
      status: "running",
      containerId: "container-abc",
    });
    const found = getAgentSession("session-1");
    expect(found?.status).toBe("running");
    expect(found?.containerId).toBe("container-abc");
  });

  it("throws when updating a nonexistent session", () => {
    expect(() => updateAgentSession("missing", { status: "failed" })).toThrow(
      "AgentSession not found"
    );
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

```bash
cd backend && npm test -- --reporter=verbose store.test.ts
```

Expected: FAIL — `Cannot find module '../store/agents.js'`

- [ ] **Step 3: Write `backend/src/store/agents.ts`**

```typescript
import { getDb } from "./db.js";
import type { AgentSession } from "../models/types.js";

interface AgentSessionRow {
  id: string;
  project_id: string;
  type: string;
  repository_id: string | null;
  task_id: string | null;
  container_id: string | null;
  status: string;
  session_path: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(row: AgentSessionRow): AgentSession {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type as AgentSession["type"],
    repositoryId: row.repository_id ?? undefined,
    taskId: row.task_id ?? undefined,
    containerId: row.container_id ?? undefined,
    status: row.status as AgentSession["status"],
    sessionPath: row.session_path ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertAgentSession(session: AgentSession): void {
  getDb()
    .prepare(
      `INSERT INTO agent_sessions
         (id, project_id, type, repository_id, task_id, container_id,
          status, session_path, created_at, updated_at)
       VALUES
         (@id, @projectId, @type, @repositoryId, @taskId, @containerId,
          @status, @sessionPath, @createdAt, @updatedAt)`
    )
    .run({
      id: session.id,
      projectId: session.projectId,
      type: session.type,
      repositoryId: session.repositoryId ?? null,
      taskId: session.taskId ?? null,
      containerId: session.containerId ?? null,
      status: session.status,
      sessionPath: session.sessionPath ?? null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
}

export function getAgentSession(id: string): AgentSession | null {
  const row = getDb()
    .prepare("SELECT * FROM agent_sessions WHERE id = ?")
    .get(id) as AgentSessionRow | undefined;
  return row ? fromRow(row) : null;
}

export function listAgentSessions(projectId: string): AgentSession[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM agent_sessions WHERE project_id = ? ORDER BY created_at DESC"
    )
    .all(projectId) as AgentSessionRow[];
  return rows.map(fromRow);
}

export function updateAgentSession(
  id: string,
  updates: Partial<Omit<AgentSession, "id" | "projectId" | "type">>
): void {
  const existing = getAgentSession(id);
  if (!existing) throw new Error(`AgentSession not found: ${id}`);
  const merged = {
    ...existing,
    ...updates,
    id,
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .prepare(
      `UPDATE agent_sessions
         SET repository_id=@repositoryId, task_id=@taskId,
             container_id=@containerId, status=@status,
             session_path=@sessionPath, updated_at=@updatedAt
       WHERE id=@id`
    )
    .run({
      id: merged.id,
      repositoryId: merged.repositoryId ?? null,
      taskId: merged.taskId ?? null,
      containerId: merged.containerId ?? null,
      status: merged.status,
      sessionPath: merged.sessionPath ?? null,
      updatedAt: merged.updatedAt,
    });
}
```

- [ ] **Step 4: Run tests to verify they all pass**

```bash
cd backend && npm test -- --reporter=verbose store.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/store/agents.ts backend/src/__tests__/store.test.ts
git commit -m "feat(foundation): agent session store CRUD"
```

---

### Task 7: Sub-Agent Dockerfile

**Files:**
- Create: `sub-agent/Dockerfile`

- [ ] **Step 1: Create `sub-agent/Dockerfile`**

```dockerfile
FROM node:20.18-slim

# Install git, JDK 17 (headless — no GUI), and Maven
RUN apt-get update && apt-get install -y \
    git \
    openjdk-17-jdk-headless \
    maven \
    && rm -rf /var/lib/apt/lists/*

# Install pi-coding-agent globally
RUN npm install -g @mariozechner/pi-coding-agent

# Configure git to use a credentials file mounted at runtime
# The credentials file will be at /run/secrets/git-credentials
RUN git config --global credential.helper "store --file /run/secrets/git-credentials"

WORKDIR /workspace

# pi --rpc starts pi in JSON-RPC mode on stdio
ENTRYPOINT ["pi", "--rpc"]
```

- [ ] **Step 2: Build the image to verify it builds**

```bash
docker build -t multi-agent-harness/sub-agent:latest ./sub-agent
```

Expected: image builds without errors. `pi` is installed.

- [ ] **Step 3: Verify pi is available in the image**

```bash
docker run --rm --entrypoint pi multi-agent-harness/sub-agent:latest --version
```

Expected: version string such as `pi 0.61.0` printed.

- [ ] **Step 4: Verify JDK and Maven are available**

```bash
docker run --rm --entrypoint java multi-agent-harness/sub-agent:latest -version
docker run --rm --entrypoint mvn multi-agent-harness/sub-agent:latest --version
```

Expected: Java 17 and Maven version strings.

- [ ] **Step 5: Commit**

```bash
git add sub-agent/Dockerfile
git commit -m "feat(foundation): sub-agent Docker image (Node 20 + JDK 17 + Maven + pi)"
```

---

### Task 8: Docker Compose + .env.example

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`

- [ ] **Step 1: Create `docker-compose.yml`**

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
    environment:
      DOCKER_PROXY_URL: http://docker-proxy:2375
    depends_on:
      - docker-proxy

  docker-proxy:
    # Restricts Docker API access — backend uses CONTAINERS/IMAGES/NETWORKS only
    image: tecnativa/docker-socket-proxy:0.2.1
    environment:
      CONTAINERS: 1
      IMAGES: 1
      NETWORKS: 1
      POST: 1
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock

  frontend:
    build: ./frontend
    ports:
      - "8080:80"
    depends_on:
      - backend

networks:
  harness-agents:
    # Sub-agent containers attach to this network only.
    # They get outbound internet but cannot reach backend or docker-proxy.
    driver: bridge
    internal: false
```

- [ ] **Step 2: Create `.env.example`**

```
# Copy to .env and fill in your values

ANTHROPIC_API_KEY=
ANTHROPIC_API_KEY_PATH=/run/secrets/api-key

JIRA_BASE_URL=https://jira.yourcompany.com
JIRA_TOKEN=

GITHUB_TOKEN=
BITBUCKET_BASE_URL=https://bitbucket.yourcompany.com
BITBUCKET_TOKEN=

PORT=3000
DATA_DIR=/app/data
SUB_AGENT_IMAGE=multi-agent-harness/sub-agent:latest
SUB_AGENT_NETWORK=multi-agent-harness_harness-agents
```

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "feat(foundation): Docker Compose + .env.example"
```

---

### Task 9: Image Builder

**Files:**
- Create: `backend/src/orchestrator/imageBuilder.ts`
- Create: `backend/src/__tests__/containerManager.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/containerManager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("imageBuilder", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("resolves if image already exists", async () => {
    const mockInspect = vi.fn().mockResolvedValue({});
    const mockDocker = {
      getImage: vi.fn().mockReturnValue({ inspect: mockInspect }),
    };

    const { ensureSubAgentImage } = await import(
      "../orchestrator/imageBuilder.js"
    );
    await expect(
      ensureSubAgentImage(mockDocker as never, "test-image:latest")
    ).resolves.toBeUndefined();
    expect(mockInspect).toHaveBeenCalled();
  });

  it("throws if image does not exist", async () => {
    const mockInspect = vi.fn().mockRejectedValue(new Error("No such image"));
    const mockDocker = {
      getImage: vi.fn().mockReturnValue({ inspect: mockInspect }),
    };

    const { ensureSubAgentImage } = await import(
      "../orchestrator/imageBuilder.js"
    );
    await expect(
      ensureSubAgentImage(mockDocker as never, "test-image:latest")
    ).rejects.toThrow("test-image:latest");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npm test -- --reporter=verbose containerManager.test.ts
```

Expected: FAIL — `Cannot find module '../orchestrator/imageBuilder.js'`

- [ ] **Step 3: Write `backend/src/orchestrator/imageBuilder.ts`**

```typescript
import type Dockerode from "dockerode";

/**
 * Verifies the sub-agent Docker image exists. The image must be pre-built
 * before starting the backend (run: docker build -t <imageName> ./sub-agent).
 * Throws with an actionable message if the image is not found.
 */
export async function ensureSubAgentImage(
  docker: Dockerode,
  imageName: string
): Promise<void> {
  try {
    await docker.getImage(imageName).inspect();
    console.log(`[imageBuilder] ${imageName} found.`);
  } catch {
    throw new Error(
      `[imageBuilder] Sub-agent image "${imageName}" not found. ` +
        `Build it first: docker build -t ${imageName} ./sub-agent`
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && npm test -- --reporter=verbose containerManager.test.ts
```

Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/orchestrator/imageBuilder.ts backend/src/__tests__/containerManager.test.ts
git commit -m "feat(foundation): sub-agent image builder"
```

---

### Task 10: Container Manager

**Files:**
- Create: `backend/src/orchestrator/containerManager.ts`
- Modify: `backend/src/__tests__/containerManager.test.ts`

- [ ] **Step 1: Add container lifecycle tests to `containerManager.test.ts`**

Append a new `describe` block:

```typescript
import {
  createSubAgentContainer,
  startContainer,
  stopContainer,
  removeContainer,
  getContainerStatus,
} from "../orchestrator/containerManager.js";

describe("containerManager", () => {
  it("creates container with correct env and binds", async () => {
    const mockCreate = vi.fn().mockResolvedValue({ id: "container-abc" });
    const mockDocker = { createContainer: mockCreate };

    const id = await createSubAgentContainer(mockDocker as never, {
      sessionId: "sess-1",
      repoCloneUrl: "https://github.com/org/repo.git",
      branchName: "agent/proj-1/task-1",
      anthropicApiKeyPath: "/secrets/api-key",
    });

    expect(id).toBe("container-abc");
    const callArg = mockCreate.mock.calls[0][0] as {
      Env: string[];
      HostConfig: { Binds: string[] };
    };
    expect(callArg.Env).toContain(
      "REPO_CLONE_URL=https://github.com/org/repo.git"
    );
    expect(callArg.HostConfig.Binds).toContain(
      "/secrets/api-key:/run/secrets/api-key:ro"
    );
  });

  it("starts a container", async () => {
    const mockStart = vi.fn().mockResolvedValue(undefined);
    const mockDocker = {
      getContainer: vi.fn().mockReturnValue({ start: mockStart }),
    };
    await startContainer(mockDocker as never, "container-abc");
    expect(mockStart).toHaveBeenCalled();
  });

  it("reports running status", async () => {
    const mockDocker = {
      getContainer: vi.fn().mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ State: { Status: "running" } }),
      }),
    };
    expect(await getContainerStatus(mockDocker as never, "abc")).toBe("running");
  });

  it("reports unknown for missing container", async () => {
    const mockDocker = {
      getContainer: vi.fn().mockReturnValue({
        inspect: vi.fn().mockRejectedValue(new Error("No such container")),
      }),
    };
    expect(await getContainerStatus(mockDocker as never, "abc")).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

```bash
cd backend && npm test -- --reporter=verbose containerManager.test.ts
```

Expected: FAIL — `Cannot find module '../orchestrator/containerManager.js'`

- [ ] **Step 3: Write `backend/src/orchestrator/containerManager.ts`**

```typescript
import type Dockerode from "dockerode";
import { config } from "../config.js";

export interface ContainerCreateOptions {
  sessionId: string;
  repoCloneUrl: string;
  branchName: string;
  anthropicApiKeyPath: string;
}

export async function createSubAgentContainer(
  docker: Dockerode,
  opts: ContainerCreateOptions
): Promise<string> {
  const container = await docker.createContainer({
    Image: config.subAgentImage,
    Env: [
      `REPO_CLONE_URL=${opts.repoCloneUrl}`,
      `BRANCH_NAME=${opts.branchName}`,
    ],
    WorkingDir: "/workspace",
    HostConfig: {
      Binds: [`${opts.anthropicApiKeyPath}:/run/secrets/api-key:ro`],
      Memory: config.subAgentMemoryBytes,
      NanoCpus: config.subAgentCpuCount * 1_000_000_000,
      NetworkMode: config.subAgentNetwork,
    },
    Labels: { "harness.session-id": opts.sessionId },
  });
  return container.id;
}

export async function startContainer(
  docker: Dockerode,
  containerId: string
): Promise<void> {
  await docker.getContainer(containerId).start();
}

export async function stopContainer(
  docker: Dockerode,
  containerId: string
): Promise<void> {
  await docker.getContainer(containerId).stop({ t: 10 });
}

export async function removeContainer(
  docker: Dockerode,
  containerId: string
): Promise<void> {
  await docker.getContainer(containerId).remove({ force: true });
}

export async function getContainerStatus(
  docker: Dockerode,
  containerId: string
): Promise<"running" | "stopped" | "exited" | "unknown"> {
  try {
    const info = await docker.getContainer(containerId).inspect();
    if (info.State.Status === "running") return "running";
    if (info.State.Status === "exited") return "exited";
    return "stopped";
  } catch {
    return "unknown";
  }
}

/**
 * Watches for the container to die and calls onExit with the exit code.
 * Attach to Docker events API — fires once when the container stops.
 */
export async function watchContainerExit(
  docker: Dockerode,
  containerId: string,
  onExit: (exitCode: number) => void
): Promise<void> {
  const events = await docker.getEvents({
    filters: JSON.stringify({
      container: [containerId],
      event: ["die"],
    }),
  });
  (events as NodeJS.EventEmitter).on("data", (data: Buffer) => {
    const event = JSON.parse(data.toString()) as {
      Actor?: { Attributes?: { exitCode?: string } };
    };
    onExit(parseInt(event.Actor?.Attributes?.exitCode ?? "1", 10));
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && npm test -- --reporter=verbose containerManager.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/orchestrator/containerManager.ts backend/src/__tests__/containerManager.test.ts
git commit -m "feat(foundation): container lifecycle manager (dockerode)"
```

---

### Task 11: Sub-Agent RPC Bridge

**Files:**
- Create: `backend/src/agents/subAgentBridge.ts`
- Create: `backend/src/__tests__/subAgentBridge.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/subAgentBridge.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "stream";
import { SubAgentBridge } from "../agents/subAgentBridge.js";

function makeDockerMock(stream: PassThrough) {
  return {
    getContainer: vi.fn().mockReturnValue({
      attach: vi.fn().mockResolvedValue(stream),
    }),
  };
}

describe("SubAgentBridge", () => {
  it("emits parsed JSON-RPC messages received from the container", async () => {
    const stream = new PassThrough();
    const bridge = new SubAgentBridge();
    await bridge.attach(makeDockerMock(stream) as never, "container-abc");

    const messages: unknown[] = [];
    bridge.on("message", (msg) => messages.push(msg));

    stream.push('{"type":"session/update","content":"hello"}\n');
    stream.push('{"type":"session/update","content":"world"}\n');
    await new Promise((r) => setTimeout(r, 10));

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: "session/update",
      content: "hello",
    });
    expect(messages[1]).toMatchObject({
      type: "session/update",
      content: "world",
    });
  });

  it("emits raw 'output' event for non-JSON lines", async () => {
    const stream = new PassThrough();
    const bridge = new SubAgentBridge();
    await bridge.attach(makeDockerMock(stream) as never, "container-abc");

    const outputs: string[] = [];
    bridge.on("output", (line: string) => outputs.push(line));

    stream.push("Starting Maven build...\n");
    await new Promise((r) => setTimeout(r, 10));

    expect(outputs).toContain("Starting Maven build...");
  });

  it("writes JSON-RPC messages to the container stdin", async () => {
    const stream = new PassThrough();
    const bridge = new SubAgentBridge();
    await bridge.attach(makeDockerMock(stream) as never, "container-abc");

    const written: string[] = [];
    stream.on("data", (chunk: Buffer) => written.push(chunk.toString()));

    bridge.send({ type: "session/prompt", text: "do the task" });
    await new Promise((r) => setTimeout(r, 10));

    const all = written.join("");
    expect(all).toContain('"type":"session/prompt"');
    expect(all).toContain('"text":"do the task"');
    expect(all.endsWith("\n")).toBe(true);
  });

  it("throws if send is called before attach", () => {
    const bridge = new SubAgentBridge();
    expect(() => bridge.send({ type: "test" })).toThrow("not attached");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npm test -- --reporter=verbose subAgentBridge.test.ts
```

Expected: FAIL — `Cannot find module '../agents/subAgentBridge.js'`

- [ ] **Step 3: Write `backend/src/agents/subAgentBridge.ts`**

```typescript
import { EventEmitter } from "events";
import type Dockerode from "dockerode";

export interface RpcMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Attaches to a running pi --rpc container via Docker stdio.
 * Sends newline-delimited JSON messages and parses incoming JSON lines.
 *
 * Events:
 *   "message" — parsed RpcMessage from the container
 *   "output"  — raw non-JSON line (build output, logs)
 *   "end"     — container stream closed
 *   "error"   — stream error
 */
export class SubAgentBridge extends EventEmitter {
  private stream: NodeJS.ReadWriteStream | null = null;
  private buffer = "";

  async attach(docker: Dockerode, containerId: string): Promise<void> {
    const container = docker.getContainer(containerId);
    this.stream = (await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
    })) as unknown as NodeJS.ReadWriteStream;

    this.stream.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      this.flushBuffer();
    });

    this.stream.on("error", (err: Error) => this.emit("error", err));
    this.stream.on("end", () => this.emit("end"));
  }

  send(message: RpcMessage): void {
    if (!this.stream)
      throw new Error("SubAgentBridge is not attached to a container");
    this.stream.write(JSON.stringify(message) + "\n");
  }

  detach(): void {
    this.stream?.destroy();
    this.stream = null;
    this.buffer = "";
  }

  private flushBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as RpcMessage;
        this.emit("message", msg);
      } catch {
        this.emit("output", trimmed);
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && npm test -- --reporter=verbose subAgentBridge.test.ts
```

Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agents/subAgentBridge.ts backend/src/__tests__/subAgentBridge.test.ts
git commit -m "feat(foundation): sub-agent RPC bridge (newline-delimited JSON over Docker stdio)"
```

---

### Task 12: Server Bootstrap + Health Endpoint

**Files:**
- Create: `backend/src/api/routes.ts`
- Create: `backend/src/index.ts`
- Create: `backend/Dockerfile`

- [ ] **Step 1: Write `backend/src/api/routes.ts`**

```typescript
import { Router } from "express";

export function createRouter(): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return router;
}
```

- [ ] **Step 2: Write `backend/src/index.ts`**

```typescript
import express from "express";
import Dockerode from "dockerode";
import { config } from "./config.js";
import { initDb } from "./store/db.js";
import { ensureSubAgentImage } from "./orchestrator/imageBuilder.js";
import { createRouter } from "./api/routes.js";

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
    await ensureSubAgentImage(docker, config.subAgentImage);
  } catch (err) {
    console.error("[startup] Failed to ensure sub-agent image:", err);
    process.exit(1);
  }

  const app = express();
  app.use(express.json());
  app.use("/api", createRouter());

  app.listen(config.port, () => {
    console.log(`[startup] Backend listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
```

- [ ] **Step 3: Write `backend/Dockerfile`**

```dockerfile
FROM node:20.18-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist ./dist

# Sub-agent image is pre-built separately: docker build -t <SUB_AGENT_IMAGE> ./sub-agent
# The backend only verifies the image exists at startup — no build at runtime.

CMD ["node", "dist/index.js"]
```

- [ ] **Step 4: Verify full test suite passes**

```bash
cd backend && npm test
```

Expected: all tests pass.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd backend && npm run build
```

Expected: `dist/` directory created, no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/api/routes.ts backend/src/index.ts backend/Dockerfile
git commit -m "feat(foundation): server bootstrap + health endpoint"
```

---

### Task 13: Smoke Test — Compose Up

**Files:** No new files — integration verification only.

- [ ] **Step 1: Copy .env.example and set API key**

```bash
cp .env.example .env
# Edit .env: set ANTHROPIC_API_KEY to your key
```

- [ ] **Step 2: Build the backend**

```bash
cd backend && npm run build && cd ..
```

Expected: `backend/dist/` populated.

- [ ] **Step 3: Start docker-proxy and backend**

```bash
docker compose up --build backend docker-proxy
```

Expected: logs show "Backend listening on port 3000".

- [ ] **Step 4: Hit the health endpoint**

```bash
curl http://localhost:3000/api/health
```

Expected:
```json
{"status":"ok","timestamp":"2026-03-20T..."}
```

- [ ] **Step 5: Stop services**

```bash
docker compose down
```

- [ ] **Step 6: Commit**

```bash
git commit --allow-empty -m "chore(foundation): smoke test passed — health endpoint live"
```
