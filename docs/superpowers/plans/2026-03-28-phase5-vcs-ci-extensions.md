# VCS Connector CI Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `getBuildStatus`, `getPrApprovals`, and `getBuildLogs` methods to the `VcsConnector` interface and implement them in both the GitHub and Bitbucket connectors.

**Architecture:** The `VcsConnector` interface in `backend/src/connectors/types.ts` is extended with three new methods. GitHub uses the Check Runs API (`/repos/{owner}/{repo}/commits/{ref}/check-runs`) for build status and the Actions Job Logs API for log retrieval. Bitbucket Server uses the Build Status REST API (`/rest/build-status/1.0/commits/{ref}`). Two new backend API routes (`GET /api/pull-requests/:id/build-status` and `GET /api/pull-requests/:id/build-logs/:buildId`) expose these methods to the frontend and planning agent.

**Tech Stack:** TypeScript, Octokit (GitHub REST client), Bitbucket Server REST API, Express router, existing `VcsConnector` interface pattern.

---

## Prerequisites

- [ ] Read `backend/src/connectors/types.ts` to understand current `VcsConnector` interface shape
- [ ] Read `backend/src/connectors/github.ts` to understand `parseRepoUrl`, `octokit()`, and `get()` helper patterns
- [ ] Read `backend/src/connectors/bitbucket.ts` to understand `this.get<T>()` and `providerConfig` usage
- [ ] Read `backend/src/api/pullRequests.ts` to understand existing router pattern, `getPullRequest()`, `getRepository()`, `getConnector()` helpers
- [ ] Confirm `PrApproval` type exists (added in phase1-pr-approval plan); if not, define it here

---

## Task 1 — Extend `types.ts` with new types and interface methods

- [ ] Open `backend/src/connectors/types.ts`
- [ ] Add `BuildStatus` type after the existing type definitions:

```typescript
export interface BuildCheckRun {
  name: string;
  status: "success" | "failure" | "pending" | "skipped";
  url: string;
  buildId: string;
  startedAt?: string;
  completedAt?: string;
}

export interface BuildStatus {
  state: "success" | "failure" | "pending" | "unknown";
  checks: BuildCheckRun[];
}
```

- [ ] Confirm `PrApproval` is defined in `connectors/types.ts` (added in `phase1-pr-approval` plan); if absent, add:

```typescript
export interface PrApproval {
  userId: string;         // VCS username or login
  state: "approved" | "changes_requested" | "pending";
  submittedAt: string;    // ISO-8601
}
```

- [ ] Extend `VcsConnector` interface with three new method signatures:

```typescript
export interface VcsConnector {
  // ... existing methods (listRepositories, getPullRequests, etc.) ...

  /**
   * Returns the aggregated CI build status for a git ref (branch name or commit SHA).
   * Polls all check runs / build statuses attached to the ref.
   */
  getBuildStatus(repo: Repository, ref: string): Promise<BuildStatus>;

  /**
   * Returns approvals for the given pull request.
   * Returns an empty array if the provider does not support approvals.
   */
  getPrApprovals(repo: Repository, prId: string): Promise<PrApproval[]>;

  /**
   * Returns raw log text for a specific CI build/check run by its ID.
   * The buildId comes from BuildCheckRun.buildId returned by getBuildStatus.
   * May return a URL string if logs are not directly downloadable.
   */
  getBuildLogs(repo: Repository, buildId: string): Promise<string>;
}
```

- [ ] Run `bunx tsc --noEmit` to confirm type changes compile before proceeding

---

## Task 2 — Implement GitHub connector methods

- [ ] Open `backend/src/connectors/github.ts`
- [ ] Add `getBuildStatus` method to the `GitHubConnector` class:

```typescript
async getBuildStatus(repo: Repository, ref: string): Promise<BuildStatus> {
  const { owner, repo: repoName } = this.parseRepoUrl(repo.cloneUrl);
  const octokit = this.octokit();

  // Check Runs API returns richer data than the legacy Statuses API
  const { data } = await octokit.checks.listForRef({
    owner,
    repo: repoName,
    ref,
    per_page: 100,
  });

  const checks: BuildCheckRun[] = data.check_runs.map((run) => ({
    name: run.name,
    status:
      run.conclusion === "success" ? "success"
      : run.conclusion === "failure" || run.conclusion === "timed_out"
        ? "failure"
      : run.conclusion === "skipped" || run.conclusion === "neutral"
        ? "skipped"
      : "pending",
    url: run.html_url ?? "",
    buildId: String(run.id),
    startedAt: run.started_at ?? undefined,
    completedAt: run.completed_at ?? undefined,
  }));

  const overallState: BuildStatus["state"] =
    checks.some((c) => c.status === "failure") ? "failure"
    : checks.some((c) => c.status === "pending") ? "pending"
    : checks.length > 0 &&
      checks.every((c) => c.status === "success" || c.status === "skipped")
    ? "success"
    : "unknown";

  return { state: overallState, checks };
}
```

- [ ] Add `getPrApprovals` method to the `GitHubConnector` class:

```typescript
async getPrApprovals(repo: Repository, prId: string): Promise<PrApproval[]> {
  const { owner, repo: repoName } = this.parseRepoUrl(repo.cloneUrl);
  const octokit = this.octokit();

  const { data } = await octokit.pulls.listReviews({
    owner,
    repo: repoName,
    pull_number: parseInt(prId, 10),
    per_page: 100,
  });

  // Deduplicate: keep latest review per user
  const latestByUser = new Map<number, typeof data[number]>();
  for (const review of data) {
    if (review.user?.id) {
      latestByUser.set(review.user.id, review);
    }
  }

  return Array.from(latestByUser.values()).map((review) => ({
    userId: String(review.user?.id ?? ""),
    displayName: review.user?.login ?? "",
    approved: review.state === "APPROVED",
    approvedAt:
      review.state === "APPROVED" ? review.submitted_at ?? undefined : undefined,
  }));
}
```

- [ ] Add `getBuildLogs` method to the `GitHubConnector` class:

```typescript
async getBuildLogs(repo: Repository, buildId: string): Promise<string> {
  const { owner, repo: repoName } = this.parseRepoUrl(repo.cloneUrl);
  const octokit = this.octokit();

  // First try: direct job logs via Actions API
  // buildId from getBuildStatus is a check_run_id, not a job_id directly.
  // We need to find the corresponding workflow job.
  try {
    // Get redirect URL for logs (GitHub returns 302)
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/actions/jobs/${buildId}/logs`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
        },
        redirect: "follow",
      }
    );
    if (response.ok) {
      return await response.text();
    }
  } catch {
    // fall through to URL fallback
  }

  // Fallback: return the check run details URL
  try {
    const { data } = await octokit.checks.get({
      owner,
      repo: repoName,
      check_run_id: parseInt(buildId, 10),
    });
    return `Logs available at: ${data.details_url ?? data.html_url}`;
  } catch {
    return `Logs not available for check run ${buildId}`;
  }
}
```

Note: `this.token` requires the GitHub token to be accessible as a class property. Verify that the existing `GitHubConnector` stores the token (e.g., `private token: string`) and add it if absent.

- [ ] Run `bunx tsc --noEmit` from `backend/`

---

## Task 3 — Implement Bitbucket connector methods

- [ ] Open `backend/src/connectors/bitbucket.ts`
- [ ] Add `getBuildStatus` method to the `BitbucketConnector` class:

```typescript
async getBuildStatus(repo: Repository, ref: string): Promise<BuildStatus> {
  const baseUrl = repo.providerConfig.baseUrl as string;

  // Bitbucket Server Build Status REST API (v1)
  const data = await this.get<{
    values: Array<{
      key: string;
      state: "SUCCESSFUL" | "FAILED" | "INPROGRESS";
      url: string;
      dateAdded: number;
      name?: string;
      description?: string;
    }>;
    isLastPage: boolean;
  }>(`${baseUrl}/rest/build-status/1.0/commits/${ref}`);

  const checks: BuildCheckRun[] = data.values.map((v) => ({
    name: v.name ?? v.key,
    status:
      v.state === "SUCCESSFUL" ? "success"
      : v.state === "FAILED" ? "failure"
      : "pending",
    url: v.url,
    buildId: v.key,
    startedAt: v.dateAdded ? new Date(v.dateAdded).toISOString() : undefined,
  }));

  const overallState: BuildStatus["state"] =
    checks.some((c) => c.status === "failure") ? "failure"
    : checks.some((c) => c.status === "pending") ? "pending"
    : checks.length > 0 && checks.every((c) => c.status === "success")
    ? "success"
    : "unknown";

  return { state: overallState, checks };
}
```

- [ ] Add `getPrApprovals` method to the `BitbucketConnector` class:

```typescript
async getPrApprovals(repo: Repository, prId: string): Promise<PrApproval[]> {
  const baseUrl = repo.providerConfig.baseUrl as string;
  const projectKey = repo.providerConfig.projectKey as string;
  const repoSlug = repo.providerConfig.repoSlug as string;

  const data = await this.get<{
    participants: Array<{
      user: { slug: string; displayName: string };
      role: "REVIEWER" | "AUTHOR" | "PARTICIPANT";
      approved: boolean;
      status: "APPROVED" | "UNAPPROVED" | "NEEDS_WORK";
    }>;
  }>(
    `${baseUrl}/rest/api/1.0/projects/${projectKey}/repos/${repoSlug}/pull-requests/${prId}/participants`
  );

  return data.participants
    .filter((p) => p.role === "REVIEWER")
    .map((p) => ({
      userId: p.user.slug,
      displayName: p.user.displayName,
      approved: p.approved,
    }));
}
```

- [ ] Add `getBuildLogs` method to the `BitbucketConnector` class:

```typescript
async getBuildLogs(_repo: Repository, buildId: string): Promise<string> {
  // Bitbucket Server does not natively store build logs.
  // The buildId contains the key (e.g. "JENKINS-JOB-NAME/42") which encodes the CI URL.
  // The caller should use the CiProvider (Jenkins/TeamCity) logs API with this key.
  return `Build logs are stored in your CI provider. Build key: ${buildId}`;
}
```

- [ ] Run `bunx tsc --noEmit` from `backend/`

---

## Task 4 — Add API routes in `backend/src/api/pullRequests.ts`

- [ ] Open `backend/src/api/pullRequests.ts`
- [ ] Add two new routes before the closing of the router:

```typescript
// GET /api/pull-requests/:id/build-status
// Returns the CI build status for the PR's source branch
router.get("/:id/build-status", async (req, res) => {
  try {
    const pr = getPullRequest(req.params.id);
    if (!pr) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }

    const repo = getRepository(pr.repositoryId);
    if (!repo) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }

    const connector = getConnector(repo.provider);
    const status = await connector.getBuildStatus(repo, pr.branch);
    res.json(status);
  } catch (err) {
    console.error("[api] getBuildStatus error:", err);
    res.status(500).json({ error: "Failed to fetch build status" });
  }
});

// GET /api/pull-requests/:id/build-logs/:buildId
// Returns raw logs for a specific CI check run/build
router.get("/:id/build-logs/:buildId", async (req, res) => {
  try {
    const pr = getPullRequest(req.params.id);
    if (!pr) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }

    const repo = getRepository(pr.repositoryId);
    if (!repo) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }

    const connector = getConnector(repo.provider);
    const logs = await connector.getBuildLogs(repo, req.params.buildId);
    res.json({ logs });
  } catch (err) {
    console.error("[api] getBuildLogs error:", err);
    res.status(500).json({ error: "Failed to fetch build logs" });
  }
});

// GET /api/pull-requests/:id/approvals
// Returns reviewer approvals for the PR
router.get("/:id/approvals", async (req, res) => {
  try {
    const pr = getPullRequest(req.params.id);
    if (!pr) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }

    const repo = getRepository(pr.repositoryId);
    if (!repo) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }

    const connector = getConnector(repo.provider);
    const approvals = await connector.getPrApprovals(repo, pr.externalId ?? req.params.id);
    res.json({ approvals });
  } catch (err) {
    console.error("[api] getPrApprovals error:", err);
    res.status(500).json({ error: "Failed to fetch PR approvals" });
  }
});
```

- [ ] Run `bunx tsc --noEmit` from `backend/`
- [ ] Commit: `feat: add getBuildStatus, getPrApprovals, getBuildLogs to VCS connectors and API`

---

## Task 5 — Unit tests

- [ ] Create `backend/src/connectors/__tests__/github.buildStatus.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubConnector } from "../github";

describe("GitHubConnector.getBuildStatus", () => {
  it("returns 'success' when all checks pass", async () => {
    const mockOctokit = {
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              { id: 1, name: "test-backend", conclusion: "success", html_url: "http://example.com", started_at: null, completed_at: null },
              { id: 2, name: "test-frontend", conclusion: "success", html_url: "http://example.com", started_at: null, completed_at: null },
            ],
          },
        }),
      },
    };

    const connector = new GitHubConnector({ token: "test-token" });
    // @ts-expect-error: inject mock
    connector._octokit = mockOctokit;

    const repo = { cloneUrl: "https://github.com/org/repo.git", provider: "github", providerConfig: {} } as any;
    const result = await connector.getBuildStatus(repo, "main");

    expect(result.state).toBe("success");
    expect(result.checks).toHaveLength(2);
  });

  it("returns 'failure' when any check fails", async () => {
    const mockOctokit = {
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              { id: 1, name: "test-backend", conclusion: "failure", html_url: "", started_at: null, completed_at: null },
              { id: 2, name: "test-frontend", conclusion: "success", html_url: "", started_at: null, completed_at: null },
            ],
          },
        }),
      },
    };

    const connector = new GitHubConnector({ token: "test-token" });
    // @ts-expect-error
    connector._octokit = mockOctokit;

    const repo = { cloneUrl: "https://github.com/org/repo.git", provider: "github", providerConfig: {} } as any;
    const result = await connector.getBuildStatus(repo, "feature/foo");

    expect(result.state).toBe("failure");
    expect(result.checks.find(c => c.name === "test-backend")?.status).toBe("failure");
  });

  it("returns 'pending' when checks are in progress", async () => {
    const mockOctokit = {
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              { id: 1, name: "test-backend", conclusion: null, html_url: "", started_at: "2026-01-01T00:00:00Z", completed_at: null },
            ],
          },
        }),
      },
    };

    const connector = new GitHubConnector({ token: "test-token" });
    // @ts-expect-error
    connector._octokit = mockOctokit;

    const repo = { cloneUrl: "https://github.com/org/repo.git", provider: "github", providerConfig: {} } as any;
    const result = await connector.getBuildStatus(repo, "sha-abc123");

    expect(result.state).toBe("pending");
  });

  it("returns 'unknown' when no checks exist", async () => {
    const mockOctokit = {
      checks: {
        listForRef: vi.fn().mockResolvedValue({ data: { check_runs: [] } }),
      },
    };

    const connector = new GitHubConnector({ token: "test-token" });
    // @ts-expect-error
    connector._octokit = mockOctokit;

    const repo = { cloneUrl: "https://github.com/org/repo.git", provider: "github", providerConfig: {} } as any;
    const result = await connector.getBuildStatus(repo, "sha-no-ci");

    expect(result.state).toBe("unknown");
    expect(result.checks).toHaveLength(0);
  });
});
```

- [ ] Run tests: `cd backend && bun run test`

---

## Verification checklist

- [ ] `bunx tsc --noEmit` passes with no errors after all changes
- [ ] `GET /api/pull-requests/:id/build-status` returns 200 with `{ state, checks }` shape
- [ ] `GET /api/pull-requests/:id/build-logs/:buildId` returns 200 with `{ logs }` shape
- [ ] `GET /api/pull-requests/:id/approvals` returns 200 with `{ approvals }` shape
- [ ] 404 is returned for unknown PR IDs on all three routes
- [ ] GitHub `getBuildStatus` correctly maps `conclusion: "skipped"` to `status: "skipped"`
- [ ] Bitbucket `getBuildStatus` handles empty `values` array returning `state: "unknown"`
- [ ] All 4 unit test cases pass
