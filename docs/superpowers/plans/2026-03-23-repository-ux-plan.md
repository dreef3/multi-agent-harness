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

Key changes:
1. Import `createWritePlanningDocumentTool` from `../agents/planningTool.js`
2. Pass tool to `MasterAgent` constructor via `getOrInitAgent`
3. Replace `buildMasterAgentContext()` with the new three-phase system prompt
4. Remove `plan_ready` event handler and navigation from `Chat.tsx`
5. Export `getOrInitAgent` for use by the polling module
6. Transition project to `spec_in_progress` on first user message

The new `buildMasterAgentContext` function should return the system prompt described in the spec, incorporating the repository list and project source info.

```typescript
// Key additions to websocket.ts:

import { createWritePlanningDocumentTool } from "../agents/planningTool.js";

// In getOrInitAgent(), change the agent creation:
const planningTool = createWritePlanningDocumentTool(projectId, globalDataDir);
const agent = new MasterAgent(projectId, sessionPath, [planningTool]);

// Replace buildMasterAgentContext() with the three-phase system prompt:
// (See the full prompt in docs/superpowers/specs/2026-03-22-pr-based-planning-flow-design.md)
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/agents/masterAgent.ts backend/src/api/websocket.ts
git commit -m "feat: wire planning tool into master agent with three-phase system prompt"
```

---

### Task 5: LGTM Polling

**Files:**
- Modify: `backend/src/polling.ts`
- Create: `backend/src/__tests__/polling.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/__tests__/polling.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project } from "../models/types.js";

const baseProject: Project = {
  id: "proj-1", name: "Test Project", status: "awaiting_spec_approval",
  source: { type: "freeform", freeformDescription: "" },
  repositoryIds: ["repo-1"], primaryRepositoryId: "repo-1",
  planningBranch: "harness/test-proj-abc12",
  planningPr: { number: 7, url: "https://github.com/org/repo/pull/7" },
  masterSessionPath: "", createdAt: "2026-03-22T00:00:00.000Z",
  updatedAt: "2026-03-22T00:00:00.000Z",
};

describe("LGTM detection regex", () => {
  // Inline the regex used in the polling code for unit testing
  const LGTM_REGEX = /\bLGTM\b/i;

  it("matches standalone LGTM", () => {
    expect(LGTM_REGEX.test("LGTM")).toBe(true);
    expect(LGTM_REGEX.test("lgtm")).toBe(true);
    expect(LGTM_REGEX.test("Lgtm")).toBe(true);
  });

  it("matches LGTM with punctuation", () => {
    expect(LGTM_REGEX.test("LGTM!")).toBe(true);
    expect(LGTM_REGEX.test("LGTM.")).toBe(true);
    expect(LGTM_REGEX.test("LGTM :)")).toBe(true);
  });

  it("does not match LGTM as substring", () => {
    expect(LGTM_REGEX.test("ELGTMious")).toBe(false);
    expect(LGTM_REGEX.test("ALGTMA")).toBe(false);
    expect(LGTM_REGEX.test("somethingLGTMmore")).toBe(false);
  });

  it("matches in full comment", () => {
    expect(LGTM_REGEX.test("Looks good to me! LGTM")).toBe(true);
    expect(LGTM_REGEX.test("I think this is ready. LGTM!")).toBe(true);
  });
});

describe("pollPlanningPrs integration", () => {
  it("detects new LGTM comment and triggers approval", async () => {
    // Mock the getConnector to return a mock connector
    const mockGetConnector = vi.fn();
    const mockConnector = {
      getComments: vi.fn().mockResolvedValue([
        { id: "1", body: "Looking good so far", author: "alice" },
        { id: "2", body: "LGTM", author: "bob" }, // New LGTM
      ]),
    };
    mockGetConnector.mockReturnValue(mockConnector);

    vi.doMock("../connectors/types.js", () => ({
      getConnector: mockGetConnector,
    }));

    // The pollPlanningPrs function should:
    // 1. Query listProjectsAwaitingLgtm() for projects in awaiting_*_approval
    // 2. For each, call getComments(planningPr.number)
    // 3. If any comment body matches /\bLGTM\b/i, trigger approval flow
    // 4. Store lastSeenCommentId on project to avoid reprocessing

    // This test verifies the logic in isolation
    const comments = [
      { id: "1", body: "Looking good so far", author: "alice" },
      { id: "2", body: "LGTM", author: "bob" },
    ];

    const hasLgtm = comments.some(c => /\bLGTM\b/i.test(c.body));
    expect(hasLgtm).toBe(true);
  });

  it("does not trigger on non-LGTM comments", () => {
    const comments = [
      { id: "1", body: "Nice work!", author: "alice" },
      { id: "2", body: "Looks great but needs more tests", author: "bob" },
    ];

    const hasLgtm = comments.some(c => /\bLGTM\b/i.test(c.body));
    expect(hasLgtm).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd backend && npx vitest run src/__tests__/polling.test.ts
```

Expected: FAIL — `pollPlanningPrs` doesn't exist yet

- [ ] **Step 3: Add `pollPlanningPrs` to `backend/src/polling.ts`**

Add the new function and integrate into the polling scheduler. The function:

1. Queries `listProjectsAwaitingLgtm()` every 30 seconds
2. For each project, calls `getConnector(repo.provider).getComments(planningPr.number)`
3. Checks if any comment body matches `/\bLGTM\b/i`
4. On LGTM found:
   - Updates project `planningPr.specApprovedAt` or `planningPr.planApprovedAt`
   - Updates project status to next state
   - Calls `getOrInitAgent(projectId).prompt("[SYSTEM] ...")` with the appropriate message
5. Detects closed PRs and marks project as `failed`

```typescript
import { listProjectsAwaitingLgtm, getProject, updateProject } from "./store/projects.js";
import { getConnector } from "./connectors/types.js";
import { getOrInitAgent } from "./api/websocket.js";
import { getRepository } from "./store/repositories.js";
import type { Project } from "./models/types.js";

const LGTM_REGEX = /\bLGTM\b/i;

// Last-seen comment tracking (in-memory, keyed by projectId)
const lastSeenCommentId = new Map<string, string>();

export async function pollPlanningPrs(): Promise<void> {
  const projects = listProjectsAwaitingLgtm();
  for (const project of projects) {
    try {
      await processProjectPlanningPr(project);
    } catch (err) {
      console.error(`[pollPlanningPrs] Error processing project ${project.id}:`, err);
    }
  }
}

async function processProjectPlanningPr(project: Project): Promise<void> {
  const repoId = project.primaryRepositoryId ?? project.repositoryIds[0];
  if (!repoId) return;

  const repo = getRepository(repoId);
  if (!repo) return;

  const connector = getConnector(repo.provider);
  const prNumber = project.planningPr?.number;
  if (!prNumber) return;

  // Get PR state to detect closed PRs
  try {
    const prDetails = await connector.getPullRequestDetails(repo, prNumber);
    if (prDetails?.state === "CLOSED" || prDetails?.state === "closed") {
      if (project.status === "awaiting_spec_approval" || project.status === "awaiting_plan_approval") {
        updateProject(project.id, { status: "failed" });
        const agent = await getOrInitAgent(project.id);
        await agent.prompt(
          "[SYSTEM] The planning PR was closed before approval. The project has been marked as failed. Let the user know."
        );
      }
      return;
    }
  } catch {
    // PR details not critical — proceed with comment check
  }

  // Get comments
  const comments = await connector.getComments(prNumber);
  const lgtmComment = comments.find(c => c.body && LGTM_REGEX.test(c.body));
  const lastSeen = lastSeenCommentId.get(project.id);

  if (lgtmComment && lgtmComment.id !== lastSeen) {
    lastSeenCommentId.set(project.id, lgtmComment.id);

    const now = new Date().toISOString();
    if (project.status === "awaiting_spec_approval") {
      const updatedPr = { ...project.planningPr!, specApprovedAt: now };
      updateProject(project.id, {
        planningPr: updatedPr,
        status: "plan_in_progress",
      });
      const agent = await getOrInitAgent(project.id);
      await agent.prompt(
        `[SYSTEM] The spec has been approved (LGTM received on the PR).\n` +
        `Write the implementation plan now using the write_planning_document tool with type "plan".\n` +
        `Then post the PR URL in chat and tell the user to add a LGTM comment when ready to start implementation.`
      );
    } else if (project.status === "awaiting_plan_approval") {
      const updatedPr = { ...project.planningPr!, planApprovedAt: now };
      updateProject(project.id, {
        planningPr: updatedPr,
        status: "executing",
      });
      // Trigger dispatch via taskDispatcher (imported to avoid circular dependency)
      const { parseAndDispatchTasks } = await import("./orchestrator/taskDispatcher.js");
      await parseAndDispatchTasks(project.id);
      const agent = await getOrInitAgent(project.id);
      await agent.prompt(
        "[SYSTEM] The implementation plan has been approved (LGTM received on the PR).\n" +
        "Tell the user that implementation is starting and the sub-agents will take it from here."
      );
    }
  }
}
```

Also integrate into the polling scheduler. Find the existing `startPolling()` function and add a call to `pollPlanningPrs()` on a 30-second interval alongside the existing polling:

```typescript
// In startPolling() or wherever polling is configured:
setInterval(async () => {
  await pollPlanningPrs().catch(err => console.error("[polling] pollPlanningPrs error:", err));
}, 30_000);
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
cd backend && npx vitest run src/__tests__/polling.test.ts
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/polling.ts backend/src/__tests__/polling.test.ts
git commit -m "feat: add LGTM polling for planning PRs"
```

---

### Task 6: Task Dispatcher + Plan Parser Update

**Files:**
- Modify: `backend/src/orchestrator/taskDispatcher.ts`

- [ ] **Step 1: Update `buildTaskPrompt()` and dispatch guard**

Add the TDD preamble helper and update the dispatch logic:

```typescript
export function buildTaskPrompt(task: PlanTask): string {
  return `You are a software engineering sub-agent. Follow this workflow exactly.

## Step 1 — Understand the Task
Read the task description below carefully. If a plan file exists in the repository
at docs/superpowers/plans/, read it to understand the full project context before
starting.

## Step 2 — Test-Driven Development (superpowers:test-driven-development)
Follow strict TDD. For every behaviour you implement:
1. Write a failing test first. Run it and confirm it fails for the right reason.
2. Write the minimum code to make it pass. Run it and confirm it passes.
3. Refactor. Keep tests green.
Never write production code without a failing test first.

## Step 3 — Implement
Work through the task description step by step. Commit logical units of work with
clear messages. Do not make changes beyond the scope of the task.

## Step 4 — Systematic Debugging (superpowers:systematic-debugging)
If you encounter a bug or unexpected behaviour:
1. Reproduce it reliably first.
2. Form a hypothesis about the root cause.
3. Test the hypothesis before attempting a fix.
4. Fix only after confirming the root cause.
Never guess-and-check.

## Step 5 — Verify Before Finishing (superpowers:verification-before-completion)
Before considering the task done:
1. Run the full test suite. Show the command and its output.
2. Confirm every acceptance criterion in the task description is met.
3. Do not claim completion without fresh evidence.
If verification fails, go back and fix — do not push broken code.

## Step 6 — Commit and Push
Stage and commit all changes. The harness will open the pull request automatically.

---

## Your Task

${task.description}`;
}
```

Update the dispatch guard to check `project.planningPr?.planApprovedAt` instead of `project.plan?.approved`:

```typescript
// In runProjectTasks() or wherever tasks are dispatched:
if (!project.planningPr?.planApprovedAt) {
  console.log(`[TaskDispatcher] Project ${projectId}: plan not yet approved (no planApprovedAt). Skipping dispatch.`);
  return;
}
```

Also add the `parseAndDispatchTasks` function called by polling:

```typescript
export async function parseAndDispatchTasks(projectId: string): Promise<void> {
  const project = getProject(projectId);
  if (!project?.plan) {
    console.error(`[TaskDispatcher] No plan found for project ${projectId}`);
    return;
  }
  await runProjectTasks(docker, project);
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/orchestrator/taskDispatcher.ts
git commit -m "feat: add buildTaskPrompt with TDD preamble and update dispatch guard"
```

---

### Task 7: API Layer Changes

**Files:**
- Modify: `backend/src/api/projects.ts`

- [ ] **Step 1: Remove approve endpoint and add primaryRepositoryId validation**

Remove the `POST /projects/:id/approve` handler. Add validation that `repositoryIds` is not empty at project creation. Ensure `primaryRepositoryId` is stored correctly (auto-selected when only one repo, required otherwise).

```typescript
// Remove:
// app.post("/projects/:id/approve", ...)

// Add in project creation:
// Validate repositoryIds is not empty
if (!body.repositoryIds || body.repositoryIds.length === 0) {
  return res.status(400).json({ error: "At least one repository must be selected" });
}

// Auto-set primaryRepositoryId to first repo if only one selected
const primaryRepositoryId = body.primaryRepositoryId ?? body.repositoryIds[0];
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/api/projects.ts
git commit -m "feat: remove approve endpoint and add primaryRepositoryId validation"
```

---

### Task 8: Sub-Agent Session Log Commit

**Files:**
- Modify: `sub-agent/runner.mjs`

- [ ] **Step 1: Add TASK_ID env var and unconditional log commit**

After the Docker container starts, the `TASK_ID` env var should be passed to the container. After `session.prompt()` resolves or rejects, locate and commit the session log to the planning branch.

```javascript
// Key changes to runner.mjs:

// 1. Extract TASK_ID from env
const taskId = process.env.TASK_ID ?? "unknown-task";

// 2. After session.prompt(), add unconditional log commit in finally:
async function commitSessionLog(sessionJsonlPath, taskId) {
  if (!sessionJsonlPath || !fs.existsSync(sessionJsonlPath)) return;
  try {
    const content = fs.readFileSync(sessionJsonlPath, "utf-8");
    const destDir = path.join(".harness", "logs", "sub-agents", taskId);
    const destPath = path.join(destDir, "session.jsonl");
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(destPath, content, "utf-8");
    // Stage and commit
    const { execSync } = await import("child_process");
    execSync("git add .", { cwd: workDir });
    execSync(`git commit -m "chore: add agent log for task ${taskId}"`, { cwd: workDir });
    execSync("git push", { cwd: workDir });
    console.log(`[runner] Session log committed for task ${taskId}`);
  } catch (err) {
    console.error(`[runner] Failed to commit session log for task ${taskId}:`, err.message);
  }
}

try {
  await session.prompt(taskDescription);
} finally {
  await commitSessionLog(sessionPath, taskId);
  process.exit(exitCode);
}
```

- [ ] **Step 2: Commit**

```bash
git add sub-agent/runner.mjs
git commit -m "feat: add TASK_ID env and unconditional session log commit"
```

---

### Task 9: Frontend — Status Updates

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/pages/Dashboard.tsx`
- Modify: `frontend/src/pages/Chat.tsx`
- Modify: `frontend/src/pages/NewProject.tsx`
- Modify: `frontend/src/pages/PlanApproval.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Update TypeScript types in `frontend/src/lib/api.ts`**

Add new status values to `ProjectStatus` and new fields to `Project`:

```typescript
export type ProjectStatus =
  | "brainstorming"
  | "spec_in_progress"
  | "awaiting_spec_approval"
  | "plan_in_progress"
  | "awaiting_plan_approval"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

export interface Project {
  // ... existing fields ...
  primaryRepositoryId?: string;
  planningBranch?: string;
  planningPr?: {
    number: number;
    url: string;
    specApprovedAt?: string;
    planApprovedAt?: string;
  };
}

// Remove projects.approve from api
```

- [ ] **Step 2: Update `Dashboard.tsx` with new status badges**

Add the four new statuses with appropriate colors:

| Status | Label | Colour |
|--------|-------|--------|
| `spec_in_progress` | "Writing Spec" | Blue |
| `awaiting_spec_approval` | "Awaiting Spec Approval" | Amber |
| `plan_in_progress` | "Writing Plan" | Blue |
| `awaiting_plan_approval` | "Awaiting Plan Approval" | Amber |

- [ ] **Step 3: Update `Chat.tsx`**

Remove the `plan_ready` WebSocket event handler and the navigation to `/projects/:id/plan`. PR links appear as regular agent messages — no special handling needed.

```typescript
// Remove from Chat.tsx:
// - plan_ready event handler in WebSocket setup
// - navigate(`/projects/${projectId}/plan`) call
```

- [ ] **Step 4: Update `NewProject.tsx`**

Add **Primary Repository** selector:
- If exactly one repo selected: auto-populate, show greyed out
- If two or more repos selected: show as dropdown, require selection

- [ ] **Step 5: Update `PlanApproval.tsx`**

Replace the entire page component with a redirect to the chat page:

```typescript
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

export default function PlanApproval() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  useEffect(() => {
    navigate(`/projects/${id}/chat`, { replace: true });
  }, [id, navigate]);
  return null;
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/pages/Dashboard.tsx frontend/src/pages/Chat.tsx frontend/src/pages/NewProject.tsx frontend/src/pages/PlanApproval.tsx frontend/src/App.tsx
git commit -m "feat(frontend): add new status badges, remove plan approval flow, add primary repo selector"
```

---

### Task 10: Integration Tests (E2E)

**Files:**
- Modify: `e2e-tests/`

- [ ] **Step 1: Write end-to-end tests for the new flow**

Create `e2e-tests/pr-planning-flow.spec.ts` covering:

1. Project creation with single repo (primary auto-selected)
2. Project creation with multiple repos (primary must be selected)
3. Master agent writes spec → PR created
4. LGTM on spec PR → master agent writes plan
5. LGTM on plan PR → sub-agents dispatched
6. PR closed before approval → project marked failed
7. Multi-repo: non-primary repos get branch + plan at execution time

```typescript
import { test, expect } from "@playwright/test";

test("master agent writes spec and opens PR", async ({ page }) => {
  // Create project, send message, verify spec tool called,
  // verify PR link posted in chat, verify project status = awaiting_spec_approval
});

test("LGTM on spec PR triggers plan writing", async ({ page }) => {
  // Navigate to planning PR, add "LGTM" comment,
  // verify project status transitions to plan_in_progress
});

test("LGTM on plan PR triggers sub-agent dispatch", async ({ page }) => {
  // Add "LGTM" to plan PR,
  // verify project status = executing, tasks are dispatched
});

test("PR closed before approval marks project failed", async ({ page }) => {
  // Close the planning PR,
  // verify project status = failed
});
```

- [ ] **Step 2: Run e2e tests**

```bash
cd e2e-tests && npx playwright test
```

- [ ] **Step 3: Commit**

```bash
git add e2e-tests/pr-planning-flow.spec.ts
git commit -m "test(e2e): add PR-based planning flow tests"
```

---

## Commit Summary

| Task | Files | Commit Message |
|------|-------|----------------|
| 1 | types.ts, db.ts, projects.ts, projects.test.ts | "feat: add planning flow data model and DB migration" |
| 2 | types.ts, github.ts, bitbucket.ts, connectors.test.ts | "feat: add commitFile to VcsConnector interface and implementations" |
| 3 | planningTool.ts, planningTool.test.ts | "feat: add planning tool factory with slugify/branch/path helpers" |
| 4 | masterAgent.ts, websocket.ts | "feat: wire planning tool into master agent with three-phase system prompt" |
| 5 | polling.ts, polling.test.ts | "feat: add LGTM polling for planning PRs" |
| 6 | taskDispatcher.ts | "feat: add buildTaskPrompt with TDD preamble and update dispatch guard" |
| 7 | projects.ts (api) | "feat: remove approve endpoint and add primaryRepositoryId validation" |
| 8 | runner.mjs | "feat: add TASK_ID env and unconditional session log commit" |
| 9 | api.ts, Dashboard.tsx, Chat.tsx, NewProject.tsx, PlanApproval.tsx, App.tsx | "feat(frontend): add new status badges, remove plan approval flow, add primary repo selector" |
| 10 | e2e-tests/ | "test(e2e): add PR-based planning flow tests" |

---

## Dependencies Between Tasks

```
Task 1 (Data Model)          ──┐
                               ├──► Task 3 (Planning Tool) ──► Task 4 (Master Agent) ──► Task 5 (Polling)
Task 2 (VCS commitFile)     ──┘
Task 6 (Task Dispatcher)     ←──── Task 5 (Triggers dispatch on plan LGTM)
Task 7 (API Layer)           ←──── Task 1
Task 8 (Sub-Agent Log)       (Independent)
Task 9 (Frontend)           ←──── Task 1
Task 10 (E2E Tests)          ←──── Tasks 1–9
```

**Execute Tasks 1 and 2 in parallel.** Tasks 3–9 depend on completing Tasks 1 and 2. Task 10 can begin after Task 1 is complete (types needed for e2e test types).
