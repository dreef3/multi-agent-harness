# PR Approval API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the LGTM comment text-scan in `polling.ts` with a proper VCS PR approval/review API, supporting both GitHub and Bitbucket connectors.

**Architecture:** A new `getPrApprovals()` method is added to the `VcsConnector` interface in `types.ts`. GitHub maps its pull request reviews API (state: `APPROVED`). Bitbucket maps its PR participants API (status: `APPROVED`). `pollPlanningPrs()` in `polling.ts` calls `getPrApprovals()` instead of scanning comment bodies. `detectLgtm` is retained as a deprecated fallback only for local/no-VCS mode when `AUTH_ENABLED=false`.

**Tech Stack:** Existing `@octokit/rest` (GitHub), existing Bitbucket REST client, `better-sqlite3` (no changes), existing polling loop infrastructure.

---

## Tasks

- [ ] **Task 1 — Read the current connector interface**

  Read `backend/src/connectors/types.ts` in full to understand the existing `VcsConnector` interface shape, the `Repository` type, and any existing helper types. This is required before adding new methods.

- [ ] **Task 2 — Add `PrApproval` type and `getPrApprovals` to `VcsConnector` interface**

  In `backend/src/connectors/types.ts`, add the `PrApproval` interface and extend `VcsConnector`:

  ```typescript
  export interface PrApproval {
    userId: string;         // VCS username or login
    state: "approved" | "changes_requested" | "pending";
    submittedAt: string;    // ISO-8601
  }
  ```

  Add to `VcsConnector`:

  ```typescript
  getPrApprovals(repo: Repository, prId: string): Promise<PrApproval[]>;
  ```

  The `prId` is a string because Bitbucket and GitHub both accept string PR numbers, and keeping it a string avoids conversion bugs.

- [ ] **Task 3 — Read `backend/src/connectors/github.ts`**

  Read the GitHub connector implementation to find:
  - The Octokit instance accessor (may be `this.octokit()` or a module-level `octokit`)
  - The `parseRepoUrl` helper (or equivalent)
  - Where to add the new method (class body or exported object)

- [ ] **Task 4 — Implement `getPrApprovals` in the GitHub connector**

  Add the following method to the GitHub connector (inside the class or the connector object, matching the existing pattern):

  ```typescript
  async getPrApprovals(repo: Repository, prId: string): Promise<PrApproval[]> {
    const { owner, repo: repoName } = parseRepoUrl(repo.cloneUrl);
    const octokit = this.getOctokit(); // use existing accessor name
    const { data } = await octokit.pulls.listReviews({
      owner,
      repo: repoName,
      pull_number: parseInt(prId, 10),
    });
    return data.map(r => ({
      userId: r.user?.login ?? "",
      state:
        r.state === "APPROVED"
          ? "approved"
          : r.state === "CHANGES_REQUESTED"
          ? "changes_requested"
          : "pending",
      submittedAt: r.submitted_at ?? new Date().toISOString(),
    }));
  }
  ```

  Note: if the Octokit accessor has a different name (e.g. `this._octokit`, `getOctokit()`, `octokit`), use the actual name found in Task 3.

- [ ] **Task 5 — Read `backend/src/connectors/bitbucket.ts`**

  Read the Bitbucket connector implementation to find:
  - The HTTP helper method used for authenticated GET requests (e.g. `this.get<T>(url)`)
  - How `repo.providerConfig` is typed and what fields it exposes
  - The base URL pattern used by other methods

- [ ] **Task 6 — Implement `getPrApprovals` in the Bitbucket connector**

  Add the following method (adjust field names to match the actual `providerConfig` shape found in Task 5):

  ```typescript
  async getPrApprovals(repo: Repository, prId: string): Promise<PrApproval[]> {
    // Construct the participants endpoint URL using the same pattern as other Bitbucket methods
    const baseUrl = repo.providerConfig.baseUrl;
    const projectKey = repo.providerConfig.projectKey;
    const repoSlug = repo.providerConfig.repoSlug;

    const url =
      `${baseUrl}/rest/api/1.0/projects/${projectKey}/repos/${repoSlug}` +
      `/pull-requests/${prId}/participants`;

    const data = await this.get<{
      values: Array<{
        user: { name: string };
        status: "APPROVED" | "NEEDS_WORK" | "UNAPPROVED";
      }>;
    }>(url);

    return data.values
      .filter(p => p.status === "APPROVED" || p.status === "NEEDS_WORK")
      .map(p => ({
        userId: p.user.name,
        state: p.status === "APPROVED" ? "approved" : "changes_requested",
        submittedAt: new Date().toISOString(), // Bitbucket participants endpoint does not return a timestamp
      }));
  }
  ```

- [ ] **Task 7 — Read `backend/src/polling.ts`**

  Read the full `polling.ts` file to understand:
  - Where `detectLgtm` is called
  - The `lgtmPollStates` map (or equivalent state tracker)
  - The structure of `pollPlanningPrs()` — specifically the loop that processes PRs

- [ ] **Task 8 — Update `pollPlanningPrs()` to use `getPrApprovals`**

  In `backend/src/polling.ts`, replace the LGTM comment scan with an approval check.

  **Before (approximate — match your actual code):**
  ```typescript
  const comments = await connector.getPrComments(repo, String(project.planningPr.number));
  const hasLgtm = comments.some(c => detectLgtm(c.body));
  if (!hasLgtm) continue;
  ```

  **After:**
  ```typescript
  const approvals = await connector.getPrApprovals(repo, String(project.planningPr.number));
  const hasApproval = approvals.some(a => a.state === "approved");
  if (!hasApproval) continue;
  ```

  Also rename the state-tracking map:
  - `lgtmPollStates` → `approvalPollStates` (rename all usages in the file)

  The state map tracks whether we have already acted on an approval to avoid duplicate triggers — the semantics are the same, only the detection mechanism changes.

- [ ] **Task 9 — Deprecate but keep `detectLgtm` for local fallback**

  Keep `detectLgtm` in `polling.ts` but mark it deprecated and gate it on `AUTH_ENABLED=false` + no VCS connector. Add a comment:

  ```typescript
  /**
   * @deprecated Use connector.getPrApprovals() instead.
   * Retained as a fallback for local-only mode (AUTH_ENABLED=false, no VCS connector).
   */
  export function detectLgtm(body: string): boolean {
    return /\bLGTM\b/i.test(body);
  }
  ```

  If there is a local/no-connector code path in the poll loop, it may still use `detectLgtm`. If there is no such path, the function is kept purely for backward compatibility with any external callers or tests.

- [ ] **Task 10 — Verify TypeScript compiles**

  ```bash
  cd backend && bun run tsc --noEmit
  ```

  TypeScript will enforce that both GitHub and Bitbucket connectors fully implement `VcsConnector` including the new `getPrApprovals` method. Fix any missing-implementation errors.

- [ ] **Task 11 — Write unit tests `backend/src/connectors/github-approvals.test.ts`**

  ```typescript
  import { describe, it, expect, vi } from "vitest";

  // Mock Octokit
  const mockListReviews = vi.fn();
  vi.mock("@octokit/rest", () => ({
    Octokit: vi.fn().mockImplementation(() => ({
      pulls: { listReviews: mockListReviews },
    })),
  }));

  // Import after mocking
  // Adjust import path to match actual GitHub connector export
  import { createGithubConnector } from "./github.js";

  const mockRepo = {
    cloneUrl: "https://github.com/org/repo.git",
    providerConfig: {},
  } as unknown as import("./types.js").Repository;

  describe("GitHub getPrApprovals", () => {
    it("maps APPROVED state correctly", async () => {
      mockListReviews.mockResolvedValueOnce({
        data: [
          { user: { login: "alice" }, state: "APPROVED", submitted_at: "2024-01-01T00:00:00Z" },
          { user: { login: "bob" }, state: "CHANGES_REQUESTED", submitted_at: "2024-01-02T00:00:00Z" },
        ],
      });
      const connector = createGithubConnector({ token: "test" });
      const approvals = await connector.getPrApprovals(mockRepo, "42");
      expect(approvals).toHaveLength(2);
      expect(approvals[0]).toEqual({
        userId: "alice",
        state: "approved",
        submittedAt: "2024-01-01T00:00:00Z",
      });
      expect(approvals[1].state).toBe("changes_requested");
    });

    it("maps DISMISSED and COMMENTED as pending", async () => {
      mockListReviews.mockResolvedValueOnce({
        data: [
          { user: { login: "carol" }, state: "COMMENTED", submitted_at: "2024-01-03T00:00:00Z" },
        ],
      });
      const connector = createGithubConnector({ token: "test" });
      const approvals = await connector.getPrApprovals(mockRepo, "43");
      expect(approvals[0].state).toBe("pending");
    });
  });
  ```

  Adjust the import path and constructor pattern to match the actual GitHub connector export.

  Run:
  ```bash
  cd backend && bun test src/connectors/github-approvals.test.ts
  ```

- [ ] **Task 12 — Write unit tests for `polling.ts` approval check `backend/src/polling-approvals.test.ts`**

  ```typescript
  import { describe, it, expect } from "vitest";
  import { detectLgtm } from "./polling.js";

  // detectLgtm is deprecated but must remain working for backward compat
  describe("detectLgtm (deprecated)", () => {
    it("returns true for LGTM", () => expect(detectLgtm("LGTM")).toBe(true));
    it("returns true for lgtm", () => expect(detectLgtm("lgtm")).toBe(true));
    it("returns false for non-LGTM text", () => expect(detectLgtm("looks good")).toBe(false));
    it("returns false for partial match (LGTM as substring in word)", () => expect(detectLgtm("LGTMX")).toBe(false));
  });
  ```

  Run:
  ```bash
  cd backend && bun test src/polling-approvals.test.ts
  ```

---

## Verification Checklist

- [ ] `PrApproval` interface exported from `backend/src/connectors/types.ts`
- [ ] `getPrApprovals()` on `VcsConnector` interface
- [ ] GitHub connector implements `getPrApprovals` using `pulls.listReviews`
- [ ] Bitbucket connector implements `getPrApprovals` using `/participants` endpoint
- [ ] `pollPlanningPrs()` no longer reads PR comments to detect LGTM text
- [ ] `pollPlanningPrs()` calls `getPrApprovals()` and checks `state === "approved"`
- [ ] State-tracking map renamed from `lgtmPollStates` to `approvalPollStates`
- [ ] `detectLgtm` still exported but marked `@deprecated`
- [ ] TypeScript strict-mode compile passes (both connectors fully implement interface)
- [ ] GitHub approval unit tests pass
- [ ] `detectLgtm` backward-compat tests pass
