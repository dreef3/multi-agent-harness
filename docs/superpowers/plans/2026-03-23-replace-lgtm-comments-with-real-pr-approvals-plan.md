# Implementation Plan: Replace LGTM Comments with PR Approval Polling

**Date:** 2024-03-23  
**Spec:** [2024-03-23-approval-polling-design.md](../specs/2024-03-23-approval-polling-design.md)

> **For agentic workers:** Tasks will be executed by containerised sub-agents. Each sub-agent receives its task via the TASK_DESCRIPTION environment variable.

---

## Overview

This plan implements native PR approval polling to replace the current LGTM comment-based detection. The work is divided into 8 tasks that can be executed in sequence (types and interface first, then implementations).

---

## Task Dependencies

```
Task 1 (VcsApproval type) ─┐
                           ├─→ Task 5 (polling.ts changes)
Task 2 (VcsConnector) ─────┘
        │
        ├─→ Task 3 (GitHub implementation)
        │           │
        │           └─→ Task 6 (GitHub tests)
        │
        └─→ Task 4 (BitBucket implementation)
                    │
                    └─→ Task 7 (BitBucket tests)

Task 8 (Remove detectLgtm tests) - independent
```

---

## Task 1: Add VcsApproval Type

**Repository:** multi-agent-harness  
**File:** `backend/src/models/types.ts`

### Description

Add the `VcsApproval` interface to the types file. This interface will be used by both GitHub and BitBucket connectors to return approval data.

### Steps

- [ ] Open `backend/src/models/types.ts`
- [ ] Add the following interface after the existing `VcsComment` interface (around line 100):

```typescript
export interface VcsApproval {
  /** User identifier (login/username) */
  author: string;
  /** ISO timestamp of when approval was submitted */
  createdAt: string;
}
```

- [ ] Verify TypeScript compiles: `cd backend && bun run build`

### Expected Result

- TypeScript compiles without errors
- `VcsApproval` interface is available for import

---

## Task 2: Add getApprovals to VcsConnector Interface

**Repository:** multi-agent-harness  
**File:** `backend/src/connectors/types.ts`

### Description

Add the `getApprovals` method to the `VcsConnector` interface, making it a required method for all connector implementations.

### Steps

- [ ] Open `backend/src/connectors/types.ts`
- [ ] Import `VcsApproval` type at the top of the file:

```typescript
import type { Repository, VcsComment, VcsApproval } from "../models/types.js";
```

- [ ] Add the `getApprovals` method to the `VcsConnector` interface, after the `commitFile` method:

```typescript
  /**
   * Get approvals on a pull request.
   * Returns list of users who have approved the PR (latest review state per user).
   * For GitHub: reviews with state 'APPROVED'
   * For BitBucket: reviewers with approved: true
   */
  getApprovals(repo: Repository, prId: string): Promise<VcsApproval[]>;
```

- [ ] Verify TypeScript compiles: `cd backend && bun run build`

### Expected Result

- TypeScript compilation shows errors in `github.ts` and `bitbucket.ts` about missing `getApprovals` method (expected)
- The interface is updated and ready for implementation

---

## Task 3: Implement getApprovals in GitHub Connector

**Repository:** multi-agent-harness  
**File:** `backend/src/connectors/github.ts`

### Description

Implement the `getApprovals` method in the GitHub connector using the Octokit Reviews API.

### Steps

- [ ] Open `backend/src/connectors/github.ts`
- [ ] Add import for `VcsApproval` at the top of the file:

```typescript
import type { Repository, VcsComment, VcsApproval } from "../models/types.js";
```

- [ ] Add the `getApprovals` method to the `GitHubConnector` class, after the `commitFile` method:

```typescript
  async getApprovals(repo: Repository, prId: string): Promise<VcsApproval[]> {
    const octokit = this.getOctokit();
    const { owner, repoName } = this.getOwnerRepo(repo);

    try {
      const { data: reviews } = await octokit.pulls.listReviews({
        owner,
        repo: repoName,
        pull_number: parseInt(prId, 10),
      });

      // Build map of latest review state per user
      const latestByUser = new Map<string, { state: string; submittedAt: string }>();
      for (const review of reviews) {
        const login = review.user?.login;
        if (!login) continue;
        const submittedAt = review.submitted_at ?? new Date().toISOString();
        const existing = latestByUser.get(login);
        if (!existing || new Date(submittedAt) > new Date(existing.submittedAt)) {
          latestByUser.set(login, { state: review.state, submittedAt });
        }
      }

      // Filter to only APPROVED states
      const approvals: VcsApproval[] = [];
      for (const [author, data] of latestByUser) {
        if (data.state === "APPROVED") {
          approvals.push({ author, createdAt: data.submittedAt });
        }
      }

      return approvals;
    } catch (error) {
      throw new ConnectorError(
        `Failed to get approvals: ${error instanceof Error ? error.message : String(error)}`,
        "github",
        error
      );
    }
  }
```

- [ ] Add `mockListReviews` mock variable to the test file's mock setup (for tests to use later)
- [ ] Verify TypeScript compiles: `cd backend && bun run build`
- [ ] Run existing tests: `cd backend && bun run test`

### Expected Result

- TypeScript compiles without errors
- All existing tests pass
- GitHub connector implements `getApprovals` method

---

## Task 4: Implement getApprovals in BitBucket Connector

**Repository:** multi-agent-harness  
**File:** `backend/src/connectors/bitbucket.ts`

### Description

Implement the `getApprovals` method in the BitBucket connector using the BitBucket Server API to fetch PR details with reviewer information.

### Steps

- [ ] Open `backend/src/connectors/bitbucket.ts`
- [ ] Add import for `VcsApproval` at the top of the file:

```typescript
import type { Repository, VcsComment, VcsApproval } from "../models/types.js";
```

- [ ] Add the `getApprovals` method to the `BitbucketConnector` class, after the `commitFile` method:

```typescript
  async getApprovals(repo: Repository, prId: string): Promise<VcsApproval[]> {
    const { projectKey, repoSlug, baseUrl } = this.getProjectRepo(repo);

    try {
      const url = `${baseUrl}/rest/api/1.0/projects/${projectKey}/repos/${repoSlug}/pull-requests/${prId}`;
      const pr = await this.fetchJson<{
        reviewers: Array<{
          user: { name: string; displayName?: string };
          approved: boolean;
          lastUpdated?: string;
        }>;
      }>(url);

      const approvals: VcsApproval[] = [];
      for (const reviewer of pr.reviewers ?? []) {
        if (reviewer.approved && reviewer.user?.name) {
          approvals.push({
            author: reviewer.user.name,
            createdAt: reviewer.lastUpdated ?? new Date().toISOString(),
          });
        }
      }

      return approvals;
    } catch (error) {
      throw new ConnectorError(
        `Failed to get approvals: ${error instanceof Error ? error.message : String(error)}`,
        "bitbucket-server",
        error
      );
    }
  }
```

- [ ] Verify TypeScript compiles: `cd backend && bun run build`
- [ ] Run existing tests: `cd backend && bun run test`

### Expected Result

- TypeScript compiles without errors
- All existing tests pass
- BitBucket connector implements `getApprovals` method

---

## Task 5: Update Polling to Use Approvals

**Repository:** multi-agent-harness  
**File:** `backend/src/polling.ts`

### Description

Modify the `pollPlanningPrs` function to use approval polling instead of LGTM comment detection. Remove the `detectLgtm` function and `lgtmPollStates` map.

### Steps

- [ ] Open `backend/src/polling.ts`
- [ ] Delete the `detectLgtm` function (lines ~62-64):

```typescript
// DELETE THIS ENTIRE FUNCTION:
export function detectLgtm(body: string): boolean {
  return /\bLGTM\b/i.test(body);
}
```

- [ ] Delete the `lgtmPollStates` map (around line 67):

```typescript
// DELETE THIS LINE:
const lgtmPollStates = new Map<string, string>(); // projectId → lastSeenCommentAt
```

- [ ] In `pollPlanningPrs` function, find the section that fetches comments and checks for LGTM (around lines 95-115)
- [ ] Replace the comment-based LGTM detection with approval polling:

**Before (find this code):**
```typescript
      const since = lgtmPollStates.get(project.id);
      const comments = await connector.getComments(repo, String(project.planningPr.number), since);

      // Update last seen timestamp
      if (comments.length > 0) {
        const latest = comments[comments.length - 1].createdAt;
        lgtmPollStates.set(project.id, latest);
      }

      console.log(`[polling] project ${project.id}: ${comments.length} new comment(s) since last poll`);
      const hasLgtm = comments.some(c => detectLgtm(c.body));
      console.log(`[polling] project ${project.id}: LGTM detected=${hasLgtm}`);
      if (!hasLgtm) continue;
```

**After (replace with):**
```typescript
      const approvals = await connector.getApprovals(repo, String(project.planningPr.number));
      console.log(`[polling] project ${project.id}: ${approvals.length} approval(s) detected`);
      if (approvals.length === 0) continue;

      const hasApproval = true;
      console.log(`[polling] Approval detected on planning PR for project ${project.id} (status: ${project.status})`);
```

- [ ] Update the log messages for the approval transitions:
  - Replace `"[polling] LGTM detected on planning PR"` with `"[polling] Approval detected on planning PR"`
  - Replace `'"[SYSTEM] The spec has been approved (LGTM received on the PR)."'` with `'"[SYSTEM] The spec has been approved (approval received on the PR)."'`
  - Replace `'"[SYSTEM] The implementation plan has been approved (LGTM received on the PR)."'` with `'"[SYSTEM] The implementation plan has been approved (approval received on the PR)."'`

- [ ] Remove any remaining references to `lgtmPollStates.delete(project.id)` (these should be removed along with the map)
- [ ] Verify TypeScript compiles: `cd backend && bun run build`
- [ ] Run existing tests: `cd backend && bun run test`

### Expected Result

- TypeScript compiles without errors
- All tests pass (except the removed detectLgtm test which will be handled in Task 8)
- Polling uses approval detection instead of LGTM comments

---

## Task 6: Add Tests for GitHub getApprovals

**Repository:** multi-agent-harness  
**File:** `backend/src/__tests__/connectors.test.ts`

### Description

Add unit tests for the `getApprovals` method in the GitHub connector test suite.

### Steps

- [ ] Open `backend/src/__tests__/connectors.test.ts`
- [ ] Add `mockListReviews` mock variable at the top with other mocks:

```typescript
const mockListReviews = vi.fn();
```

- [ ] Update the Octokit mock to include `pulls.listReviews`:

```typescript
vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    // ... existing mocks ...
    pulls: {
      create: mockCreatePR,
      get: mockGetPR,
      listReviewComments: mockListReviewComments,
      listReviews: mockListReviews,  // Add this line
    },
    // ... rest of mocks ...
  })),
}));
```

- [ ] Add a new test suite for `GitHub getApprovals` after the existing GitHub tests:

```typescript
describe("GitHub getApprovals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = "test-token";
  });

  it("returns empty array when no reviews exist", async () => {
    mockListReviews.mockResolvedValue({ data: [] });

    const approvals = await connector.getApprovals(repo, "123");

    expect(approvals).toEqual([]);
    expect(mockListReviews).toHaveBeenCalledWith({
      owner: "test-org",
      repo: "test-repo",
      pull_number: 123,
    });
  });

  it("returns users with APPROVED state only", async () => {
    mockListReviews.mockResolvedValue({
      data: [
        { user: { login: "alice" }, state: "APPROVED", submitted_at: "2024-01-01T00:00:00Z" },
        { user: { login: "bob" }, state: "COMMENTED", submitted_at: "2024-01-01T00:00:00Z" },
        { user: { login: "carol" }, state: "APPROVED", submitted_at: "2024-01-02T00:00:00Z" },
        { user: { login: "dave" }, state: "CHANGES_REQUESTED", submitted_at: "2024-01-01T00:00:00Z" },
      ],
    });

    const approvals = await connector.getApprovals(repo, "123");

    expect(approvals).toHaveLength(2);
    expect(approvals.map((a) => a.author).sort()).toEqual(["alice", "carol"]);
  });

  it("uses latest review state when user has multiple reviews", async () => {
    mockListReviews.mockResolvedValue({
      data: [
        { user: { login: "alice" }, state: "CHANGES_REQUESTED", submitted_at: "2024-01-01T00:00:00Z" },
        { user: { login: "alice" }, state: "APPROVED", submitted_at: "2024-01-02T00:00:00Z" },
      ],
    });

    const approvals = await connector.getApprovals(repo, "123");

    expect(approvals).toHaveLength(1);
    expect(approvals[0].author).toBe("alice");
    expect(approvals[0].createdAt).toBe("2024-01-02T00:00:00Z");
  });

  it("uses latest approved review even when followed by changes requested", async () => {
    mockListReviews.mockResolvedValue({
      data: [
        { user: { login: "alice" }, state: "APPROVED", submitted_at: "2024-01-01T00:00:00Z" },
        { user: { login: "alice" }, state: "CHANGES_REQUESTED", submitted_at: "2024-01-02T00:00:00Z" },
      ],
    });

    const approvals = await connector.getApprovals(repo, "123");

    expect(approvals).toHaveLength(0);
  });

  it("handles missing submitted_at gracefully", async () => {
    mockListReviews.mockResolvedValue({
      data: [{ user: { login: "alice" }, state: "APPROVED", submitted_at: null }],
    });

    const approvals = await connector.getApprovals(repo, "123");

    expect(approvals).toHaveLength(1);
    expect(approvals[0].author).toBe("alice");
    expect(approvals[0].createdAt).toBeDefined();
  });

  it("handles users with null login", async () => {
    mockListReviews.mockResolvedValue({
      data: [
        { user: null, state: "APPROVED", submitted_at: "2024-01-01T00:00:00Z" },
        { user: { login: null }, state: "APPROVED", submitted_at: "2024-01-01T00:00:00Z" },
        { user: { login: "alice" }, state: "APPROVED", submitted_at: "2024-01-01T00:00:00Z" },
      ],
    });

    const approvals = await connector.getApprovals(repo, "123");

    expect(approvals).toHaveLength(1);
    expect(approvals[0].author).toBe("alice");
  });

  it("throws ConnectorError on API failure", async () => {
    mockListReviews.mockRejectedValue(new Error("API error"));

    await expect(connector.getApprovals(repo, "123")).rejects.toThrow(ConnectorError);
  });

  it("throws when GITHUB_TOKEN is not set", async () => {
    delete process.env.GITHUB_TOKEN;
    await expect(connector.getApprovals(repo, "123")).rejects.toThrow(ConnectorError);
    process.env.GITHUB_TOKEN = "test-token";
  });
});
```

- [ ] Run tests: `cd backend && bun run test connectors.test.ts`

### Expected Result

- All new tests pass
- Existing tests continue to pass

---

## Task 7: Add Tests for BitBucket getApprovals

**Repository:** multi-agent-harness  
**File:** `backend/src/__tests__/connectors.test.ts`

### Description

Add unit tests for the `getApprovals` method in the BitBucket connector test suite.

### Steps

- [ ] Open `backend/src/__tests__/connectors.test.ts`
- [ ] Add a new test suite for `Bitbucket getApprovals` after the existing BitBucket tests:

```typescript
describe("Bitbucket getApprovals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BITBUCKET_TOKEN = "test-token";
  });

  it("returns empty array when no reviewers have approved", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        reviewers: [{ user: { name: "alice" }, approved: false }],
      }),
    } as unknown as Response);

    const approvals = await connector.getApprovals(repo, "123");

    expect(approvals).toEqual([]);
  });

  it("returns empty array when reviewers array is empty", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ reviewers: [] }),
    } as unknown as Response);

    const approvals = await connector.getApprovals(repo, "123");

    expect(approvals).toEqual([]);
  });

  it("returns users with approved: true", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        reviewers: [
          { user: { name: "alice" }, approved: true, lastUpdated: "2024-01-01T00:00:00Z" },
          { user: { name: "bob" }, approved: false },
          { user: { name: "carol" }, approved: true, lastUpdated: "2024-01-02T00:00:00Z" },
        ],
      }),
    } as unknown as Response);

    const approvals = await connector.getApprovals(repo, "123");

    expect(approvals).toHaveLength(2);
    expect(approvals.map((a) => a.author).sort()).toEqual(["alice", "carol"]);
  });

  it("includes createdAt from lastUpdated timestamp", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        reviewers: [{ user: { name: "alice" }, approved: true, lastUpdated: "2024-03-15T10:30:00Z" }],
      }),
    } as unknown as Response);

    const approvals = await connector.getApprovals(repo, "123");

    expect(approvals[0].createdAt).toBe("2024-03-15T10:30:00Z");
  });

  it("uses current timestamp when lastUpdated is missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        reviewers: [{ user: { name: "alice" }, approved: true }],
      }),
    } as unknown as Response);

    const approvals = await connector.getApprovals(repo, "123");

    expect(approvals).toHaveLength(1);
    expect(approvals[0].createdAt).toBeDefined();
    // Should be a valid ISO date string
    expect(new Date(approvals[0].createdAt).toISOString()).toBe(approvals[0].createdAt);
  });

  it("handles missing user name gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        reviewers: [
          { user: null, approved: true },
          { user: { name: null }, approved: true },
          { user: { name: "alice" }, approved: true },
        ],
      }),
    } as unknown as Response);

    const approvals = await connector.getApprovals(repo, "123");

    expect(approvals).toHaveLength(1);
    expect(approvals[0].author).toBe("alice");
  });

  it("throws ConnectorError on API failure", async () => {
    mockFetch.mockRejectedValue(new Error("API error"));

    await expect(connector.getApprovals(repo, "123")).rejects.toThrow(ConnectorError);
  });

  it("throws when BITBUCKET_TOKEN is not set", async () => {
    delete process.env.BITBUCKET_TOKEN;
    await expect(connector.getApprovals(repo, "123")).rejects.toThrow(ConnectorError);
    process.env.BITBUCKET_TOKEN = "test-token";
  });
});
```

- [ ] Run tests: `cd backend && bun run test connectors.test.ts`

### Expected Result

- All new tests pass
- Existing tests continue to pass

---

## Task 8: Remove detectLgtm Tests

**Repository:** multi-agent-harness  
**File:** `backend/src/__tests__/polling.test.ts`

### Description

Remove tests for the deleted `detectLgtm` function since it's no longer used.

### Steps

- [ ] Open `backend/src/__tests__/polling.test.ts`
- [ ] Remove the entire `detectLgtm` test suite:

```typescript
// DELETE THIS ENTIRE BLOCK:
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

- [ ] Run tests: `cd backend && bun run test polling.test.ts`

### Expected Result

- Test file compiles without errors
- Remaining tests pass (file may be empty or have other test suites)

---

## Verification

After all tasks are complete:

1. Run full test suite: `cd backend && bun run test`
2. Build project: `cd backend && bun run build`
3. Verify TypeScript compiles without errors

---

## Files Changed Summary

| File | Change |
|------|--------|
| `backend/src/models/types.ts` | Add `VcsApproval` interface |
| `backend/src/connectors/types.ts` | Add `getApprovals` method to `VcsConnector` interface |
| `backend/src/connectors/github.ts` | Implement `getApprovals` for GitHub |
| `backend/src/connectors/bitbucket.ts` | Implement `getApprovals` for BitBucket Server |
| `backend/src/polling.ts` | Replace LGTM detection with approval polling; remove `detectLgtm()` and `lgtmPollStates` |
| `backend/src/__tests__/connectors.test.ts` | Add tests for `getApprovals` |
| `backend/src/__tests__/polling.test.ts` | Remove `detectLgtm` tests |