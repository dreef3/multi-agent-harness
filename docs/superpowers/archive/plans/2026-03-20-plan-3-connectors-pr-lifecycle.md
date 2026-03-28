# Connectors + PR Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add JIRA Server, GitHub, and Bitbucket Server connectors; a PR creation flow triggered when sub-agents finish; and a debounce engine that batches human review comments and re-runs the sub-agent to fix them, with a manual trigger in the frontend.

**Architecture:** VCS connectors share a typed interface. GitHub uses Octokit + webhooks. Bitbucket Server uses direct REST calls + polling. JIRA Server is REST-only (read-heavy). The debounce engine runs in-process with a `Map<prId, NodeJS.Timeout>`. On backend restart, it reconstructs pending timers from SQLite. The task dispatcher wires together: approved plan → spawn sub-agents → wait for completion → create PR.

**Tech Stack:** @octokit/rest, node-fetch (Bitbucket/JIRA), better-sqlite3, express webhook endpoint

**Prerequisite:** Plans 1 and 2 must be complete.

---

## File Map

| File | Responsibility |
|------|---------------|
| `backend/src/store/db.ts` | Add pull_requests + review_comments migrations |
| `backend/src/store/pullRequests.ts` | PullRequest + ReviewComment CRUD |
| `backend/src/connectors/types.ts` | Shared VcsConnector interface + VcsComment type |
| `backend/src/connectors/github.ts` | GitHub: create branch/PR, get PR, get comments, add comment |
| `backend/src/connectors/bitbucket.ts` | Bitbucket Server: REST API v1.0, same interface |
| `backend/src/connectors/jira.ts` | JIRA Server: search issues, get issue detail |
| `backend/src/orchestrator/taskDispatcher.ts` | Wires approved plan → containers → PRs |
| `backend/src/debounce/strategies.ts` | DebounceConfig type + strategy resolver |
| `backend/src/debounce/engine.ts` | Timer management, batch collection, restart recovery |
| `backend/src/api/jira.ts` | REST proxy for JIRA search |
| `backend/src/api/pullRequests.ts` | REST: list PRs, list comments, manual fix trigger |
| `backend/src/api/webhooks.ts` | POST /api/webhooks/github — receives GitHub review events |
| `backend/src/api/routes.ts` | Wire new routes |
| `backend/src/__tests__/connectors.test.ts` | VCS connector tests (mocked fetch/Octokit) |
| `backend/src/__tests__/debounce.test.ts` | Debounce engine tests (fake timers) |
| `frontend/src/pages/NewProject.tsx` | Add JIRA ticket picker |
| `frontend/src/pages/PrOverview.tsx` | New page: PR list + comments + debounce countdown + trigger |
| `frontend/src/App.tsx` | Add /projects/:id/prs route |

---

### Task 1: DB Migrations for PRs + Comments

**Files:**
- Modify: `backend/src/store/db.ts`
- Modify: `backend/src/__tests__/store.test.ts`

- [ ] **Step 1: Add migration test**

In the `db` describe block in `backend/src/__tests__/store.test.ts`, add:

```typescript
it("creates pull_requests and review_comments tables", () => {
  initDb(tmpDir);
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const names = tables.map((t) => t.name);
  expect(names).toContain("pull_requests");
  expect(names).toContain("review_comments");
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd backend && npm test -- --reporter=verbose store.test.ts
```

Expected: FAIL — tables missing.

- [ ] **Step 3: Extend `migrate()` in `backend/src/store/db.ts`**

Add to the `database.exec(...)` string:

```sql
    CREATE TABLE IF NOT EXISTS pull_requests (
      id               TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL,
      repository_id    TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      provider         TEXT NOT NULL,
      external_id      TEXT NOT NULL,
      url              TEXT NOT NULL,
      branch           TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'open',
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_comments (
      id              TEXT PRIMARY KEY,
      pull_request_id TEXT NOT NULL,
      external_id     TEXT NOT NULL,
      author          TEXT NOT NULL,
      body            TEXT NOT NULL,
      file_path       TEXT,
      line_number     INTEGER,
      status          TEXT NOT NULL DEFAULT 'pending',
      received_at     TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      UNIQUE(external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_review_comments_pr
      ON review_comments (pull_request_id, status);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && npm test -- --reporter=verbose store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/store/db.ts backend/src/__tests__/store.test.ts
git commit -m "feat(connectors): add pull_requests + review_comments DB migrations"
```

---

### Task 2: Pull Request + Review Comment Store

**Files:**
- Create: `backend/src/store/pullRequests.ts`
- Create: `backend/src/__tests__/pullRequests.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/pullRequests.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDb } from "../store/db.js";
import {
  insertPullRequest,
  getPullRequest,
  listPullRequestsByProject,
  updatePullRequest,
  upsertReviewComment,
  getPendingComments,
  markCommentsStatus,
} from "../store/pullRequests.js";
import type { PullRequest, ReviewComment } from "../models/types.js";
import os from "os";
import path from "path";
import fs from "fs";

describe("pullRequests store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pr-"));
    initDb(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const pr: PullRequest = {
    id: "pr-1",
    projectId: "proj-1",
    repositoryId: "repo-1",
    agentSessionId: "sess-1",
    provider: "github",
    externalId: "42",
    url: "https://github.com/org/repo/pull/42",
    branch: "agent/proj-1/task-1",
    status: "open",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("inserts and retrieves a PR", () => {
    insertPullRequest(pr);
    const found = getPullRequest("pr-1");
    expect(found).toMatchObject({ id: "pr-1", externalId: "42" });
  });

  it("lists PRs by project", () => {
    insertPullRequest(pr);
    const list = listPullRequestsByProject("proj-1");
    expect(list).toHaveLength(1);
  });

  it("updates PR status", () => {
    insertPullRequest(pr);
    updatePullRequest("pr-1", { status: "merged" });
    expect(getPullRequest("pr-1")?.status).toBe("merged");
  });

  it("upserts review comments by externalId (no duplicates)", () => {
    insertPullRequest(pr);
    const comment: ReviewComment = {
      id: "c-1",
      pullRequestId: "pr-1",
      externalId: "ext-100",
      author: "alice",
      body: "Fix this",
      status: "pending",
      receivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    upsertReviewComment(comment);
    upsertReviewComment(comment); // second call should not throw or duplicate
    const pending = getPendingComments("pr-1");
    expect(pending).toHaveLength(1);
  });

  it("markCommentsStatus changes status for given ids", () => {
    insertPullRequest(pr);
    const comment: ReviewComment = {
      id: "c-2",
      pullRequestId: "pr-1",
      externalId: "ext-200",
      author: "bob",
      body: "Change this",
      status: "pending",
      receivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    upsertReviewComment(comment);
    markCommentsStatus(["c-2"], "batched");
    expect(getPendingComments("pr-1")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd backend && npm test -- --reporter=verbose pullRequests.test.ts
```

Expected: FAIL — `Cannot find module '../store/pullRequests.js'`

- [ ] **Step 3: Write `backend/src/store/pullRequests.ts`**

```typescript
import { getDb } from "./db.js";
import type { PullRequest, ReviewComment } from "../models/types.js";

// ── Pull Requests ──────────────────────────────────────────────────────────

interface PrRow {
  id: string;
  project_id: string;
  repository_id: string;
  agent_session_id: string;
  provider: string;
  external_id: string;
  url: string;
  branch: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function prFromRow(row: PrRow): PullRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    agentSessionId: row.agent_session_id,
    provider: row.provider as PullRequest["provider"],
    externalId: row.external_id,
    url: row.url,
    branch: row.branch,
    status: row.status as PullRequest["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertPullRequest(pr: PullRequest): void {
  getDb()
    .prepare(
      `INSERT INTO pull_requests
         (id, project_id, repository_id, agent_session_id, provider,
          external_id, url, branch, status, created_at, updated_at)
       VALUES
         (@id, @projectId, @repositoryId, @agentSessionId, @provider,
          @externalId, @url, @branch, @status, @createdAt, @updatedAt)`
    )
    .run({
      id: pr.id,
      projectId: pr.projectId,
      repositoryId: pr.repositoryId,
      agentSessionId: pr.agentSessionId,
      provider: pr.provider,
      externalId: pr.externalId,
      url: pr.url,
      branch: pr.branch,
      status: pr.status,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
    });
}

export function getPullRequest(id: string): PullRequest | null {
  const row = getDb()
    .prepare("SELECT * FROM pull_requests WHERE id = ?")
    .get(id) as PrRow | undefined;
  return row ? prFromRow(row) : null;
}

export function listPullRequestsByProject(projectId: string): PullRequest[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM pull_requests WHERE project_id = ? ORDER BY created_at DESC"
    )
    .all(projectId) as PrRow[];
  return rows.map(prFromRow);
}

export function updatePullRequest(
  id: string,
  updates: Partial<Omit<PullRequest, "id">>
): void {
  const existing = getPullRequest(id);
  if (!existing) throw new Error(`PullRequest not found: ${id}`);
  const merged = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  getDb()
    .prepare(
      `UPDATE pull_requests
         SET status=@status, url=@url, updated_at=@updatedAt
       WHERE id=@id`
    )
    .run({ id: merged.id, status: merged.status, url: merged.url, updatedAt: merged.updatedAt });
}

// ── Review Comments ────────────────────────────────────────────────────────

interface CommentRow {
  id: string;
  pull_request_id: string;
  external_id: string;
  author: string;
  body: string;
  file_path: string | null;
  line_number: number | null;
  status: string;
  received_at: string;
  updated_at: string;
}

function commentFromRow(row: CommentRow): ReviewComment {
  return {
    id: row.id,
    pullRequestId: row.pull_request_id,
    externalId: row.external_id,
    author: row.author,
    body: row.body,
    filePath: row.file_path ?? undefined,
    lineNumber: row.line_number ?? undefined,
    status: row.status as ReviewComment["status"],
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Insert or ignore on duplicate externalId — safe to call multiple times
 * for the same VCS comment (e.g., Bitbucket polling).
 */
export function upsertReviewComment(comment: ReviewComment): void {
  getDb()
    .prepare(
      `INSERT INTO review_comments
         (id, pull_request_id, external_id, author, body,
          file_path, line_number, status, received_at, updated_at)
       VALUES
         (@id, @pullRequestId, @externalId, @author, @body,
          @filePath, @lineNumber, @status, @receivedAt, @updatedAt)
       ON CONFLICT(external_id) DO NOTHING`
    )
    .run({
      id: comment.id,
      pullRequestId: comment.pullRequestId,
      externalId: comment.externalId,
      author: comment.author,
      body: comment.body,
      filePath: comment.filePath ?? null,
      lineNumber: comment.lineNumber ?? null,
      status: comment.status,
      receivedAt: comment.receivedAt,
      updatedAt: comment.updatedAt,
    });
}

export function getPendingComments(pullRequestId: string): ReviewComment[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM review_comments WHERE pull_request_id = ? AND status = 'pending' ORDER BY received_at ASC"
    )
    .all(pullRequestId) as CommentRow[];
  return rows.map(commentFromRow);
}

export function markCommentsStatus(
  commentIds: string[],
  status: ReviewComment["status"]
): void {
  if (commentIds.length === 0) return;
  const placeholders = commentIds.map(() => "?").join(",");
  getDb()
    .prepare(
      `UPDATE review_comments SET status = ?, updated_at = ? WHERE id IN (${placeholders})`
    )
    .run(status, new Date().toISOString(), ...commentIds);
}

export function listAllPendingComments(): Array<
  ReviewComment & { prId: string }
> {
  const rows = getDb()
    .prepare(
      "SELECT *, pull_request_id as prId FROM review_comments WHERE status = 'pending' ORDER BY received_at ASC"
    )
    .all() as Array<CommentRow & { prId: string }>;
  return rows.map((r) => ({ ...commentFromRow(r), prId: r.prId }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && npm test -- --reporter=verbose pullRequests.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/store/pullRequests.ts backend/src/__tests__/pullRequests.test.ts
git commit -m "feat(connectors): pull request + review comment store"
```

---

### Task 3: VCS Connector Types

**Files:**
- Create: `backend/src/connectors/types.ts`

- [ ] **Step 1: Write `backend/src/connectors/types.ts`**

```typescript
import type { Repository, VcsComment } from "../models/types.js";

export interface CreatePrParams {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface VcsConnector {
  /** Create a branch from the given ref */
  createBranch(
    repo: Repository,
    branchName: string,
    fromRef: string
  ): Promise<void>;

  /** Open a pull request and return its external id and URL */
  createPullRequest(
    repo: Repository,
    params: CreatePrParams
  ): Promise<{ id: string; url: string }>;

  /** Fetch the current status of a pull request */
  getPullRequest(
    repo: Repository,
    prId: string
  ): Promise<{ status: "open" | "merged" | "declined"; url: string }>;

  /** Get comments on a PR, optionally only those after a given timestamp */
  getComments(
    repo: Repository,
    prId: string,
    since?: string
  ): Promise<VcsComment[]>;

  /** Post a comment on a PR */
  addComment(
    repo: Repository,
    prId: string,
    body: string
  ): Promise<void>;
}

export function getConnector(provider: Repository["provider"]): VcsConnector {
  // Lazily import to avoid loading both SDKs when only one is needed
  if (provider === "github") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { GitHubConnector } = require("./github.js") as {
      GitHubConnector: new () => VcsConnector;
    };
    return new GitHubConnector();
  }
  if (provider === "bitbucket-server") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BitbucketConnector } = require("./bitbucket.js") as {
      BitbucketConnector: new () => VcsConnector;
    };
    return new BitbucketConnector();
  }
  throw new Error(`Unknown provider: ${String(provider)}`);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/connectors/types.ts
git commit -m "feat(connectors): VCS connector interface"
```

---

### Task 4: GitHub Connector

**Files:**
- Create: `backend/src/connectors/github.ts`
- Create: `backend/src/__tests__/connectors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/connectors.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Octokit
vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    git: {
      getRef: vi.fn().mockResolvedValue({ data: { object: { sha: "abc123" } } }),
      createRef: vi.fn().mockResolvedValue({}),
    },
    pulls: {
      create: vi
        .fn()
        .mockResolvedValue({ data: { number: 42, html_url: "https://github.com/org/repo/pull/42" } }),
      get: vi
        .fn()
        .mockResolvedValue({ data: { state: "open", html_url: "https://github.com/org/repo/pull/42", merged: false } }),
      listReviewComments: vi.fn().mockResolvedValue({
        data: [
          {
            id: 1,
            user: { login: "alice" },
            body: "Fix this",
            path: "src/Foo.kt",
            line: 10,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
      createReviewComment: vi.fn().mockResolvedValue({}),
    },
    issues: {
      createComment: vi.fn().mockResolvedValue({}),
    },
  })),
}));

import { GitHubConnector } from "../connectors/github.js";
import type { Repository } from "../models/types.js";

const repo: Repository = {
  id: "repo-1",
  name: "my-service",
  cloneUrl: "https://github.com/org/repo.git",
  provider: "github",
  providerConfig: { owner: "org", repo: "repo" },
  defaultBranch: "main",
  createdAt: "",
  updatedAt: "",
};

describe("GitHubConnector", () => {
  let connector: GitHubConnector;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = "test-token";
    connector = new GitHubConnector();
  });

  it("creates a pull request and returns id + url", async () => {
    const result = await connector.createPullRequest(repo, {
      title: "Add caching",
      description: "Implements caching layer",
      sourceBranch: "agent/proj-1/task-1",
      targetBranch: "main",
    });
    expect(result.id).toBe("42");
    expect(result.url).toBe("https://github.com/org/repo/pull/42");
  });

  it("gets PR status", async () => {
    const pr = await connector.getPullRequest(repo, "42");
    expect(pr.status).toBe("open");
  });

  it("gets comments", async () => {
    const comments = await connector.getComments(repo, "42");
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe("Fix this");
    expect(comments[0].filePath).toBe("src/Foo.kt");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd backend && npm test -- --reporter=verbose connectors.test.ts
```

Expected: FAIL — `Cannot find module '../connectors/github.js'`

- [ ] **Step 3: Install Octokit**

```bash
cd backend && npm install @octokit/rest
```

- [ ] **Step 4: Write `backend/src/connectors/github.ts`**

```typescript
import { Octokit } from "@octokit/rest";
import type { Repository, VcsComment } from "../models/types.js";
import type { VcsConnector, CreatePrParams } from "./types.js";

export class GitHubConnector implements VcsConnector {
  private octokit(): Octokit {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN environment variable not set");
    return new Octokit({ auth: token });
  }

  private cfg(repo: Repository) {
    const { owner, repo: repoName } = repo.providerConfig;
    if (!owner || !repoName)
      throw new Error(`Repository ${repo.id} missing GitHub owner/repo config`);
    return { owner, repo: repoName };
  }

  async createBranch(
    repo: Repository,
    branchName: string,
    fromRef: string
  ): Promise<void> {
    const oc = this.octokit();
    const cfg = this.cfg(repo);
    const { data: ref } = await oc.git.getRef({
      ...cfg,
      ref: `heads/${fromRef}`,
    });
    await oc.git.createRef({
      ...cfg,
      ref: `refs/heads/${branchName}`,
      sha: ref.object.sha,
    });
  }

  async createPullRequest(
    repo: Repository,
    params: CreatePrParams
  ): Promise<{ id: string; url: string }> {
    const oc = this.octokit();
    const cfg = this.cfg(repo);
    const { data: pr } = await oc.pulls.create({
      ...cfg,
      title: params.title,
      body: params.description,
      head: params.sourceBranch,
      base: params.targetBranch,
    });
    return { id: String(pr.number), url: pr.html_url };
  }

  async getPullRequest(
    repo: Repository,
    prId: string
  ): Promise<{ status: "open" | "merged" | "declined"; url: string }> {
    const oc = this.octokit();
    const cfg = this.cfg(repo);
    const { data: pr } = await oc.pulls.get({
      ...cfg,
      pull_number: parseInt(prId, 10),
    });
    let status: "open" | "merged" | "declined" = "open";
    if (pr.merged) status = "merged";
    else if (pr.state === "closed") status = "declined";
    return { status, url: pr.html_url };
  }

  async getComments(
    repo: Repository,
    prId: string,
    since?: string
  ): Promise<VcsComment[]> {
    const oc = this.octokit();
    const cfg = this.cfg(repo);
    const { data: comments } = await oc.pulls.listReviewComments({
      ...cfg,
      pull_number: parseInt(prId, 10),
      since,
    });
    return comments.map((c) => ({
      id: String(c.id),
      author: c.user?.login ?? "unknown",
      body: c.body,
      filePath: c.path,
      lineNumber: c.line ?? undefined,
      createdAt: c.created_at,
    }));
  }

  async addComment(
    repo: Repository,
    prId: string,
    body: string
  ): Promise<void> {
    const oc = this.octokit();
    const cfg = this.cfg(repo);
    await oc.issues.createComment({
      ...cfg,
      issue_number: parseInt(prId, 10),
      body,
    });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd backend && npm test -- --reporter=verbose connectors.test.ts
```

Expected: PASS — all GitHub connector tests green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/connectors/github.ts backend/src/__tests__/connectors.test.ts backend/package.json backend/package-lock.json
git commit -m "feat(connectors): GitHub connector (branches, PRs, comments)"
```

---

### Task 5: Bitbucket Server Connector

**Files:**
- Create: `backend/src/connectors/bitbucket.ts`
- Modify: `backend/src/__tests__/connectors.test.ts`

- [ ] **Step 1: Add Bitbucket tests to `connectors.test.ts`**

Append a new describe block (using vi.stubGlobal for fetch):

```typescript
import { BitbucketConnector } from "../connectors/bitbucket.js";

const bbRepo: Repository = {
  id: "repo-bb",
  name: "bb-service",
  cloneUrl: "https://bitbucket.company.com/scm/PROJ/bb-service.git",
  provider: "bitbucket-server",
  providerConfig: {
    baseUrl: "https://bitbucket.company.com",
    projectKey: "PROJ",
    repoSlug: "bb-service",
  },
  defaultBranch: "main",
  createdAt: "",
  updatedAt: "",
};

describe("BitbucketConnector", () => {
  let connector: BitbucketConnector;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.BITBUCKET_TOKEN = "test-token";
    connector = new BitbucketConnector();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("creates a pull request", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: 5,
          links: { self: [{ href: "https://bitbucket.company.com/proj/repo/pull-requests/5" }] },
        }),
    });
    const result = await connector.createPullRequest(bbRepo, {
      title: "Add caching",
      description: "Caching layer",
      sourceBranch: "agent/proj-1/task-1",
      targetBranch: "main",
    });
    expect(result.id).toBe("5");
    expect(result.url).toContain("pull-requests/5");
  });

  it("fetches PR comments", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          values: [
            {
              id: 10,
              author: { name: "bob" },
              text: "Change this",
              createdDate: 1700000000000,
            },
          ],
          isLastPage: true,
        }),
    });
    const comments = await connector.getComments(bbRepo, "5");
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe("bob");
    expect(comments[0].body).toBe("Change this");
  });
});
```

- [ ] **Step 2: Run to verify new tests fail**

```bash
cd backend && npm test -- --reporter=verbose connectors.test.ts
```

Expected: FAIL — `Cannot find module '../connectors/bitbucket.js'`

- [ ] **Step 3: Write `backend/src/connectors/bitbucket.ts`**

```typescript
import type { Repository, VcsComment } from "../models/types.js";
import type { VcsConnector, CreatePrParams } from "./types.js";

export class BitbucketConnector implements VcsConnector {
  private headers(baseUrl?: string): Record<string, string> {
    const token = process.env.BITBUCKET_TOKEN;
    if (!token) throw new Error("BITBUCKET_TOKEN environment variable not set");
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private base(repo: Repository): string {
    const { baseUrl, projectKey, repoSlug } = repo.providerConfig;
    if (!baseUrl || !projectKey || !repoSlug)
      throw new Error(`Repo ${repo.id} missing Bitbucket Server config`);
    return `${baseUrl}/rest/api/1.0/projects/${projectKey}/repos/${repoSlug}`;
  }

  async createBranch(
    repo: Repository,
    branchName: string,
    fromRef: string
  ): Promise<void> {
    const url = `${this.base(repo)}/branches`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ name: branchName, startPoint: fromRef }),
    });
    if (!res.ok) {
      throw new Error(`Bitbucket createBranch failed: ${res.status}`);
    }
  }

  async createPullRequest(
    repo: Repository,
    params: CreatePrParams
  ): Promise<{ id: string; url: string }> {
    const { projectKey, repoSlug } = repo.providerConfig;
    const url = `${this.base(repo)}/pull-requests`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        title: params.title,
        description: params.description,
        fromRef: {
          id: `refs/heads/${params.sourceBranch}`,
          repository: {
            slug: repoSlug,
            project: { key: projectKey },
          },
        },
        toRef: {
          id: `refs/heads/${params.targetBranch}`,
          repository: {
            slug: repoSlug,
            project: { key: projectKey },
          },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Bitbucket createPullRequest failed: ${res.status}`);
    }
    const data = (await res.json()) as {
      id: number;
      links: { self: Array<{ href: string }> };
    };
    return { id: String(data.id), url: data.links.self[0].href };
  }

  async getPullRequest(
    repo: Repository,
    prId: string
  ): Promise<{ status: "open" | "merged" | "declined"; url: string }> {
    const res = await fetch(`${this.base(repo)}/pull-requests/${prId}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Bitbucket getPullRequest failed: ${res.status}`);
    const data = (await res.json()) as {
      state: string;
      links: { self: Array<{ href: string }> };
    };
    let status: "open" | "merged" | "declined" = "open";
    if (data.state === "MERGED") status = "merged";
    else if (data.state === "DECLINED") status = "declined";
    return { status, url: data.links.self[0].href };
  }

  async getComments(
    repo: Repository,
    prId: string,
    since?: string
  ): Promise<VcsComment[]> {
    const url = `${this.base(repo)}/pull-requests/${prId}/activities?limit=100`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Bitbucket getComments failed: ${res.status}`);
    const data = (await res.json()) as {
      values: Array<{
        id: number;
        author?: { name?: string; displayName?: string };
        text?: string;
        comment?: { text: string };
        createdDate: number;
      }>;
    };
    const sinceMs = since ? new Date(since).getTime() : 0;
    return data.values
      .filter(
        (v) => (v.text ?? v.comment?.text) && v.createdDate > sinceMs
      )
      .map((v) => ({
        id: String(v.id),
        author: v.author?.displayName ?? v.author?.name ?? "unknown",
        body: v.text ?? v.comment?.text ?? "",
        createdAt: new Date(v.createdDate).toISOString(),
      }));
  }

  async addComment(
    repo: Repository,
    prId: string,
    body: string
  ): Promise<void> {
    const url = `${this.base(repo)}/pull-requests/${prId}/comments`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ text: body }),
    });
    if (!res.ok) throw new Error(`Bitbucket addComment failed: ${res.status}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && npm test -- --reporter=verbose connectors.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/connectors/bitbucket.ts backend/src/__tests__/connectors.test.ts
git commit -m "feat(connectors): Bitbucket Server connector (REST API v1.0)"
```

---

### Task 6: JIRA Server Connector

**Files:**
- Create: `backend/src/connectors/jira.ts`

- [ ] **Step 1: Write `backend/src/connectors/jira.ts`**

```typescript
// JIRA Server REST API v2 — read-only connector

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  status: string;
  assignee?: string;
  labels: string[];
}

function headers(): Record<string, string> {
  const token = process.env.JIRA_TOKEN;
  const baseUrl = process.env.JIRA_BASE_URL;
  if (!token) throw new Error("JIRA_TOKEN environment variable not set");
  if (!baseUrl) throw new Error("JIRA_BASE_URL environment variable not set");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function baseUrl(): string {
  const url = process.env.JIRA_BASE_URL;
  if (!url) throw new Error("JIRA_BASE_URL not set");
  return url.replace(/\/$/, "");
}

export async function searchIssues(jql: string, maxResults = 20): Promise<JiraIssue[]> {
  const url = `${baseUrl()}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=summary,description,status,assignee,labels`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`JIRA search failed: ${res.status}`);
  const data = (await res.json()) as {
    issues: Array<{
      key: string;
      fields: {
        summary: string;
        description?: string;
        status: { name: string };
        assignee?: { displayName: string };
        labels?: string[];
      };
    }>;
  };
  return data.issues.map((issue) => ({
    key: issue.key,
    summary: issue.fields.summary,
    description: issue.fields.description ?? "",
    status: issue.fields.status.name,
    assignee: issue.fields.assignee?.displayName,
    labels: issue.fields.labels ?? [],
  }));
}

export async function getIssue(issueKey: string): Promise<JiraIssue> {
  const url = `${baseUrl()}/rest/api/2/issue/${issueKey}?fields=summary,description,status,assignee,labels`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`JIRA getIssue ${issueKey} failed: ${res.status}`);
  const data = (await res.json()) as {
    key: string;
    fields: {
      summary: string;
      description?: string;
      status: { name: string };
      assignee?: { displayName: string };
      labels?: string[];
    };
  };
  return {
    key: data.key,
    summary: data.fields.summary,
    description: data.fields.description ?? "",
    status: data.fields.status.name,
    assignee: data.fields.assignee?.displayName,
    labels: data.fields.labels ?? [],
  };
}

/** Format a list of issues as context for the master agent prompt */
export function formatIssuesAsContext(issues: JiraIssue[]): string {
  return issues
    .map(
      (i) =>
        `## ${i.key}: ${i.summary}\n**Status:** ${i.status}\n\n${i.description}`
    )
    .join("\n\n---\n\n");
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/connectors/jira.ts
git commit -m "feat(connectors): JIRA Server connector (search + get issue)"
```

---

### Task 7: Debounce Engine

**Files:**
- Create: `backend/src/debounce/strategies.ts`
- Create: `backend/src/debounce/engine.ts`
- Create: `backend/src/__tests__/debounce.test.ts`

- [ ] **Step 1: Write `backend/src/debounce/strategies.ts`**

```typescript
import type { DebounceConfig } from "../models/types.js";

export const DEFAULT_DEBOUNCE_CONFIG: DebounceConfig = {
  strategy: "timer",
  delayMs: 10 * 60 * 1000, // 10 minutes
};

export function resolveConfig(config: Partial<DebounceConfig>): DebounceConfig {
  return { ...DEFAULT_DEBOUNCE_CONFIG, ...config };
}
```

- [ ] **Step 2: Write the failing test**

Create `backend/src/__tests__/debounce.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DebounceEngine } from "../debounce/engine.js";

describe("DebounceEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onFire after the configured delay", async () => {
    const onFire = vi.fn().mockResolvedValue(undefined);
    const engine = new DebounceEngine({ strategy: "timer", delayMs: 5000 }, onFire);

    engine.notify("pr-1");

    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    await vi.runAllTimersAsync();
    expect(onFire).toHaveBeenCalledWith("pr-1");
  });

  it("resets the timer when a new notification arrives", async () => {
    const onFire = vi.fn().mockResolvedValue(undefined);
    const engine = new DebounceEngine({ strategy: "timer", delayMs: 5000 }, onFire);

    engine.notify("pr-1");
    vi.advanceTimersByTime(3000);
    engine.notify("pr-1"); // reset
    vi.advanceTimersByTime(3000); // 3s after reset — should NOT fire yet
    await vi.runAllTimersAsync();
    expect(onFire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000); // 5s after last notify — fires now
    await vi.runAllTimersAsync();
    expect(onFire).toHaveBeenCalledOnce();
  });

  it("triggerNow fires immediately and cancels the timer", async () => {
    const onFire = vi.fn().mockResolvedValue(undefined);
    const engine = new DebounceEngine({ strategy: "timer", delayMs: 5000 }, onFire);

    engine.notify("pr-1");
    await engine.triggerNow("pr-1");
    expect(onFire).toHaveBeenCalledWith("pr-1");

    // Timer should be cancelled — no second call after delay
    vi.advanceTimersByTime(10000);
    await vi.runAllTimersAsync();
    expect(onFire).toHaveBeenCalledOnce();
  });

  it("handles multiple PRs independently", async () => {
    const onFire = vi.fn().mockResolvedValue(undefined);
    const engine = new DebounceEngine({ strategy: "timer", delayMs: 1000 }, onFire);

    engine.notify("pr-1");
    engine.notify("pr-2");
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();
    expect(onFire).toHaveBeenCalledTimes(2);
    expect(onFire).toHaveBeenCalledWith("pr-1");
    expect(onFire).toHaveBeenCalledWith("pr-2");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd backend && npm test -- --reporter=verbose debounce.test.ts
```

Expected: FAIL — `Cannot find module '../debounce/engine.js'`

- [ ] **Step 4: Write `backend/src/debounce/engine.ts`**

```typescript
import type { DebounceConfig } from "../models/types.js";

/**
 * Manages per-PR debounce timers. When a PR receives a review comment,
 * call notify(prId). The onFire callback is invoked after delayMs of
 * inactivity. Call triggerNow(prId) to bypass the timer immediately.
 *
 * On backend restart: reconstruct by calling notify() for each PR that
 * has pending comments. The DebounceEngine itself is stateless across
 * restarts — the store drives reconstruction.
 */
export class DebounceEngine {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private config: DebounceConfig,
    private onFire: (prId: string) => Promise<void>
  ) {}

  notify(prId: string): void {
    // Cancel existing timer, restart from zero
    const existing = this.timers.get(prId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(prId);
      void this.onFire(prId);
    }, this.config.delayMs);

    this.timers.set(prId, timer);
  }

  async triggerNow(prId: string): Promise<void> {
    const existing = this.timers.get(prId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(prId);
    }
    await this.onFire(prId);
  }

  cancel(prId: string): void {
    const existing = this.timers.get(prId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(prId);
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd backend && npm test -- --reporter=verbose debounce.test.ts
```

Expected: PASS — all 4 tests green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/debounce/strategies.ts backend/src/debounce/engine.ts backend/src/__tests__/debounce.test.ts
git commit -m "feat(connectors): debounce engine (timer-based, per-PR, triggerNow for manual trigger)"
```

---

### Task 8: Task Dispatcher

**Files:**
- Create: `backend/src/orchestrator/taskDispatcher.ts`

- [ ] **Step 1: Write `backend/src/orchestrator/taskDispatcher.ts`**

```typescript
import { randomUUID } from "crypto";
import Dockerode from "dockerode";
import { getProject, updateProject } from "../store/projects.js";
import {
  insertAgentSession,
  updateAgentSession,
} from "../store/agents.js";
import {
  insertPullRequest,
} from "../store/pullRequests.js";
import { getRepository } from "../store/repositories.js";
import {
  createSubAgentContainer,
  startContainer,
  removeContainer,
  watchContainerExit,
} from "./containerManager.js";
import { SubAgentBridge } from "../agents/subAgentBridge.js";
import { getConnector } from "../connectors/types.js";
import { config } from "../config.js";
import type { PlanTask } from "../models/types.js";

/**
 * Dispatches one sub-agent container per PlanTask.
 * All tasks launch in parallel.
 * When a task completes, creates a PR on the VCS.
 * When a task fails, marks it failed and surface to the project status.
 */
export async function dispatchTasks(
  docker: Dockerode,
  projectId: string
): Promise<void> {
  const project = getProject(projectId);
  if (!project?.plan) {
    throw new Error(`Project ${projectId} has no approved plan`);
  }

  const tasks = project.plan.tasks.filter((t) => t.status === "pending");

  // Launch all containers in parallel
  await Promise.allSettled(
    tasks.map((task) => runTask(docker, projectId, task))
  );

  // Check final outcome
  const updated = getProject(projectId)!;
  const allDone = updated.plan!.tasks.every((t) =>
    ["completed", "failed", "cancelled"].includes(t.status)
  );
  const anyFailed = updated.plan!.tasks.some((t) => t.status === "failed");

  if (allDone) {
    updateProject(projectId, {
      status: anyFailed ? "failed" : "completed",
    });
  }
}

async function runTask(
  docker: Dockerode,
  projectId: string,
  task: PlanTask
): Promise<void> {
  const sessionId = randomUUID();
  const repo = getRepository(task.repositoryId);
  if (!repo) {
    console.error(`[taskDispatcher] Repository not found: ${task.repositoryId}`);
    markTaskFailed(projectId, task.id);
    return;
  }

  const branchName = `agent/${projectId}/${task.id}`;

  // Create agent session record
  const session = {
    id: sessionId,
    projectId,
    type: "sub" as const,
    repositoryId: task.repositoryId,
    taskId: task.id,
    status: "starting" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  insertAgentSession(session);
  markTaskStatus(projectId, task.id, "executing");

  let containerId: string | undefined;
  try {
    containerId = await createSubAgentContainer(docker, {
      sessionId,
      repoCloneUrl: repo.cloneUrl,
      branchName,
      anthropicApiKeyPath: config.anthropicApiKeyPath,
    });

    await startContainer(docker, containerId);
    updateAgentSession(sessionId, { containerId, status: "running" });

    const bridge = new SubAgentBridge();
    await bridge.attach(docker, containerId);

    // Send task instructions to the sub-agent
    const prompt = buildPrompt(task, repo.cloneUrl, branchName);
    bridge.send({ type: "session/prompt", text: prompt });

    // Wait for completion or timeout
    await waitForCompletion(bridge, sessionId, config.subAgentTimeoutMs);

    updateAgentSession(sessionId, { status: "completed" });
    markTaskStatus(projectId, task.id, "completed");

    // Create PR
    await createPr(projectId, sessionId, repo, branchName);
  } catch (err) {
    console.error(`[taskDispatcher] Task ${task.id} failed:`, err);
    updateAgentSession(sessionId, { status: "failed" });
    markTaskFailed(projectId, task.id);
  } finally {
    if (containerId) {
      // Keep container alive for debounce fix runs — idle timeout handled separately
      watchContainerExit(docker, containerId, (code) => {
        if (code !== 0) {
          updateAgentSession(sessionId, { status: "failed" });
          markTaskFailed(projectId, task.id);
        }
      }).catch(() => {});
    }
  }
}

function waitForCompletion(
  bridge: SubAgentBridge,
  sessionId: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Sub-agent ${sessionId} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    bridge.on("message", (msg) => {
      if (
        msg.type === "session/update" &&
        (msg as { status?: string }).status === "completed"
      ) {
        clearTimeout(timer);
        resolve();
      }
    });

    bridge.on("end", () => {
      clearTimeout(timer);
      resolve();
    });

    bridge.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function createPr(
  projectId: string,
  agentSessionId: string,
  repo: import("../models/types.js").Repository,
  branchName: string
): Promise<void> {
  const connector = getConnector(repo.provider);
  const { id: externalId, url } = await connector.createPullRequest(repo, {
    title: `[Agent] Changes for project ${projectId}`,
    description: `Automated changes created by multi-agent harness.\n\nProject: ${projectId}`,
    sourceBranch: branchName,
    targetBranch: repo.defaultBranch,
  });

  insertPullRequest({
    id: randomUUID(),
    projectId,
    repositoryId: repo.id,
    agentSessionId,
    provider: repo.provider,
    externalId,
    url,
    branch: branchName,
    status: "open",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  console.log(`[taskDispatcher] PR created: ${url}`);
}

function buildPrompt(
  task: PlanTask,
  cloneUrl: string,
  branchName: string
): string {
  return `You are a coding agent. Follow these instructions exactly:

1. Read the API key from /run/secrets/api-key if needed.
2. Clone the repository: ${cloneUrl}
3. Create and checkout branch: ${branchName}
4. Implement the following task:

${task.description}

5. Commit all changes with a clear commit message.
6. Push the branch to origin.
7. When done, send: {"type":"session/update","status":"completed"}

If you encounter an error you cannot recover from, send: {"type":"session/update","status":"failed","error":"<reason>"}`;
}

function markTaskStatus(
  projectId: string,
  taskId: string,
  status: PlanTask["status"]
): void {
  const project = getProject(projectId);
  if (!project?.plan) return;
  const tasks = project.plan.tasks.map((t) =>
    t.id === taskId ? { ...t, status } : t
  );
  updateProject(projectId, { plan: { ...project.plan, tasks } });
}

function markTaskFailed(projectId: string, taskId: string): void {
  markTaskStatus(projectId, taskId, "failed");
}

/**
 * Re-prompts the sub-agent container for a PR with batched review comments.
 * Called by the debounce engine after the timer fires or a manual trigger.
 */
export async function runFixRun(docker: Dockerode, prId: string): Promise<void> {
  const { getPullRequest, getPendingComments, markCommentsStatus } = await import(
    "../store/pullRequests.js"
  );
  const { getAgentSession } = await import("../store/agents.js");

  const pr = getPullRequest(prId);
  if (!pr) {
    console.warn(`[runFixRun] PR ${prId} not found, skipping`);
    return;
  }
  const session = getAgentSession(pr.agentSessionId);
  if (!session?.containerId) {
    console.warn(`[runFixRun] No running container for PR ${prId}, skipping`);
    return;
  }

  const comments = getPendingComments(prId);
  if (comments.length === 0) {
    console.log(`[runFixRun] No pending comments for PR ${prId}`);
    return;
  }
  markCommentsStatus(comments.map((c) => c.id), "batched");

  const fixPrompt = [
    "Please address the following review comments on the pull request:",
    "",
    ...comments.map((c, i) => {
      const location = c.filePath
        ? `${c.filePath}${c.lineNumber != null ? `:${c.lineNumber}` : ""}`
        : "general";
      return `${i + 1}. **${c.author}** (${location}):\n   ${c.body}`;
    }),
    "",
    "Make the necessary code changes, commit them, and push to the same branch.",
    'When done, send: {"type":"session/update","status":"completed"}',
  ].join("\n");

  const bridge = new SubAgentBridge();
  await bridge.attach(docker, session.containerId);
  bridge.send({ type: "session/prompt", text: fixPrompt });

  try {
    await waitForCompletion(bridge, session.id, 30 * 60 * 1000);
    markCommentsStatus(comments.map((c) => c.id), "fixed");
    console.log(`[runFixRun] Fix run complete for PR ${prId}`);
  } catch (err) {
    console.error(`[runFixRun] Fix run failed for PR ${prId}:`, err);
    // Comments remain "batched" — operator can inspect logs and retry via manual trigger
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Wire taskDispatcher into projects approve endpoint**

In `backend/src/api/projects.ts`, replace the `// TODO(plan-3)` comment with:

```typescript
import { dispatchTasks } from "../orchestrator/taskDispatcher.js";
// ...
// Inside POST /:id/approve:
void dispatchTasks(docker, req.params.id);
```

The `projectsRouter` function needs `docker` passed in. Update signature:

```typescript
export function projectsRouter(dataDir: string, docker: Dockerode): Router {
```

Update `backend/src/api/routes.ts` to pass docker:

```typescript
export function createRouter(dataDir: string, docker: Dockerode): Router {
  // ...
  router.use("/projects", projectsRouter(dataDir, docker));
```

Update `backend/src/index.ts` to pass docker to `createRouter`:

```typescript
app.use("/api", createRouter(config.dataDir, docker));
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/orchestrator/taskDispatcher.ts backend/src/api/projects.ts backend/src/api/routes.ts backend/src/index.ts
git commit -m "feat(connectors): task dispatcher (spawn sub-agents → create PRs on completion)"
```

---

### Task 9: API Routes (JIRA, PRs, Webhooks)

**Files:**
- Create: `backend/src/api/jira.ts`
- Create: `backend/src/api/pullRequests.ts`
- Create: `backend/src/api/webhooks.ts`
- Modify: `backend/src/api/routes.ts`

- [ ] **Step 1: Write `backend/src/api/jira.ts`**

```typescript
import { Router } from "express";
import { searchIssues, getIssue } from "../connectors/jira.js";

export function jiraRouter(): Router {
  const router = Router();

  // Search issues by JQL
  router.get("/search", async (req, res) => {
    const jql = req.query.jql as string;
    if (!jql) return res.status(400).json({ error: "jql param required" });
    try {
      const issues = await searchIssues(jql);
      return res.json(issues);
    } catch (err) {
      return res.status(502).json({ error: String(err) });
    }
  });

  // Get single issue
  router.get("/issues/:key", async (req, res) => {
    try {
      const issue = await getIssue(req.params.key);
      return res.json(issue);
    } catch (err) {
      return res.status(502).json({ error: String(err) });
    }
  });

  return router;
}
```

- [ ] **Step 2: Write `backend/src/api/pullRequests.ts`**

```typescript
import { Router } from "express";
import { listPullRequestsByProject, getPendingComments } from "../store/pullRequests.js";
import type { DebounceEngine } from "../debounce/engine.js";

export function pullRequestsRouter(debounce: DebounceEngine): Router {
  const router = Router();

  // List PRs for a project
  router.get("/projects/:projectId/prs", (req, res) => {
    const prs = listPullRequestsByProject(req.params.projectId);
    res.json(prs);
  });

  // List pending comments for a PR
  router.get("/projects/:projectId/prs/:prId/comments", (req, res) => {
    const comments = getPendingComments(req.params.prId);
    res.json(comments);
  });

  // Manual fix trigger — bypasses debounce timer
  router.post("/projects/:projectId/prs/:prId/fix", async (req, res) => {
    try {
      await debounce.triggerNow(req.params.prId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
```

- [ ] **Step 3: Write `backend/src/api/webhooks.ts`**

```typescript
import { Router } from "express";
import { randomUUID } from "crypto";
import { upsertReviewComment } from "../store/pullRequests.js";
import type { DebounceEngine } from "../debounce/engine.js";

// GitHub sends PR review and comment events to this endpoint.
// Validate with GITHUB_WEBHOOK_SECRET if set; skip validation for MVP.

interface GitHubCommentEvent {
  action: string;
  pull_request?: { number: number };
  comment?: {
    id: number;
    user: { login: string };
    body: string;
    path?: string;
    line?: number;
    created_at: string;
  };
}

// Map from GitHub PR number to our internal PR id
// In production, look this up from the pull_requests table by externalId
import { listPullRequestsByProject } from "../store/pullRequests.js";
import { listProjects } from "../store/projects.js";

function findInternalPrId(githubPrNumber: string): string | null {
  // Scan projects for a matching PR — acceptable for MVP volume
  for (const project of listProjects()) {
    const prs = listPullRequestsByProject(project.id);
    const match = prs.find((pr) => pr.externalId === githubPrNumber);
    if (match) return match.id;
  }
  return null;
}

export function webhooksRouter(debounce: DebounceEngine): Router {
  const router = Router();

  router.post("/github", (req, res) => {
    const event = req.headers["x-github-event"] as string;
    const body = req.body as GitHubCommentEvent;

    if (
      event === "pull_request_review_comment" &&
      body.action === "created" &&
      body.comment &&
      body.pull_request
    ) {
      const externalPrNumber = String(body.pull_request.number);
      const internalPrId = findInternalPrId(externalPrNumber);

      if (internalPrId) {
        const now = new Date().toISOString();
        upsertReviewComment({
          id: randomUUID(),
          pullRequestId: internalPrId,
          externalId: String(body.comment.id),
          author: body.comment.user.login,
          body: body.comment.body,
          filePath: body.comment.path,
          lineNumber: body.comment.line,
          status: "pending",
          receivedAt: body.comment.created_at,
          updatedAt: now,
        });

        // Notify debounce engine — will fire after configured delay
        debounce.notify(internalPrId);
      }
    }

    res.status(200).json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 4: Update `backend/src/api/routes.ts` to add new routes**

```typescript
import { Router } from "express";
import type Dockerode from "dockerode";
import { projectsRouter } from "./projects.js";
import { repositoriesRouter } from "./repositories.js";
import { agentsRouter } from "./agents.js";
import { jiraRouter } from "./jira.js";
import { pullRequestsRouter } from "./pullRequests.js";
import { webhooksRouter } from "./webhooks.js";
import type { DebounceEngine } from "../debounce/engine.js";

export function createRouter(
  dataDir: string,
  docker: Dockerode,
  debounce: DebounceEngine
): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  router.use("/projects", projectsRouter(dataDir, docker));
  router.use("/repositories", repositoriesRouter());
  router.use("/agents", agentsRouter());
  router.use("/jira", jiraRouter());
  router.use("/webhooks", webhooksRouter(debounce));

  // Mount PR routes at top level (they use /projects/:projectId/prs pattern)
  router.use("/", pullRequestsRouter(debounce));

  return router;
}
```

- [ ] **Step 5: Update `backend/src/index.ts` to create debounce engine and pass it**

In `main()`, after Docker setup and before `createRouter`:

```typescript
import { DebounceEngine } from "./debounce/engine.js";
import { DEFAULT_DEBOUNCE_CONFIG } from "./debounce/strategies.js";
import { listAllPendingComments } from "./store/pullRequests.js";
import { runFixRun } from "./orchestrator/taskDispatcher.js";

// Create debounce engine — fires runFixRun when timer expires
const debounce = new DebounceEngine(
  DEFAULT_DEBOUNCE_CONFIG,
  (prId: string) => runFixRun(docker, prId)
);

// Reconstruct timers for PRs that had pending comments before restart
const pendingComments = listAllPendingComments();
const prIds = [...new Set(pendingComments.map((c) => c.prId))];
for (const prId of prIds) {
  debounce.notify(prId);
}
console.log(`[startup] Restored ${prIds.length} debounce timers from pending comments`);

app.use("/api", createRouter(config.dataDir, docker, debounce));
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/api/jira.ts backend/src/api/pullRequests.ts backend/src/api/webhooks.ts backend/src/api/routes.ts backend/src/index.ts
git commit -m "feat(connectors): JIRA, PR, and webhook API routes + debounce wiring"
```

---

### Task 10: Bitbucket Server Polling

**Files:**
- Create: `backend/src/connectors/bitbucketPoller.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Write `backend/src/connectors/bitbucketPoller.ts`**

```typescript
import { randomUUID } from "crypto";
import { listPullRequestsByProject } from "../store/pullRequests.js";
import { listProjects } from "../store/projects.js";
import { upsertReviewComment } from "../store/pullRequests.js";
import { getRepository } from "../store/repositories.js";
import { BitbucketConnector } from "./bitbucket.js";
import type { DebounceEngine } from "../debounce/engine.js";

const connector = new BitbucketConnector();

// Track last-polled timestamp per PR to avoid fetching old comments
const lastPolled = new Map<string, string>();

export function startBitbucketPoller(
  debounce: DebounceEngine,
  intervalMs = 60_000
): () => void {
  const timer = setInterval(() => {
    void poll(debounce);
  }, intervalMs);

  // Run immediately on startup
  void poll(debounce);

  return () => clearInterval(timer);
}

async function poll(debounce: DebounceEngine): Promise<void> {
  const projects = listProjects().filter((p) =>
    ["executing", "completed"].includes(p.status)
  );

  for (const project of projects) {
    const prs = listPullRequestsByProject(project.id).filter(
      (pr) => pr.provider === "bitbucket-server" && pr.status === "open"
    );

    for (const pr of prs) {
      try {
        const repo = getRepository(pr.repositoryId);
        if (!repo) continue;

        const since = lastPolled.get(pr.id);
        const comments = await connector.getComments(repo, pr.externalId, since);

        for (const comment of comments) {
          upsertReviewComment({
            id: randomUUID(),
            pullRequestId: pr.id,
            externalId: comment.id,
            author: comment.author,
            body: comment.body,
            filePath: comment.filePath,
            lineNumber: comment.lineNumber,
            status: "pending",
            receivedAt: comment.createdAt,
            updatedAt: new Date().toISOString(),
          });
          debounce.notify(pr.id);
        }

        if (comments.length > 0) {
          lastPolled.set(pr.id, new Date().toISOString());
        }
      } catch (err) {
        console.warn(`[bitbucketPoller] Error polling PR ${pr.id}:`, err);
      }
    }
  }
}
```

- [ ] **Step 2: Add poller startup to `backend/src/index.ts`**

Import and call after debounce engine init:

```typescript
import { startBitbucketPoller } from "./connectors/bitbucketPoller.js";

// Start Bitbucket Server polling (default 60s interval)
const stopPoller = startBitbucketPoller(debounce);

// Graceful shutdown
process.on("SIGTERM", () => {
  stopPoller();
  debounce.dispose();
  process.exit(0);
});
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/connectors/bitbucketPoller.ts backend/src/index.ts
git commit -m "feat(connectors): Bitbucket Server comment polling (60s interval, deduplication)"
```

---

### Task 11: Frontend PR Overview Page

**Files:**
- Create: `frontend/src/pages/PrOverview.tsx`
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add PR types + API methods to `frontend/src/lib/api.ts`**

Append to the api object:

```typescript
export interface PullRequest {
  id: string;
  projectId: string;
  repositoryId: string;
  provider: string;
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
  author: string;
  body: string;
  filePath?: string;
  lineNumber?: number;
  status: string;
  receivedAt: string;
}

// Add inside api object:
// prs: { ... }
```

Add to the `api` export:

```typescript
  prs: {
    list: (projectId: string) =>
      request<PullRequest[]>(`/projects/${projectId}/prs`),
    comments: (projectId: string, prId: string) =>
      request<ReviewComment[]>(`/projects/${projectId}/prs/${prId}/comments`),
    triggerFix: (projectId: string, prId: string) =>
      request<{ ok: boolean }>(`/projects/${projectId}/prs/${prId}/fix`, {
        method: "POST",
      }),
  },
```

- [ ] **Step 2: Write `frontend/src/pages/PrOverview.tsx`**

```typescript
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type PullRequest, type ReviewComment } from "../lib/api.js";

export default function PrOverview() {
  const { id } = useParams<{ id: string }>();
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [comments, setComments] = useState<Record<string, ReviewComment[]>>({});
  const [triggering, setTriggering] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const load = () => {
      api.prs.list(id).then(setPrs);
    };
    load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [id]);

  async function loadComments(prId: string) {
    if (!id) return;
    const c = await api.prs.comments(id, prId);
    setComments((prev) => ({ ...prev, [prId]: c }));
  }

  async function triggerFix(prId: string) {
    if (!id) return;
    setTriggering(prId);
    try {
      await api.prs.triggerFix(id, prId);
    } finally {
      setTriggering(null);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Pull Requests</h1>
      {prs.length === 0 ? (
        <p className="text-gray-400">No pull requests yet.</p>
      ) : (
        <div className="space-y-4">
          {prs.map((pr) => (
            <div
              key={pr.id}
              className="border border-gray-800 rounded-lg p-4"
            >
              <div className="flex justify-between items-start">
                <div>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-400 hover:text-blue-300 font-medium"
                  >
                    {pr.branch}
                  </a>
                  <p className="text-sm text-gray-500 mt-1">
                    {pr.provider} · {pr.status}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => loadComments(pr.id)}
                    className="text-xs border border-gray-700 px-2 py-1 rounded hover:bg-gray-800"
                  >
                    Load Comments
                  </button>
                  <button
                    onClick={() => triggerFix(pr.id)}
                    disabled={triggering === pr.id || pr.status !== "open"}
                    className="text-xs bg-blue-700 hover:bg-blue-600 disabled:opacity-50 px-2 py-1 rounded"
                  >
                    {triggering === pr.id ? "Triggering..." : "Fix Now"}
                  </button>
                </div>
              </div>

              {comments[pr.id] && (
                <div className="mt-3 space-y-2">
                  {comments[pr.id].length === 0 ? (
                    <p className="text-sm text-gray-500">No pending comments.</p>
                  ) : (
                    comments[pr.id].map((c) => (
                      <div
                        key={c.id}
                        className="bg-gray-900 rounded p-3 text-sm"
                      >
                        <div className="flex justify-between text-gray-400 mb-1">
                          <span className="font-medium text-white">
                            {c.author}
                          </span>
                          <span className="text-xs">{c.status}</span>
                        </div>
                        {c.filePath && (
                          <p className="text-xs text-gray-500 mb-1">
                            {c.filePath}
                            {c.lineNumber ? `:${c.lineNumber}` : ""}
                          </p>
                        )}
                        <p className="text-gray-300">{c.body}</p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add PR Overview route to `frontend/src/App.tsx`**

Add import and route:

```typescript
import PrOverview from "./pages/PrOverview.js";

// In <Routes>:
<Route path="/projects/:id/prs" element={<PrOverview />} />
```

Also add a nav link in the project context. In `frontend/src/App.tsx`, add to the existing layout as a link from project pages.

- [ ] **Step 4: Add nav link in Execution page to PRs**

In `frontend/src/pages/Execution.tsx`, add after the heading:

```typescript
import { Link } from "react-router-dom";

// Below <h1>:
<Link
  to={`/projects/${id}/prs`}
  className="text-blue-400 hover:text-blue-300 text-sm"
>
  View PRs →
</Link>
```

- [ ] **Step 5: Verify frontend builds**

```bash
cd frontend && npm run build
```

Expected: `dist/` built successfully.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/PrOverview.tsx frontend/src/App.tsx frontend/src/lib/api.ts frontend/src/pages/Execution.tsx
git commit -m "feat(connectors): PR Overview page with comment list + manual fix trigger"
```

---

### Task 12: Full System Smoke Test

**Files:** No new files.

- [ ] **Step 1: Run the full backend test suite**

```bash
cd backend && npm test
```

Expected: all tests pass.

- [ ] **Step 2: Start all services**

```bash
docker compose up --build
```

Expected: backend + docker-proxy + frontend start without errors. Logs show debounce timer reconstruction and Bitbucket poller startup.

- [ ] **Step 3: Create a project and approve a plan**

1. Open `http://localhost:8080`
2. Create a repository in Settings
3. Create a new project
4. Chat with the agent, ask it to write a plan
5. Navigate to Plan Approval and approve

Expected: Status changes to "executing", sub-agent container starts.

- [ ] **Step 4: Verify a PR is created**

Navigate to PR Overview.

Expected: PR appears after sub-agent completes.

- [ ] **Step 5: Test manual fix trigger**

Click "Fix Now" on the PR.

Expected: `{ ok: true }` returned, debounce engine fires immediately.

- [ ] **Step 6: Stop services**

```bash
docker compose down
```

- [ ] **Step 7: Final commit**

```bash
git commit --allow-empty -m "chore(connectors): full system smoke test passed"
```
