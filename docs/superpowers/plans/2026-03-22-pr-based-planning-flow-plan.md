# PR-Based Planning Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Note for containerised sub-agents:** Tasks are executed by Docker sub-agents. Each sub-agent receives its task via the TASK_DESCRIPTION environment variable. The plan file is present on the branch at `docs/superpowers/plans/` for full context.

**Goal:** Replace the in-UI plan approval flow with a GitHub/Bitbucket PR-based workflow that mirrors the superpowers brainstorm → spec → plan cycle, with LGTM comment gates controlling progression.

**Architecture:** The master agent uses a new `write_planning_document` custom tool to commit spec/plan Markdown to a planning branch and open a single PR. A new polling path detects LGTM comments and resumes the master agent session via `[SYSTEM]` messages. Sub-agents receive a TDD preamble prepended to every task description.

**Tech Stack:** TypeScript, better-sqlite3, @mariozechner/pi-coding-agent, @sinclair/typebox, @octokit/rest, Bitbucket Server Files API, vitest, React/TypeScript

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `backend/src/models/types.ts` | Modify | Add new Project fields and status values; remove Plan.approved |
| `backend/src/store/db.ts` | Modify | Add migration for 3 new columns + status migration |
| `backend/src/store/projects.ts` | Modify | Handle new columns in CRUD; add `listProjectsAwaitingLgtm()` |
| `backend/src/__tests__/projects.test.ts` | Modify | Update existing tests; add new-field round-trip tests |
| `backend/src/connectors/types.ts` | Modify | Add `commitFile` to VcsConnector interface |
| `backend/src/connectors/github.ts` | Modify | Implement `commitFile` via GitHub Contents API |
| `backend/src/connectors/bitbucket.ts` | Modify | Implement `commitFile` via Bitbucket Server Files API |
| `backend/src/__tests__/connectors.test.ts` | Create | Unit tests for `commitFile` behaviour |
| `backend/src/agents/planningTool.ts` | Create | Tool factory: `createWritePlanningDocumentTool`, `slugify`, `buildPlanningBranch`, `buildPlanningFilePath` |
| `backend/src/__tests__/planningTool.test.ts` | Create | Unit tests for slug/branch/path helpers |
| `backend/src/agents/masterAgent.ts` | Modify | Accept `customTools` param and pass to `createAgentSession` |
| `backend/src/api/websocket.ts` | Modify | New system prompt; export `getOrInitAgent`; pass tool; remove plan_ready logic |
| `backend/src/polling.ts` | Modify | Add `pollPlanningPrs()` for LGTM detection; integrate into polling loop |
| `backend/src/__tests__/polling.test.ts` | Create | Unit tests for LGTM detection logic |
| `backend/src/orchestrator/taskDispatcher.ts` | Modify | Add `buildTaskPrompt()`; update dispatch guard; use planningBranch |
| `backend/src/api/projects.ts` | Modify | Remove approve route; add primaryRepositoryId; validate repos not empty |
| `sub-agent/runner.mjs` | Modify | Add TASK_ID env; commit session log unconditionally in finally |
| `frontend/src/lib/api.ts` | Modify | Add new status values + Project fields; remove Plan.approved; remove projects.approve |
| `frontend/src/pages/NewProject.tsx` | Modify | Add primary repo selector (auto/dropdown) |
| `frontend/src/pages/Chat.tsx` | Modify | Remove plan_ready handler |
| `frontend/src/pages/Dashboard.tsx` | Modify | Add status colors and labels for 4 new statuses |
| `frontend/src/pages/PlanApproval.tsx` | Modify | Replace with redirect to /projects/:id/chat |
| `frontend/src/App.tsx` | Modify | Keep route; PlanApproval now just redirects |

---

### Task 1: Data Model & DB Migration

**Files:**
- Modify: `backend/src/models/types.ts`
- Modify: `backend/src/store/db.ts`
- Modify: `backend/src/store/projects.ts`
- Modify: `backend/src/__tests__/projects.test.ts`

- [ ] **Step 1: Write failing tests for new Project fields**

Add to `backend/src/__tests__/projects.test.ts` (inside the existing `"projects store"` describe block, after the last `it()`):

```typescript
  it("stores and retrieves primaryRepositoryId, planningBranch, planningPr", () => {
    const proj: Project = {
      ...baseProject,
      id: "proj-pr",
      primaryRepositoryId: "repo-1",
      planningBranch: "harness/add-auth-a3b2c",
      planningPr: { number: 7, url: "https://github.com/org/repo/pull/7" },
    };
    insertProject(proj);
    const found = getProject("proj-pr");
    expect(found?.primaryRepositoryId).toBe("repo-1");
    expect(found?.planningBranch).toBe("harness/add-auth-a3b2c");
    expect(found?.planningPr).toEqual({ number: 7, url: "https://github.com/org/repo/pull/7" });
  });

  it("stores planningPr with approval timestamps", () => {
    const proj: Project = {
      ...baseProject,
      id: "proj-pr2",
      primaryRepositoryId: "repo-1",
      planningPr: {
        number: 8,
        url: "https://github.com/org/repo/pull/8",
        specApprovedAt: "2026-03-22T10:00:00.000Z",
        planApprovedAt: "2026-03-22T12:00:00.000Z",
      },
    };
    insertProject(proj);
    const found = getProject("proj-pr2");
    expect(found?.planningPr?.specApprovedAt).toBe("2026-03-22T10:00:00.000Z");
    expect(found?.planningPr?.planApprovedAt).toBe("2026-03-22T12:00:00.000Z");
  });

  it("listProjectsAwaitingLgtm returns only projects in awaiting states", () => {
    insertProject({ ...baseProject, id: "p-brainstorm", status: "brainstorming" });
    insertProject({ ...baseProject, id: "p-spec", status: "awaiting_spec_approval",
      primaryRepositoryId: "repo-1" });
    insertProject({ ...baseProject, id: "p-plan", status: "awaiting_plan_approval",
      primaryRepositoryId: "repo-1" });
    insertProject({ ...baseProject, id: "p-exec", status: "executing" });
    const waiting = listProjectsAwaitingLgtm();
    expect(waiting.map(p => p.id).sort()).toEqual(["p-plan", "p-spec"]);
  });
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd backend && npx vitest run src/__tests__/projects.test.ts
```

Expected: FAIL — `primaryRepositoryId is not a property of Project`, `listProjectsAwaitingLgtm is not a function`

- [ ] **Step 3: Update `backend/src/models/types.ts`**

Replace the entire `Project` and `Plan` interfaces:

```typescript
export interface Project {
  id: string;
  name: string;
  status:
    | "brainstorming"
    | "spec_in_progress"
    | "awaiting_spec_approval"
    | "plan_in_progress"
    | "awaiting_plan_approval"
    | "executing"
    | "completed"
    | "failed"
    | "cancelled";
  source: {
    type: "jira" | "freeform" | "github";
    jiraTickets?: string[];
    githubIssues?: string[];
    freeformDescription?: string;
  };
  repositoryIds: string[];
  primaryRepositoryId?: string;
  planningBranch?: string;
  planningPr?: {
    number: number;
    url: string;
    specApprovedAt?: string;
    planApprovedAt?: string;
  };
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
}
```

- [ ] **Step 4: Update `backend/src/store/db.ts` — add migration**

Inside the `migrate()` function, add these statements at the end of the `database.exec(...)` block (after all `CREATE INDEX` lines, before the closing backtick):

```sql
    -- PR-based planning flow additions (2026-03-22)
    -- ALTER TABLE is idempotent only when the column doesn't exist.
    -- We wrap each in a separate try via a migration guard table.
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
```

Then add this code **after** the `database.exec(...)` call:

```typescript
  // Run idempotent ALTER TABLE migrations
  const addColumnIfMissing = (table: string, column: string, def: string) => {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    }
  };

  addColumnIfMissing("projects", "primary_repository_id", "TEXT");
  addColumnIfMissing("projects", "planning_branch", "TEXT");
  addColumnIfMissing("projects", "planning_pr_json", "TEXT");

  // Backfill primary_repository_id from first repositoryId
  database.exec(`
    UPDATE projects
    SET primary_repository_id = json_extract(repository_ids, '$[0]')
    WHERE primary_repository_id IS NULL
      AND json_array_length(repository_ids) > 0
  `);

  // Move any stale awaiting_approval projects to failed
  database.exec(`
    UPDATE projects SET status = 'failed' WHERE status = 'awaiting_approval'
  `);
```

- [ ] **Step 5: Update `backend/src/store/projects.ts`**

Replace the entire file with:

```typescript
import { getDb } from "./db.js";
import type { Project, Plan } from "../models/types.js";

interface ProjectRow {
  id: string; name: string; status: string; source_type: string;
  source_json: string; repository_ids: string; plan_json: string | null;
  master_session_path: string; created_at: string; updated_at: string;
  primary_repository_id: string | null;
  planning_branch: string | null;
  planning_pr_json: string | null;
}

function fromRow(row: ProjectRow): Project {
  const source = JSON.parse(row.source_json) as Project["source"];
  return {
    id: row.id, name: row.name, status: row.status as Project["status"],
    source, repositoryIds: JSON.parse(row.repository_ids) as string[],
    primaryRepositoryId: row.primary_repository_id ?? undefined,
    planningBranch: row.planning_branch ?? undefined,
    planningPr: row.planning_pr_json ? JSON.parse(row.planning_pr_json) : undefined,
    plan: row.plan_json ? (JSON.parse(row.plan_json) as Plan) : undefined,
    masterSessionPath: row.master_session_path,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function insertProject(project: Project): void {
  getDb().prepare(`
    INSERT INTO projects
      (id, name, status, source_type, source_json, repository_ids, plan_json,
       master_session_path, primary_repository_id, planning_branch, planning_pr_json,
       created_at, updated_at)
    VALUES
      (@id, @name, @status, @sourceType, @sourceJson, @repositoryIds, @planJson,
       @masterSessionPath, @primaryRepositoryId, @planningBranch, @planningPrJson,
       @createdAt, @updatedAt)
  `).run({
    id: project.id, name: project.name, status: project.status,
    sourceType: project.source.type, sourceJson: JSON.stringify(project.source),
    repositoryIds: JSON.stringify(project.repositoryIds),
    planJson: project.plan ? JSON.stringify(project.plan) : null,
    masterSessionPath: project.masterSessionPath,
    primaryRepositoryId: project.primaryRepositoryId ?? null,
    planningBranch: project.planningBranch ?? null,
    planningPrJson: project.planningPr ? JSON.stringify(project.planningPr) : null,
    createdAt: project.createdAt, updatedAt: project.updatedAt,
  });
}

export function getProject(id: string): Project | null {
  const row = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  return row ? fromRow(row) : null;
}

export function listProjects(): Project[] {
  return (getDb().prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as ProjectRow[]).map(fromRow);
}

export function listProjectsAwaitingLgtm(): Project[] {
  return (getDb().prepare(
    "SELECT * FROM projects WHERE status IN ('awaiting_spec_approval', 'awaiting_plan_approval')"
  ).all() as ProjectRow[]).map(fromRow);
}

export function deleteProject(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM messages WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM agent_sessions WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM pull_requests WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

export function updateProject(id: string, updates: Partial<Omit<Project, "id">>): void {
  const existing = getProject(id);
  if (!existing) throw new Error(`Project not found: ${id}`);
  const merged = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  getDb().prepare(`
    UPDATE projects
    SET name=@name, status=@status, source_type=@sourceType, source_json=@sourceJson,
        repository_ids=@repositoryIds, plan_json=@planJson,
        master_session_path=@masterSessionPath,
        primary_repository_id=@primaryRepositoryId,
        planning_branch=@planningBranch,
        planning_pr_json=@planningPrJson,
        updated_at=@updatedAt
    WHERE id=@id
  `).run({
    id: merged.id, name: merged.name, status: merged.status,
    sourceType: merged.source.type, sourceJson: JSON.stringify(merged.source),
    repositoryIds: JSON.stringify(merged.repositoryIds),
    planJson: merged.plan ? JSON.stringify(merged.plan) : null,
    masterSessionPath: merged.masterSessionPath,
    primaryRepositoryId: merged.primaryRepositoryId ?? null,
    planningBranch: merged.planningBranch ?? null,
    planningPrJson: merged.planningPr ? JSON.stringify(merged.planningPr) : null,
    updatedAt: merged.updatedAt,
  });
}
```

Also update the import at the top of `projects.test.ts` to add `listProjectsAwaitingLgtm`:
```typescript
import { insertProject, getProject, listProjects, updateProject, listProjectsAwaitingLgtm } from "../store/projects.js";
```

And update `baseProject` in the test file to fix the `Plan` type (remove `approved`):
```typescript
  it("updates plan", () => {
    insertProject(baseProject);
    const plan: Plan = {
      id: "plan-1", projectId: "proj-1", content: "Plan content",
      tasks: [],
    };
    updateProject("proj-1", { plan });
    const found = getProject("proj-1");
    expect(found?.plan).toEqual(plan);
  });
```

- [ ] **Step 6: Run tests and confirm they pass**

```bash
cd backend && npx vitest run src/__tests__/projects.test.ts
```

Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add backend/src/models/types.ts backend/src/store/db.ts backend/src/store/projects.ts backend/src/__tests__/projects.test.ts
git commit -m "feat: add planning flow data model and DB migration"
```

---

### Task 2: VCS `commitFile` Method

**Files:**
- Modify: `backend/src/connectors/types.ts`
- Modify: `backend/src/connectors/github.ts`
- Modify: `backend/src/connectors/bitbucket.ts`
- Create: `backend/src/__tests__/connectors.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/__tests__/connectors.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Repository } from "../models/types.js";

const mockRepo: Repository = {
  id: "r1", name: "test-repo", cloneUrl: "https://github.com/org/repo.git",
  provider: "github",
  providerConfig: { owner: "org", repo: "repo" },
  defaultBranch: "main",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("GitHubConnector.commitFile", () => {
  it("calls createOrUpdateFileContents with base64 content", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    const mockCreateOrUpdate = vi.fn().mockResolvedValue({});
    const mockGetContent = vi.fn().mockRejectedValue(new Error("Not Found"));

    vi.doMock("@octokit/rest", () => ({
      Octokit: vi.fn().mockImplementation(() => ({
        repos: {
          getContent: mockGetContent,
          createOrUpdateFileContents: mockCreateOrUpdate,
        },
      })),
    }));

    const { GitHubConnector } = await import("../connectors/github.js");
    const connector = new GitHubConnector();
    await connector.commitFile(mockRepo, "main", "docs/spec.md", "# Spec", "chore: add spec");

    expect(mockCreateOrUpdate).toHaveBeenCalledWith(expect.objectContaining({
      owner: "org",
      repo: "repo",
      path: "docs/spec.md",
      message: "chore: add spec",
      branch: "main",
      content: Buffer.from("# Spec", "utf-8").toString("base64"),
    }));
  });

  it("passes sha when file already exists", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    const mockCreateOrUpdate = vi.fn().mockResolvedValue({});
    const mockGetContent = vi.fn().mockResolvedValue({
      data: { type: "file", sha: "abc123def456" }
    });

    vi.doMock("@octokit/rest", () => ({
      Octokit: vi.fn().mockImplementation(() => ({
        repos: { getContent: mockGetContent, createOrUpdateFileContents: mockCreateOrUpdate },
      })),
    }));

    const { GitHubConnector } = await import("../connectors/github.js");
    const connector = new GitHubConnector();
    await connector.commitFile(mockRepo, "main", "docs/spec.md", "# Spec v2", "chore: update spec");

    expect(mockCreateOrUpdate).toHaveBeenCalledWith(expect.objectContaining({
      sha: "abc123def456",
    }));
  });
});

describe("BitbucketConnector.commitFile", () => {
  it("calls Files API with multipart/form-data", async () => {
    process.env.BITBUCKET_TOKEN = "bb-token";
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: vi.fn() });
    vi.stubGlobal("fetch", mockFetch);

    const { BitbucketConnector } = await import("../connectors/bitbucket.js");
    const bbRepo: Repository = {
      ...mockRepo,
      provider: "bitbucket-server",
      providerConfig: { projectKey: "PROJ", repoSlug: "my-repo", baseUrl: "https://bb.example.com" },
    };
    const connector = new BitbucketConnector();
    await connector.commitFile(bbRepo, "main", "docs/spec.md", "# Spec", "chore: add spec");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/rest/api/1.0/projects/PROJ/repos/my-repo/browse/docs/spec.md"),
      expect.objectContaining({ method: "PUT" })
    );
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd backend && npx vitest run src/__tests__/connectors.test.ts
```

Expected: FAIL — `connector.commitFile is not a function`

- [ ] **Step 3: Add `commitFile` to VcsConnector interface**

In `backend/src/connectors/types.ts`, add after the `addComment` method:

```typescript
  /**
   * Commit a file to a branch. Creates the branch from defaultBranch first
   * if createBranch is true.
   */
  commitFile(
    repo: Repository,
    branch: string,
    path: string,
    content: string,
    message: string,
    createBranch?: boolean
  ): Promise<void>;
```

- [ ] **Step 4: Implement `commitFile` in `backend/src/connectors/github.ts`**

Add this method to the `GitHubConnector` class (after `addComment`):

```typescript
  async commitFile(
    repo: Repository,
    branch: string,
    path: string,
    content: string,
    message: string,
    createBranch = false
  ): Promise<void> {
    const octokit = this.getOctokit();
    const { owner, repoName } = this.getOwnerRepo(repo);
    const authorName = process.env.GIT_COMMIT_AUTHOR_NAME ?? "Harness Bot";
    const authorEmail = process.env.GIT_COMMIT_AUTHOR_EMAIL ?? "harness@noreply";

    try {
      if (createBranch) {
        await this.createBranch(repo, branch, repo.defaultBranch);
      }

      // Get existing file SHA if the file already exists (needed for update)
      let fileSha: string | undefined;
      try {
        const { data } = await octokit.repos.getContent({ owner, repo: repoName, path, ref: branch });
        if (!Array.isArray(data) && data.type === "file") {
          fileSha = data.sha;
        }
      } catch {
        // File does not exist yet — that's fine for a create
      }

      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo: repoName,
        path,
        message,
        content: Buffer.from(content, "utf-8").toString("base64"),
        branch,
        ...(fileSha ? { sha: fileSha } : {}),
        author: { name: authorName, email: authorEmail },
        committer: { name: authorName, email: authorEmail },
      });
    } catch (error) {
      throw new ConnectorError(
        `Failed to commit file: ${error instanceof Error ? error.message : String(error)}`,
        "github",
        error
      );
    }
  }
```

- [ ] **Step 5: Implement `commitFile` in `backend/src/connectors/bitbucket.ts`**

Add this method to the `BitbucketConnector` class (after `addComment`):

```typescript
  async commitFile(
    repo: Repository,
    branch: string,
    path: string,
    content: string,
    message: string,
    createBranch = false
  ): Promise<void> {
    const { projectKey, repoSlug, baseUrl } = this.getProjectRepo(repo);
    const token = this.getToken();

    try {
      if (createBranch) {
        await this.createBranch(repo, branch, repo.defaultBranch);
      }

      const url = `${baseUrl}/rest/api/1.0/projects/${projectKey}/repos/${repoSlug}/browse/${path}`;

      const formData = new FormData();
      // Bitbucket Server Files API expects the content as a file blob
      formData.append("content", new Blob([content], { type: "text/plain" }), path.split("/").pop() ?? "file");
      formData.append("message", message);
      formData.append("branch", branch);

      const response = await fetch(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "Unknown error");
        throw new Error(`HTTP ${response.status}: ${text}`);
      }
    } catch (error) {
      throw new ConnectorError(
        `Failed to commit file: ${error instanceof Error ? error.message : String(error)}`,
        "bitbucket-server",
        error
      );
    }
  }
```

- [ ] **Step 6: Run tests and confirm they pass**

```bash
cd backend && npx vitest run src/__tests__/connectors.test.ts
```

Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add backend/src/connectors/types.ts backend/src/connectors/github.ts backend/src/connectors/bitbucket.ts backend/src/__tests__/connectors.test.ts
git commit -m "feat: add commitFile to VcsConnector interface and implementations"
```

---

### Task 3: Planning Tool Factory

**Files:**
- Create: `backend/src/agents/planningTool.ts`
- Create: `backend/src/__tests__/planningTool.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/__tests__/planningTool.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { slugify, buildPlanningBranch, buildPlanningFilePath } from "../agents/planningTool.js";
import type { Project } from "../models/types.js";

const baseProject: Project = {
  id: "a3b2c-uuid-goes-here", name: "Add User Auth",
  status: "spec_in_progress",
  source: { type: "freeform", freeformDescription: "" },
  repositoryIds: ["repo-1"],
  primaryRepositoryId: "repo-1",
  masterSessionPath: "",
  createdAt: "2026-03-22T00:00:00.000Z",
  updatedAt: "2026-03-22T00:00:00.000Z",
};

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Add User Auth")).toBe("add-user-auth");
  });

  it("strips non-alphanumeric characters", () => {
    expect(slugify("My Feature! (v2)")).toBe("my-feature-v2");
  });

  it("collapses consecutive hyphens", () => {
    expect(slugify("foo  --  bar")).toBe("foo-bar");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("  hello world  ")).toBe("hello-world");
  });

  it("truncates to 50 characters", () => {
    const long = "a".repeat(60);
    expect(slugify(long)).toHaveLength(50);
  });

  it("returns 'project' for an empty/whitespace name", () => {
    expect(slugify("")).toBe("project");
    expect(slugify("   ")).toBe("project");
    expect(slugify("!!!")).toBe("project");
  });
});

describe("buildPlanningBranch", () => {
  it("builds harness/{slug}-{suffix} for freeform projects", () => {
    // suffix = first 5 chars of id, lowercased, non-alphanumeric stripped
    const branch = buildPlanningBranch({ ...baseProject, id: "a3b2c-rest-of-uuid" });
    expect(branch).toBe("harness/add-user-auth-a3b2c");
  });

  it("prefixes with issue-{n}- for GitHub issue source", () => {
    const proj: Project = {
      ...baseProject,
      id: "f9e1a-uuid",
      source: { type: "github", githubIssues: ["org/repo#42"] },
    };
    const branch = buildPlanningBranch(proj);
    expect(branch).toBe("harness/issue-42-add-user-auth-f9e1a");
  });

  it("prefixes with {TICKET}- for jira source", () => {
    const proj: Project = {
      ...baseProject,
      id: "c4d2e-uuid",
      source: { type: "jira", jiraTickets: ["PROJ-123"] },
    };
    const branch = buildPlanningBranch(proj);
    expect(branch).toBe("harness/PROJ-123-add-user-auth-c4d2e");
  });

  it("truncates slug to 30 characters", () => {
    const proj: Project = {
      ...baseProject,
      id: "abc12-uuid",
      name: "This is a very long project name that exceeds thirty characters easily",
    };
    const branch = buildPlanningBranch(proj);
    // slug capped at 30, branch = harness/{slug30}-{5charId}
    const parts = branch.split("/")[1].split("-");
    const suffix = parts[parts.length - 1];
    expect(suffix).toBe("abc12");
    const slugPart = parts.slice(0, -1).join("-");
    expect(slugPart.length).toBeLessThanOrEqual(30);
  });
});

describe("buildPlanningFilePath", () => {
  it("returns correct spec path", () => {
    const path = buildPlanningFilePath("spec", "2026-03-22", "add-user-auth");
    expect(path).toBe("docs/superpowers/specs/2026-03-22-add-user-auth-design.md");
  });

  it("returns correct plan path", () => {
    const path = buildPlanningFilePath("plan", "2026-03-22", "add-user-auth");
    expect(path).toBe("docs/superpowers/plans/2026-03-22-add-user-auth-plan.md");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd backend && npx vitest run src/__tests__/planningTool.test.ts
```

Expected: FAIL — `Cannot find module '../agents/planningTool.js'`

- [ ] **Step 3: Create `backend/src/agents/planningTool.ts`**

```typescript
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { getProject, updateProject } from "../store/projects.js";
import { getRepository } from "../store/repositories.js";
import { getConnector } from "../connectors/types.js";
import type { Project } from "../models/types.js";
import path from "path";
import fs from "fs";

// ── Slug / Branch / Path helpers ──────────────────────────────────────────────

export function slugify(name: string): string {
  const result = name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return result || "project";
}

/** Extract issue number from first GitHub issue ref (e.g. "org/repo#42" → "42"). */
function githubIssuePrefix(project: Project): string {
  const ref = project.source.githubIssues?.[0];
  if (!ref) return "";
  const match = /#(\d+)$/.exec(ref);
  return match ? `issue-${match[1]}-` : "";
}

/** Extract ticket key from first Jira ticket (e.g. "PROJ-123"). */
function jiraPrefix(project: Project): string {
  const ticket = project.source.jiraTickets?.[0];
  return ticket ? `${ticket}-` : "";
}

export function buildPlanningBranch(project: Project): string {
  const prefix =
    project.source.type === "github" ? githubIssuePrefix(project) :
    project.source.type === "jira"   ? jiraPrefix(project) :
    "";
  // Suffix: first 5 chars of UUID, strip non-alphanumeric
  const suffix = project.id.replace(/[^a-z0-9]/g, "").slice(0, 5);
  const slug = slugify(project.name).slice(0, 30).replace(/-+$/, "");
  return `harness/${prefix}${slug}-${suffix}`;
}

export function buildPlanningFilePath(
  type: "spec" | "plan",
  date: string,
  slug: string
): string {
  const dir = type === "spec" ? "docs/superpowers/specs" : "docs/superpowers/plans";
  const suffix = type === "spec" ? "design" : "plan";
  return `${dir}/${date}-${slug}-${suffix}.md`;
}

// ── Tool factory ──────────────────────────────────────────────────────────────

const WritePlanningDocumentParams = Type.Object({
  type: Type.Union([Type.Literal("spec"), Type.Literal("plan")]),
  content: Type.String({ description: "Full Markdown content of the document" }),
});

export function createWritePlanningDocumentTool(
  projectId: string,
  dataDir: string
): ToolDefinition<typeof WritePlanningDocumentParams> {
  return {
    name: "write_planning_document",
    label: "Write Planning Document",
    description:
      'Write a planning document to the project\'s planning branch in the primary repository. ' +
      'Call with type "spec" first to write the design spec and open the PR. ' +
      'Call with type "plan" after spec is approved to write the implementation plan. ' +
      'Returns the PR URL.',
    parameters: WritePlanningDocumentParams,
    async execute(_toolCallId, { type, content }) {
      const result = await handleWritePlanningDocument(projectId, type, content, dataDir);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: {},
      } satisfies AgentToolResult;
    },
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function handleWritePlanningDocument(
  projectId: string,
  type: "spec" | "plan",
  content: string,
  dataDir: string
): Promise<{ prUrl: string } | { error: string }> {
  const project = getProject(projectId);
  if (!project) return { error: `Project not found: ${projectId}` };

  const primaryRepoId = project.primaryRepositoryId ?? project.repositoryIds[0];
  if (!primaryRepoId) return { error: "Project has no primary repository" };

  const repo = getRepository(primaryRepoId);
  if (!repo) return { error: `Repository not found: ${primaryRepoId}` };

  const connector = getConnector(repo.provider);
  const date = project.createdAt.slice(0, 10); // YYYY-MM-DD
  const slug = slugify(project.name);

  try {
    if (type === "spec") {
      const branch = buildPlanningBranch(project);
      const filePath = buildPlanningFilePath("spec", date, slug);

      // Commit spec (createBranch=true creates branch from defaultBranch if needed)
      await connector.commitFile(repo, branch, filePath, content, `docs: add design spec for ${project.name}`, true);

      // Commit master session log snapshot alongside the spec
      const sessionLogSrc = path.join(dataDir, "sessions", projectId, "master.jsonl");
      if (fs.existsSync(sessionLogSrc)) {
        const log = fs.readFileSync(sessionLogSrc, "utf-8");
        await connector.commitFile(repo, branch, ".harness/logs/master/session.jsonl", log,
          "chore: add master agent log snapshot");
      }

      // Create or reuse PR
      let prUrl: string;
      let prNumber: number;

      const harnessPrTitle = `[Harness] ${project.name}`;
      // Use HARNESS_UI_BASE_URL env var for the harness UI link; omit if not set
      const harnessUiBase = process.env.HARNESS_UI_BASE_URL ?? "";
      const uiProjectUrl = harnessUiBase ? `${harnessUiBase}/projects/${projectId}/chat` : "";

      try {
        const prResult = await connector.createPullRequest(repo, {
          title: harnessPrTitle,
          description: `Planning PR for harness project.${uiProjectUrl ? `\n\nView project: ${uiProjectUrl}` : ""}`,
          headBranch: branch,
          baseBranch: repo.defaultBranch,
        });
        prUrl = prResult.url;
        prNumber = parseInt(prResult.id, 10);
      } catch (prErr) {
        // PR might already exist — try to find it via listing (not implemented)
        // For now, surface the error to the agent
        return { error: `Failed to create PR: ${prErr instanceof Error ? prErr.message : String(prErr)}` };
      }

      updateProject(projectId, {
        primaryRepositoryId: primaryRepoId,
        planningBranch: branch,
        planningPr: { number: prNumber, url: prUrl },
        status: "awaiting_spec_approval",
      });

      return { prUrl };
    }

    if (type === "plan") {
      if (!project.planningBranch || !project.planningPr) {
        return { error: 'Spec must be written first — call write_planning_document with type "spec" before "plan".' };
      }

      const filePath = buildPlanningFilePath("plan", date, slug);
      await connector.commitFile(repo, project.planningBranch, filePath, content,
        `docs: add implementation plan for ${project.name}`);

      // Update master session log snapshot
      const sessionLogSrc = path.join(dataDir, "sessions", projectId, "master.jsonl");
      if (fs.existsSync(sessionLogSrc)) {
        const log = fs.readFileSync(sessionLogSrc, "utf-8");
        await connector.commitFile(repo, project.planningBranch, ".harness/logs/master/session.jsonl", log,
          "chore: update master agent log snapshot");
      }

      // Store plan content and parse tasks so dispatchTasks can find them at execution time.
      // Import parsePlan lazily to avoid circular dependency.
      const { parsePlan } = await import("./planParser.js");
      const { listRepositories } = await import("../store/repositories.js");
      const allRepos = listRepositories();
      const tasks = parsePlan(projectId, content, allRepos);
      const planRecord = {
        id: project.plan?.id ?? project.id + "-plan",
        projectId,
        content,
        tasks,
      };

      updateProject(projectId, { plan: planRecord, status: "awaiting_plan_approval" });

      return { prUrl: project.planningPr.url };
    }

    return { error: `Unknown document type: ${type as string}` };
  } catch (error) {
    return { error: `VCS error: ${error instanceof Error ? error.message : String(error)}` };
  }
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
cd backend && npx vitest run src/__tests__/planningTool.test.ts
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/agents/planningTool.ts backend/src/__tests__/planningTool.test.ts
git commit -m "feat: add planning tool factory with slugify/branch/path helpers"
```

---

### Task 4: Master Agent + System Prompt

**Files:**
- Modify: `backend/src/agents/masterAgent.ts`
- Modify: `backend/src/api/websocket.ts`

- [ ] **Step 1: Update `backend/src/agents/masterAgent.ts`**

The change is minimal: accept `customTools` as a constructor parameter and pass it to `createAgentSession`.

Replace the class definition:

```typescript
import { EventEmitter } from "events";
import { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, ModelRegistry, AuthStorage } from "@mariozechner/pi-coding-agent";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import path from "path";
import { config } from "../config.js";
import { existsSync } from "fs";

interface PiEvent {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string };
}

export class MasterAgent extends EventEmitter {
  private session: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;

  constructor(
    private readonly projectId: string,
    private readonly sessionFilePath: string,
    private readonly customTools: ToolDefinition[] = []
  ) {
    super();
  }

  async init(): Promise<void> {
    console.log(`[MasterAgent:${this.projectId}] init() start`);
    const sessionDir = path.dirname(this.sessionFilePath);
    const settingsManager = SettingsManager.inMemory();

    const superpowersSkillsPaths = this.findSuperpowersSkills();

    const resourceLoader = new DefaultResourceLoader({
      settingsManager,
      noExtensions: true,
      noSkills: false,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: superpowersSkillsPaths,
    });

    console.log(`[MasterAgent:${this.projectId}] loading resources...`);
    await resourceLoader.reload();

    const authStorage = AuthStorage.create();
    const modelRegistry = new ModelRegistry(authStorage);
    const provider = config.agentProvider;
    const providerModels = config.models[provider as keyof typeof config.models];
    const modelId = providerModels?.masterAgent?.model;
    const model = modelId ? modelRegistry.find(provider, modelId) : undefined;
    console.log(`[MasterAgent:${this.projectId}] provider=${provider} modelId=${modelId} modelFound=${!!model}`);

    console.log(`[MasterAgent:${this.projectId}] creating agent session...`);
    const { session } = await createAgentSession({
      sessionManager: SessionManager.create(sessionDir, sessionDir),
      settingsManager,
      resourceLoader,
      modelRegistry,
      ...(model ? { model } : {}),
      ...(this.customTools.length > 0 ? { customTools: this.customTools } : {}),
    });
    console.log(`[MasterAgent:${this.projectId}] session created`);

    session.subscribe((event: unknown) => {
      const e = event as PiEvent;
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta" && e.assistantMessageEvent.delta) {
        this.emit("delta", e.assistantMessageEvent.delta);
      }
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "message_stop") {
        console.log(`[MasterAgent:${this.projectId}] message_stop received`);
        this.emit("message_complete");
      }
      if (e.type === "error") {
        console.error(`[MasterAgent:${this.projectId}] session error event:`, e);
      }
    });
    this.session = session;
    console.log(`[MasterAgent:${this.projectId}] init() complete`);
  }

  private findSuperpowersSkills(): string[] {
    const possiblePaths = [
      path.join(process.cwd(), "node_modules", "superpowers", "skills"),
      path.join(process.env.HOME || "", ".local", "share", "npm", "node_modules", "superpowers", "skills"),
      path.join(process.env.HOME || "", ".bun", "install", "global", "node_modules", "superpowers", "skills"),
    ];
    const skillPaths: string[] = [];
    for (const p of possiblePaths) {
      if (existsSync(p)) skillPaths.push(p);
    }
    if (skillPaths.length === 0) {
      console.warn("[MasterAgent] No superpowers skills directory found. Skills may not be available.");
    }
    return skillPaths;
  }

  async prompt(text: string): Promise<void> {
    if (!this.session) throw new Error("MasterAgent not initialized");
    console.log(`[MasterAgent:${this.projectId}] prompt() called, text length=${text.length}`);
    try {
      await this.session.prompt(text);
      console.log(`[MasterAgent:${this.projectId}] prompt() resolved`);
    } catch (err) {
      console.error(`[MasterAgent:${this.projectId}] prompt() threw:`, err);
      throw err;
    }
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

- [ ] **Step 2: Update `backend/src/api/websocket.ts`**

Replace the entire file:

```typescript
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage, Server } from "http";
import { MasterAgent } from "../agents/masterAgent.js";
import { createWritePlanningDocumentTool } from "../agents/planningTool.js";
import { getProject, updateProject } from "../store/projects.js";
import { appendMessage, listMessagesSince } from "../store/messages.js";
import { listRepositories } from "../store/repositories.js";
import type { Project, Repository } from "../models/types.js";
import path from "path";
import fs from "fs";

const agentSessions = new Map<string, MasterAgent>();
const agentInitPromises = new Map<string, Promise<MasterAgent>>();
let globalDataDir = "";

export async function getOrInitAgent(projectId: string): Promise<MasterAgent> {
  const existing = agentSessions.get(projectId);
  if (existing) { console.log(`[ws] getOrInitAgent(${projectId}): returning cached agent`); return existing; }

  const existingPromise = agentInitPromises.get(projectId);
  if (existingPromise) { console.log(`[ws] getOrInitAgent(${projectId}): awaiting in-progress init`); return existingPromise; }

  console.log(`[ws] getOrInitAgent(${projectId}): starting new init`);
  const promise = (async () => {
    const sessionDir = path.join(globalDataDir, "sessions", projectId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "master.jsonl");

    const planningTool = createWritePlanningDocumentTool(projectId, globalDataDir);
    const agent = new MasterAgent(projectId, sessionPath, [planningTool]);
    await agent.init();
    agentSessions.set(projectId, agent);
    agentInitPromises.delete(projectId);
    console.log(`[ws] getOrInitAgent(${projectId}): init complete, agent stored`);
    return agent;
  })();

  agentInitPromises.set(projectId, promise);
  return promise;
}

export function preInitAgent(projectId: string): void {
  if (agentSessions.has(projectId) || agentInitPromises.has(projectId)) return;
  getOrInitAgent(projectId).catch((err) => {
    console.error(`[preInitAgent] Failed to init agent for ${projectId}:`, err);
  });
}

function buildMasterAgentContext(project: Project, repos: Repository[]): string {
  const repoList = repos.length > 0
    ? repos.map((r) => `- **${r.name}**: ${r.cloneUrl} (default branch: ${r.defaultBranch})`).join("\n")
    : "  (no repositories configured for this project)";

  let sourceSection = "";
  if (project.source.type === "freeform" && project.source.freeformDescription) {
    sourceSection = `## Project Description\n${project.source.freeformDescription}`;
  } else if (project.source.type === "jira" && project.source.jiraTickets?.length) {
    sourceSection = `## JIRA Tickets\n${project.source.jiraTickets.map((t) => `- ${t}`).join("\n")}`;
  } else if (project.source.type === "github") {
    const parts: string[] = [];
    if (project.source.freeformDescription) parts.push(project.source.freeformDescription);
    if (project.source.githubIssues?.length) parts.push(`Issue refs: ${project.source.githubIssues.join(", ")}`);
    if (parts.length > 0) sourceSection = `## GitHub Issues\n${parts.join("\n\n")}`;
  }

  return `## Your Role
You are a master planning agent. You operate in two phases, each driven by a
dedicated superpowers skill. Follow each skill's process exactly.

---

## Phase 1 — Design Spec

Invoke the \`superpowers:brainstorming\` skill. Follow its full process:

1. Explore the project context (repositories, existing code, recent commits).
2. Ask clarifying questions one at a time (multiple-choice preferred).
3. Propose 2–3 design approaches with trade-offs and a recommendation.
4. Present the design in sections; get approval after each section.
5. Write the spec to:
   \`docs/superpowers/specs/{YYYY-MM-DD}-{project-slug}-design.md\`
6. Dispatch the \`spec-document-reviewer\` subagent (from the brainstorming skill's
   \`spec-document-reviewer-prompt.md\`). Fix any issues and re-dispatch until
   approved (max 3 iterations; surface to user if still failing after 3).
7. Ask the user to review the written spec file before proceeding.
8. Once the user approves the written spec, call:
   \`write_planning_document(type: "spec", content: <full spec markdown>)\`
9. After the tool returns, post the PR URL in chat:
   "The spec is ready for review at {url}. Add a LGTM comment to the PR when you
   are happy with it."

---

## Phase 2 — Implementation Plan

Triggered when you receive:
\`[SYSTEM] The spec has been approved (LGTM received on the PR).\`

Invoke the \`superpowers:writing-plans\` skill. Follow its full process:

1. Re-read the approved spec carefully.
2. Define the file structure and task boundaries.
3. Write a detailed plan with bite-sized tasks (2–5 min each), each containing:
   - Files to create/modify/test
   - Exact code snippets
   - Exact commands with expected output
   - Step-by-step checkboxes
4. Save the plan to:
   \`docs/superpowers/plans/{YYYY-MM-DD}-{project-slug}-plan.md\`
   Include this header for the sub-agents that will execute it:
   > **For agentic workers:** Tasks will be executed by containerised sub-agents.
   > Each sub-agent receives its task via the TASK_DESCRIPTION environment variable.
5. Dispatch the \`plan-document-reviewer\` subagent (from the writing-plans skill's
   \`plan-document-reviewer-prompt.md\`). Fix issues and re-dispatch until approved
   (max 3 iterations).
6. Ask the user to review the written plan file before proceeding.
7. Once the user approves the written plan, call:
   \`write_planning_document(type: "plan", content: <full plan markdown>)\`
8. After the tool returns, post the PR URL in chat:
   "The implementation plan is ready for review at {url}. Add a LGTM comment when
   you are ready to start implementation."

**Important:** The \`writing-plans\` skill normally ends by asking the user to choose
between subagent-driven or inline execution. **Skip that step entirely.** In this
harness, execution is handled automatically by containerised Docker sub-agents after
the plan LGTM is received. Do not ask about worktrees or execution modes.

The plan must use this task format exactly (used by the task parser):

### Task 1: [Brief Task Title]
**Repository:** [exact repository name from the list above]
**Description:**
[Detailed description — self-contained enough for a sub-agent with no other context]

### Task 2: ...

---

## Phase 3 — Implementation Started

Triggered when you receive:
\`[SYSTEM] The implementation plan has been approved (LGTM received on the PR).\`

Tell the user:
"The plan has been approved. Implementation is starting — the sub-agents will take
it from here. I'll let you know when they're done."

Do NOT invoke any execution skill. Sub-agent execution is handled automatically
by the harness.

---

## Important Rules
- Do NOT make code changes yourself at any point.
- Do NOT skip the spec-document-reviewer or plan-document-reviewer subagent steps.
- Communicate every state transition explicitly in chat.
- Follow superpowers skill processes exactly — do not shortcut them.

## Available Repositories
${repoList}

${sourceSection}`;
}

interface WsClientMessage { type: "prompt" | "steer" | "resume"; text?: string; lastSeqId?: number; }
interface WsServerMessage { type: "delta" | "message_complete" | "replay" | "error"; [key: string]: unknown; }

function send(ws: WebSocket, msg: WsServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function handleWsMessage(agent: MasterAgent, ws: WebSocket, projectId: string, raw: Buffer): Promise<void> {
  let msg: WsClientMessage;
  try { msg = JSON.parse(raw.toString()) as WsClientMessage; }
  catch { send(ws, { type: "error", message: "Invalid JSON" }); return; }

  if (msg.type === "resume" && msg.lastSeqId !== undefined) {
    const missed = listMessagesSince(projectId, msg.lastSeqId);
    send(ws, { type: "replay", messages: missed });
    return;
  }

  if (msg.type === "prompt" && msg.text) {
    console.log(`[ws] prompt received for project=${projectId}, text length=${msg.text.length}`);
    const savedUserMsg = appendMessage(projectId, "user", msg.text);
    const isFirstMessage = savedUserMsg.seqId === 1;
    console.log(`[ws] user message saved seqId=${savedUserMsg.seqId}, isFirstMessage=${isFirstMessage}`);

    let promptText = msg.text;
    if (isFirstMessage) {
      const project = getProject(projectId);
      if (project) {
        const allRepos = listRepositories();
        const projectRepos = allRepos.filter((r) => project.repositoryIds.includes(r.id));
        console.log(`[ws] injecting context: sourceType=${project.source.type}, repos=[${projectRepos.map((r) => r.name).join(", ")}]`);
        const context = buildMasterAgentContext(project, projectRepos);
        promptText = `${context}\n\n---\n\n${msg.text}`;
        console.log(`[ws] final prompt length with context=${promptText.length}`);
        // Transition to spec_in_progress on first user message
        updateProject(projectId, { status: "spec_in_progress" });
      }
    }

    let fullResponse = "";
    let deltaCount = 0;
    const onDelta = (text: string) => { fullResponse += text; deltaCount++; };
    agent.on("delta", onDelta);
    console.log(`[ws] calling agent.prompt()...`);
    try {
      await agent.prompt(promptText);
      console.log(`[ws] agent.prompt() resolved. deltaCount=${deltaCount}, fullResponse length=${fullResponse.length}`);
      if (fullResponse) {
        appendMessage(projectId, "assistant", fullResponse);
        console.log(`[ws] assistant message saved`);
      } else {
        console.warn(`[ws] agent returned empty response (deltaCount=${deltaCount})`);
      }
      send(ws, { type: "message_complete" });
      console.log(`[ws] message_complete sent`);
    } catch (err) {
      console.error(`[ws] agent.prompt() error:`, err);
      send(ws, { type: "error", message: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      agent.off("delta", onDelta);
    }
    return;
  }

  if (msg.type === "steer" && msg.text) {
    await agent.steer(msg.text);
    return;
  }
}

export function setupWebSocket(server: Server, dataDir: string): void {
  globalDataDir = dataDir;
  const wss = new WebSocketServer({ server });
  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const match = /\/ws\/projects\/([^/]+)\/chat/.exec(req.url ?? "");
    if (!match) { ws.close(4000, "Invalid URL"); return; }
    const projectId = match[1];
    console.log(`[ws] new connection for project=${projectId}`);
    const project = getProject(projectId);
    if (!project) { console.error(`[ws] project not found: ${projectId}`); ws.close(4004, "Project not found"); return; }

    const pendingMessages: Buffer[] = [];
    let agent: MasterAgent | undefined = agentSessions.get(projectId);
    console.log(`[ws] agent already cached: ${!!agent}`);

    ws.on("message", async (raw: Buffer) => {
      if (!agent) {
        console.log(`[ws] message buffered (agent not ready yet) for project=${projectId}`);
        pendingMessages.push(raw);
        return;
      }
      await handleWsMessage(agent, ws, projectId, raw);
    });

    if (!agent) {
      console.log(`[ws] awaiting agent init for project=${projectId}`);
      agent = await getOrInitAgent(projectId);
      console.log(`[ws] agent ready for project=${projectId}`);
    }

    const onDeltaFwd = (text: string) => send(ws, { type: "delta", text });
    const onErrorFwd = (err: Error) => send(ws, { type: "error", message: err.message });
    agent.on("delta", onDeltaFwd);
    agent.on("error", onErrorFwd);

    ws.on("close", () => {
      agent!.off("delta", onDeltaFwd);
      agent!.off("error", onErrorFwd);
    });

    if (pendingMessages.length > 0) {
      console.log(`[ws] flushing ${pendingMessages.length} buffered messages for project=${projectId}`);
    }
    for (const raw of pendingMessages) {
      await handleWsMessage(agent, ws, projectId, raw);
    }
  });
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add backend/src/agents/masterAgent.ts backend/src/api/websocket.ts
git commit -m "feat: inject write_planning_document tool and update master agent system prompt"
```

---

### Task 5: LGTM Polling Path

**Files:**
- Modify: `backend/src/polling.ts`
- Create: `backend/src/__tests__/polling.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/__tests__/polling.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("detectLgtm", () => {
  it("detects standalone LGTM (case-insensitive)", async () => {
    const { detectLgtm } = await import("../polling.js");
    expect(detectLgtm("LGTM")).toBe(true);
    expect(detectLgtm("lgtm")).toBe(true);
    expect(detectLgtm("Looks good! LGTM")).toBe(true);
    expect(detectLgtm("LGTM!")).toBe(true);
    expect(detectLgtm("Great work")).toBe(false);
    expect(detectLgtm("LGTMs")).toBe(false); // not a standalone word
  });
});
```

Note: `detectLgtm` needs to be exported from `polling.ts`.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd backend && npx vitest run src/__tests__/polling.test.ts
```

Expected: FAIL — `detectLgtm is not exported`

- [ ] **Step 3: Update `backend/src/polling.ts`**

Add the following at the **top** of the file (after existing imports), inserting new imports for the LGTM polling:

```typescript
import type Dockerode from "dockerode";
import { listPullRequestsByProject, upsertReviewComment } from "./store/pullRequests.js";
import { getRepository } from "./store/repositories.js";
import { getConnector } from "./connectors/types.js";
import { getDebounceEngine } from "./api/webhooks.js";
import { randomUUID } from "crypto";
import type { ReviewComment, PullRequest } from "./models/types.js";
```

Add these exports and functions **before** `startPolling`:

```typescript
// ── LGTM detection ────────────────────────────────────────────────────────────

export function detectLgtm(body: string): boolean {
  return /\bLGTM\b/i.test(body);
}

const lgtmPollStates = new Map<string, string>(); // projectId → lastSeenCommentAt

async function pollPlanningPrs(docker: Dockerode): Promise<void> {
  if (!isRunning) return;

  let projects: Awaited<ReturnType<typeof import("./store/projects.js").listProjectsAwaitingLgtm>>;
  try {
    const { listProjectsAwaitingLgtm } = await import("./store/projects.js");
    projects = listProjectsAwaitingLgtm();
  } catch (error) {
    console.error("[polling] Failed to list projects awaiting LGTM:", error);
    return;
  }

  for (const project of projects) {
    if (!project.planningPr || !project.primaryRepositoryId) continue;
    const repo = getRepository(project.primaryRepositoryId);
    if (!repo) continue;

    try {
      const connector = getConnector(repo.provider);

      // Check if the planning PR was closed before approval
      const prInfo = await connector.getPullRequest(repo, String(project.planningPr.number));
      if (prInfo.status !== "open") {
        console.log(`[polling] Planning PR closed for project ${project.id} — marking as failed`);
        const { updateProject } = await import("./store/projects.js");
        updateProject(project.id, { status: "failed" });
        const { getOrInitAgent } = await import("./api/websocket.js");
        const closedAgent = await getOrInitAgent(project.id);
        await closedAgent.prompt(
          "[SYSTEM] The planning PR was closed before approval. The project has been marked as failed. Let the user know."
        );
        continue;
      }

      const since = lgtmPollStates.get(project.id);
      const comments = await connector.getComments(repo, String(project.planningPr.number), since);

      // Update last seen timestamp
      if (comments.length > 0) {
        const latest = comments[comments.length - 1].createdAt;
        lgtmPollStates.set(project.id, latest);
      }

      const hasLgtm = comments.some(c => detectLgtm(c.body));
      if (!hasLgtm) continue;

      console.log(`[polling] LGTM detected on planning PR for project ${project.id} (status: ${project.status})`);

      // Import here to avoid circular dependency
      const { getOrInitAgent } = await import("./api/websocket.js");
      const agent = await getOrInitAgent(project.id);

      if (project.status === "awaiting_spec_approval") {
        const { updateProject } = await import("./store/projects.js");
        updateProject(project.id, {
          planningPr: { ...project.planningPr, specApprovedAt: new Date().toISOString() },
          status: "plan_in_progress",
        });
        await agent.prompt(
          '[SYSTEM] The spec has been approved (LGTM received on the PR).\n' +
          'Write the implementation plan now using the write_planning_document tool with type "plan".\n' +
          'Then post the PR URL in chat and tell the user to add a LGTM comment when ready to start implementation.'
        );
      } else if (project.status === "awaiting_plan_approval") {
        // plan.content and tasks were stored by write_planning_document(type: "plan") tool handler
        const { updateProject, getProject: getFreshProject } = await import("./store/projects.js");
        const { TaskDispatcher } = await import("./orchestrator/taskDispatcher.js");

        updateProject(project.id, {
          planningPr: { ...project.planningPr, planApprovedAt: new Date().toISOString() },
          status: "executing",
        });

        // Create branches and commit plan file to non-primary repos (spec § "Other Repositories")
        const freshProject = getFreshProject(project.id);
        if (freshProject?.plan?.content && freshProject.planningBranch) {
          const { listRepositories } = await import("./store/repositories.js");
          const allRepos = listRepositories();
          const date = freshProject.createdAt.slice(0, 10);
          const { slugify, buildPlanningFilePath } = await import("./agents/planningTool.js");
          const slug = slugify(freshProject.name);
          const planFilePath = buildPlanningFilePath("plan", date, slug);

          for (const repoId of freshProject.repositoryIds) {
            if (repoId === freshProject.primaryRepositoryId) continue; // already committed
            const nonPrimaryRepo = allRepos.find(r => r.id === repoId);
            if (!nonPrimaryRepo) continue;
            try {
              const nonPrimaryConnector = getConnector(nonPrimaryRepo.provider);
              // createBranch=true creates the branch from defaultBranch
              await nonPrimaryConnector.commitFile(
                nonPrimaryRepo,
                freshProject.planningBranch,
                planFilePath,
                freshProject.plan.content,
                `docs: add implementation plan for ${freshProject.name}`,
                true // createBranch
              );
              console.log(`[polling] Plan committed to non-primary repo ${nonPrimaryRepo.name}`);
            } catch (err) {
              console.warn(`[polling] Failed to commit plan to non-primary repo ${repoId}:`, err);
            }
          }
        }

        await agent.prompt(
          '[SYSTEM] The implementation plan has been approved (LGTM received on the PR).\n' +
          'Tell the user that implementation is starting and the sub-agents will take it from here.'
        );

        const dispatcher = new TaskDispatcher();
        dispatcher.dispatchTasks(docker, project.id).catch(err => {
          console.error(`[polling] Task dispatch failed for project ${project.id}:`, err);
        });
      }
    } catch (error) {
      console.error(`[polling] Error processing LGTM for project ${project.id}:`, error);
    }
  }
}
```

Then integrate `pollPlanningPrs` into the polling loop. In `pollAllPullRequests`, add this call at the end before the catch:

```typescript
    // Poll planning PRs for LGTM
    await pollPlanningPrs(docker);
```

Also update `startPolling` log message:
```typescript
  console.log(`[polling] Starting polling (interval: ${POLL_INTERVAL_MS}ms)`);
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
cd backend && npx vitest run src/__tests__/polling.test.ts
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/polling.ts backend/src/__tests__/polling.test.ts
git commit -m "feat: add LGTM polling path for planning PRs"
```

---

### Task 6: Task Dispatcher Updates

**Files:**
- Modify: `backend/src/orchestrator/taskDispatcher.ts`

- [ ] **Step 1: Write a failing test for `buildTaskPrompt`**

Add to `backend/src/__tests__/projects.test.ts` (new describe block at the end):

```typescript
describe("TaskDispatcher.buildTaskPrompt", () => {
  it("prepends TDD preamble to the raw description", async () => {
    const { TaskDispatcher } = await import("../orchestrator/taskDispatcher.js");
    const dispatcher = new TaskDispatcher();
    const prompt = dispatcher.buildTaskPrompt({ description: "Implement OAuth2 flow", id: "t1", repositoryId: "r1", status: "pending" });
    expect(prompt).toContain("Test-Driven Development");
    expect(prompt).toContain("Implement OAuth2 flow");
    expect(prompt).toContain("## Your Task");
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd backend && npx vitest run src/__tests__/projects.test.ts -t "buildTaskPrompt"
```

Expected: FAIL — `dispatcher.buildTaskPrompt is not a function`

- [ ] **Step 3: Update `backend/src/orchestrator/taskDispatcher.ts`**

Make the following changes:

**3a.** Add `buildTaskPrompt` as a public method (insert after the class opening, before `dispatchTasks`):

```typescript
  private static readonly TASK_PREAMBLE = `You are a software engineering sub-agent. Follow this workflow exactly.

## Step 1 — Understand the Task
Read the task description below carefully. If a plan file exists in the repository
at docs/superpowers/plans/, read it to understand the full project context before
starting.

## Step 2 — Test-Driven Development
Follow strict TDD. For every behaviour you implement:
1. Write a failing test first. Run it and confirm it fails for the right reason.
2. Write the minimum code to make it pass. Run it and confirm it passes.
3. Refactor. Keep tests green.
Never write production code without a failing test first.

## Step 3 — Implement
Work through the task description step by step. Commit logical units of work with
clear messages. Do not make changes beyond the scope of the task.

## Step 4 — Systematic Debugging
If you encounter a bug or unexpected behaviour:
1. Reproduce it reliably first.
2. Form a hypothesis about the root cause.
3. Test the hypothesis before attempting a fix.
4. Fix only after confirming the root cause.
Never guess-and-check. Root cause first, always.

## Step 5 — Verify Before Finishing
Before considering the task done:
1. Run the full test suite. Show the command and its output.
2. Confirm every acceptance criterion in the task description is met.
3. Do not claim completion without fresh evidence.
If verification fails, go back and fix — do not push broken code.

## Step 6 — Commit and Push
Stage and commit all changes. The harness will open the pull request automatically.

---

## Your Task

`;

  public buildTaskPrompt(task: PlanTask): string {
    return TaskDispatcher.TASK_PREAMBLE + task.description;
  }
```

**3b.** Update the approval guard in `dispatchTasks` (replace the old check):

Old:
```typescript
    if (!project.plan || !project.plan.approved) {
      throw new Error(`Project ${projectId} does not have an approved plan`);
    }
```

New:
```typescript
    if (!project.planningPr?.planApprovedAt) {
      throw new Error(`Project ${projectId} does not have an approved plan (planningPr.planApprovedAt not set)`);
    }
```

**3c.** Update branch naming in `runTask` to use `project.planningBranch` for primary repo, or fall back to `feature/` prefix for other repos:

Old:
```typescript
    const branchName = `feature/${project.name.toLowerCase().replace(/\s+/g, "-")}-${task.id.slice(0, 8)}`;
```

New:
```typescript
    const isPrimaryRepo = repository.id === project.primaryRepositoryId;
    const branchName = isPrimaryRepo && project.planningBranch
      ? project.planningBranch
      : `feature/${project.name.toLowerCase().replace(/\s+/g, "-")}-${task.id.slice(0, 8)}`;
```

**3d.** Pass `buildTaskPrompt(task)` result to container instead of raw `task.description`:

Old:
```typescript
      containerId = await createSubAgentContainer(docker, {
        sessionId,
        repoCloneUrl: repository.cloneUrl,
        branchName,
        taskDescription: task.description,
      });
```

New:
```typescript
      containerId = await createSubAgentContainer(docker, {
        sessionId,
        repoCloneUrl: repository.cloneUrl,
        branchName,
        taskDescription: this.buildTaskPrompt(task),
      });
```

- [ ] **Step 4: Run test and confirm it passes**

```bash
cd backend && npx vitest run src/__tests__/projects.test.ts -t "buildTaskPrompt"
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/orchestrator/taskDispatcher.ts backend/src/__tests__/projects.test.ts
git commit -m "feat: add TDD preamble to sub-agent tasks and update dispatch guard"
```

---

### Task 7: Backend API Cleanup

**Files:**
- Modify: `backend/src/api/projects.ts`

- [ ] **Step 1: Update `backend/src/api/projects.ts`**

**7a.** Remove the entire `// Approve plan` route block (lines 119–148 in the original):

Delete:
```typescript
  // Approve plan
  router.post("/:id/approve", async (req, res) => {
    ...
  });
```

**7b.** In the `POST /` route, extract `primaryRepositoryId` from the body and add validation:

Replace:
```typescript
  router.post("/", (req, res) => {
    const { name, description, source, repositoryIds } = req.body;
    if (!name) {
      res.status(400).json({ error: "Missing required field: name" });
      return;
    }
```

With:
```typescript
  router.post("/", (req, res) => {
    const { name, description, source, repositoryIds, primaryRepositoryId } = req.body;
    if (!name) {
      res.status(400).json({ error: "Missing required field: name" });
      return;
    }

    if (!repositoryIds || (Array.isArray(repositoryIds) && repositoryIds.length === 0)) {
      res.status(400).json({ error: "At least one repository is required" });
      return;
    }
```

**7c.** When building the project object, include `primaryRepositoryId`:

Replace:
```typescript
    const project: Project = {
      id: randomUUID(),
      name,
      status: "brainstorming",
      source: source || {
        type: "freeform",
        freeformDescription: description || "",
      },
      repositoryIds: repositoryIds || [],
      masterSessionPath: "",
      createdAt: now,
      updatedAt: now,
    };
```

With:
```typescript
    const resolvedRepoIds: string[] = repositoryIds || [];
    const resolvedPrimaryRepoId: string | undefined =
      primaryRepositoryId ?? (resolvedRepoIds.length === 1 ? resolvedRepoIds[0] : undefined);

    const project: Project = {
      id: randomUUID(),
      name,
      status: "brainstorming",
      source: source || {
        type: "freeform",
        freeformDescription: description || "",
      },
      repositoryIds: resolvedRepoIds,
      primaryRepositoryId: resolvedPrimaryRepoId,
      masterSessionPath: "",
      createdAt: now,
      updatedAt: now,
    };
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 3: Run the full test suite to check nothing is broken**

```bash
cd backend && npx vitest run
```

Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add backend/src/api/projects.ts
git commit -m "feat: remove approve endpoint; add primaryRepositoryId to project creation"
```

---

### Task 8: Sub-Agent Log Commits

**Files:**
- Modify: `sub-agent/runner.mjs`

- [ ] **Step 1: Update `sub-agent/runner.mjs`**

Add `TASK_ID` env var read near the top (after `AGENT_MODEL`):

```javascript
const TASK_ID = process.env.TASK_ID ?? "unknown";
```

Also update the git config to use configurable author:

Replace:
```javascript
exec("git config --global user.email sub-agent@harness");
exec("git config --global user.name 'Sub Agent'");
```

With:
```javascript
const GIT_AUTHOR_NAME = process.env.GIT_COMMIT_AUTHOR_NAME ?? "Harness Bot";
const GIT_AUTHOR_EMAIL = process.env.GIT_COMMIT_AUTHOR_EMAIL ?? "harness@noreply";
exec(`git config --global user.email "${GIT_AUTHOR_EMAIL}"`);
exec(`git config --global user.name "${GIT_AUTHOR_NAME}"`);
```

Replace the section after `session.dispose()` through `process.exit(0)` with:

```javascript
// ── Commit & push ─────────────────────────────────────────────────────────────
let exitCode = aiSucceeded ? 0 : 1;

try {
  git("add", "-A");
  const diff = execSync("git diff --cached --stat").toString().trim();
  if (!diff) {
    const note = aiSucceeded
      ? "AI agent completed but made no file changes."
      : "AI agent unavailable; placeholder created.";
    writeFileSync(
      "task-output.md",
      `# Task Output\n\nTask: ${TASK_DESCRIPTION}\n\nNote: ${note}\nCompleted at: ${new Date().toISOString()}\n`
    );
    git("add", "-A");
  }
  const finalDiff = execSync("git diff --cached --stat").toString().trim();
  if (finalDiff) {
    git("commit", "-m", `feat: ${TASK_DESCRIPTION.slice(0, 60)}`);
    git("push", "origin", `HEAD:${BRANCH_NAME}`);
    console.log("[sub-agent] Changes pushed to branch:", BRANCH_NAME);
  } else {
    console.log("[sub-agent] No changes to commit");
  }
} catch (commitErr) {
  console.warn("[sub-agent] Commit/push failed:", commitErr.message);
  exitCode = 1;
}

// ── Commit session log ────────────────────────────────────────────────────────
try {
  const { mkdirSync, copyFileSync, existsSync: fsExistsSync } = await import("node:fs");
  const { join } = await import("node:path");

  const sessionJsonl = join(sessionDir, "session.jsonl");
  const logDir = `.harness/logs/sub-agents/${TASK_ID}`;
  const logDest = `${logDir}/session.jsonl`;

  if (fsExistsSync(sessionJsonl)) {
    mkdirSync(logDir, { recursive: true });
    copyFileSync(sessionJsonl, logDest);
    git("add", logDest);
    const logDiff = execSync("git diff --cached --stat").toString().trim();
    if (logDiff) {
      git("commit", "-m", `chore: add agent log for task ${TASK_ID}`);
      git("push", "origin", `HEAD:${BRANCH_NAME}`);
      console.log("[sub-agent] Session log committed for task:", TASK_ID);
    }
  } else {
    console.warn("[sub-agent] No session.jsonl found at:", sessionJsonl);
  }
} catch (logErr) {
  // Best-effort — do not change exit code
  console.warn("[sub-agent] Failed to commit session log:", logErr.message);
}

console.log("[sub-agent] Done, exit code:", exitCode);
process.exit(exitCode);
```

Also pass `TASK_ID` from `taskDispatcher.ts`. In `createSubAgentContainer` call, add `taskId: task.id` to the options object. Check if `containerManager.ts` supports it and add accordingly.

- [ ] **Step 2: Pass TASK_ID from taskDispatcher**

In `backend/src/orchestrator/taskDispatcher.ts`, update the `createSubAgentContainer` call to include `taskId`:

```typescript
      containerId = await createSubAgentContainer(docker, {
        sessionId,
        repoCloneUrl: repository.cloneUrl,
        branchName,
        taskDescription: this.buildTaskPrompt(task),
        taskId: task.id,
      });
```

Check `backend/src/orchestrator/containerManager.ts` to see if `taskId` is already supported, and add it to the env vars if not.

- [ ] **Step 3: Update containerManager to pass TASK_ID (if needed)**

Read `backend/src/orchestrator/containerManager.ts` and find the env var list. Add:

```typescript
`TASK_ID=${options.taskId ?? ""}`,
```

to the container env array. Also update the options interface to include `taskId?: string`.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add sub-agent/runner.mjs backend/src/orchestrator/taskDispatcher.ts backend/src/orchestrator/containerManager.ts
git commit -m "feat: commit sub-agent session log to planning branch on exit"
```

---

### Task 9: Frontend Updates

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/pages/NewProject.tsx`
- Modify: `frontend/src/pages/Chat.tsx`
- Modify: `frontend/src/pages/Dashboard.tsx`
- Modify: `frontend/src/pages/PlanApproval.tsx`

- [ ] **Step 1: Update `frontend/src/lib/api.ts`**

Replace the `Project` interface:

```typescript
export interface Project {
  id: string;
  name: string;
  description?: string;
  source?: { type: "jira" | "freeform" | "github"; jiraTickets?: string[]; githubIssues?: string[]; freeformDescription?: string };
  repositoryIds?: string[];
  primaryRepositoryId?: string;
  planningBranch?: string;
  planningPr?: {
    number: number;
    url: string;
    specApprovedAt?: string;
    planApprovedAt?: string;
  };
  masterSessionPath?: string;
  status:
    | "draft"
    | "brainstorming"
    | "spec_in_progress"
    | "awaiting_spec_approval"
    | "plan_in_progress"
    | "awaiting_plan_approval"
    | "executing"
    | "completed"
    | "failed"
    | "cancelled"
    | "error";
  plan?: Plan;
  createdAt: string;
  updatedAt: string;
}
```

Replace the `Plan` interface (remove `approved` and `approvedAt`):

```typescript
export interface Plan {
  id: string;
  projectId: string;
  content?: string;
  tasks: Task[];
}
```

Update the `create` method signature to include `primaryRepositoryId`:

```typescript
    create: (data: {
      name: string;
      description?: string;
      repositoryIds?: string[];
      primaryRepositoryId?: string;
      source?: { type: "jira" | "freeform" | "github"; jiraTickets?: string[]; githubIssues?: string[]; freeformDescription?: string }
    }) =>
      fetchJson<Project>(`${API_BASE}/projects`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
```

Remove the `approve` method entirely from the `projects` object.

- [ ] **Step 2: Update `frontend/src/pages/NewProject.tsx`**

Add state for primary repo selection. After the existing `selectedRepoIds` state:

```typescript
  const [primaryRepoId, setPrimaryRepoId] = useState<string | null>(null);
```

Add a `useEffect` to auto-select when exactly one repo is chosen:

```typescript
  // Auto-select primary repo when only one is selected
  useEffect(() => {
    if (selectedRepoIds.length === 1) {
      setPrimaryRepoId(selectedRepoIds[0]);
    } else if (!selectedRepoIds.includes(primaryRepoId ?? "")) {
      setPrimaryRepoId(null);
    }
  }, [selectedRepoIds]);
```

Pass `primaryRepositoryId` to the create call:

```typescript
      const project = await api.projects.create({
        name: name.trim(),
        repositoryIds: selectedRepoIds,
        primaryRepositoryId: primaryRepoId ?? selectedRepoIds[0],
        source,
      });
```

Add the Primary Repository UI below the repo chips (the `{selectedRepoIds.length > 0 && ...}` block). Insert after the chips block:

```typescript
        {selectedRepoIds.length >= 2 && (
          <div className="mt-3">
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Primary Repository
              <span className="text-gray-500 font-normal ml-1">(planning branch will be created here)</span>
            </label>
            <select
              value={primaryRepoId ?? ""}
              onChange={(e) => setPrimaryRepoId(e.target.value || null)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
            >
              <option value="">Select primary repository...</option>
              {selectedRepoIds.map((id) => {
                const repo = repositories.find((r) => r.id === id);
                if (!repo) return null;
                return <option key={id} value={id}>{repo.name}</option>;
              })}
            </select>
          </div>
        )}
```

- [ ] **Step 3: Update `frontend/src/pages/Chat.tsx`**

Remove the `plan_ready` handler block. Find and delete:

```typescript
        } else if (msg.type === "plan_ready") {
          // Only navigate if we received deltas in this session (fresh plan).
          // Ignore plan_ready sent on WS reconnect for a pre-existing plan.
          if (hasStreamedRef.current) {
            hasStreamedRef.current = false;
            navigate(`/projects/${id}/plan`, { state: { plan: msg.plan } });
          }
        }
```

Also remove the now-unused `navigate` import if it's only used for plan navigation. Check if `navigate` is used elsewhere in the file first.

Update the `WsClientMessage` type reference and the message type handler:

```typescript
        const msg = data as { type: string; text?: string };
```

- [ ] **Step 4: Update `frontend/src/pages/Dashboard.tsx`**

Replace the `statusColors` map:

```typescript
  const statusColors: Record<string, string> = {
    draft: "bg-gray-700",
    brainstorming: "bg-gray-600",
    spec_in_progress: "bg-blue-600",
    awaiting_spec_approval: "bg-amber-600",
    plan_in_progress: "bg-blue-600",
    awaiting_plan_approval: "bg-amber-600",
    planning: "bg-yellow-600",
    approved: "bg-green-600",
    executing: "bg-blue-700",
    completed: "bg-purple-600",
    failed: "bg-red-600",
    cancelled: "bg-gray-700",
    error: "bg-red-600",
  };

  const statusLabels: Record<string, string> = {
    brainstorming: "Brainstorming",
    spec_in_progress: "Writing Spec",
    awaiting_spec_approval: "Awaiting Spec Approval",
    plan_in_progress: "Writing Plan",
    awaiting_plan_approval: "Awaiting Plan Approval",
    executing: "Executing",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  };
```

Find where the status badge is rendered in the JSX and use `statusLabels`:

```typescript
  // Replace wherever status is shown, e.g.:
  // {project.status}
  // with:
  // {statusLabels[project.status] ?? project.status}
```

- [ ] **Step 5: Replace `frontend/src/pages/PlanApproval.tsx` with a redirect**

Replace the entire file with:

```typescript
import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";

export default function PlanApproval() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  useEffect(() => {
    navigate(`/projects/${id}/chat`, { replace: true });
  }, [id, navigate]);

  return null;
}
```

- [ ] **Step 6: Verify frontend TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/pages/NewProject.tsx frontend/src/pages/Chat.tsx frontend/src/pages/Dashboard.tsx frontend/src/pages/PlanApproval.tsx
git commit -m "feat: update frontend for PR-based planning flow"
```

---

### Task 10: Final Integration Smoke Test

**Files:** None — verification only

- [ ] **Step 1: Run the full backend test suite**

```bash
cd backend && npx vitest run
```

Expected: All tests PASS (no failures)

- [ ] **Step 2: Verify TypeScript across both packages**

```bash
cd backend && npx tsc --noEmit && cd ../frontend && npx tsc --noEmit
```

Expected: No errors in either package

- [ ] **Step 3: Verify Docker Compose starts**

```bash
docker compose up --build --no-start 2>&1 | tail -20
```

Expected: No build errors; images build successfully

- [ ] **Step 4: Final commit with any remaining changes**

```bash
git status
```

If there are any remaining untracked or modified files from this implementation, stage and commit them:

```bash
git add <any remaining files>
git commit -m "chore: finalize PR-based planning flow implementation"
```

- [ ] **Step 5: Push branch**

```bash
git push origin HEAD
```
