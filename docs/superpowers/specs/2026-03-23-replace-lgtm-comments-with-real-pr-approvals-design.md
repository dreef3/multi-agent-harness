# Design Spec: Replace LGTM Comments with PR Approval Polling

**Date:** 2024-03-23  
**Status:** Draft  
**Author:** Planning Agent

---

## Problem Statement

The current implementation detects PR approvals by scanning comments for the text "LGTM". This is fragile and doesn't leverage native approval mechanisms provided by both GitHub and BitBucket Server. Both platforms support formal PR approvals that:

- Provide clear visual indicators in the UI
- Track which reviewers have approved
- Distinguish between "approved", "changes requested", and "commented" states

## Proposed Solution

Replace LGTM comment polling with native approval polling using platform-specific APIs:

- **GitHub**: Use the Reviews API to check for reviews with state `APPROVE`
- **BitBucket Server**: Use the PR reviewers API to check approval status

## Scope

### In Scope

- Add `getApprovals()` method to `VcsConnector` interface
- Implement for both GitHub and BitBucket Server connectors
- Modify `pollPlanningPrs()` in `polling.ts` to use approvals instead of LGTM comments
- Remove the `detectLgtm()` function
- Add unit tests for new functionality

### Out of Scope

- User/role-based approval restrictions (future enhancement)
- Approval count thresholds (future enhancement)
- Changes to sub-agent PR workflow (fix-run comments)

## Design Decisions

### Decision 1: Approval Qualification

**Decision:** Any user's approval counts, including the PR author.

**Rationale:** Matches current LGTM behavior where any comment containing "LGTM" triggers approval. This is the simplest approach for MVP.

### Decision 2: Multiple Review States

**Decision:** Only the latest review state per user matters. If a user requested changes but then approved, their approval counts.

**Rationale:** This is the expected behavior on both platforms - users can update their review state.

### Decision 3: Approach Selection

**Decision:** Add a new `getApprovals()` method to the `VcsConnector` interface.

**Rationale:** 
- Clean separation of concerns - approvals vs comments
- Easy to extend later (e.g., filter by users, count approvals)
- Explicit return type makes contract clear

---

## Technical Design

### 1. New Types

Add to `models/types.ts`:

```typescript
export interface VcsApproval {
  /** User identifier (login/username) */
  author: string;
  /** ISO timestamp of when approval was submitted */
  createdAt: string;
}
```

### 2. VcsConnector Interface Changes

Add to `connectors/types.ts`:

```typescript
export interface VcsConnector {
  // ... existing methods ...

  /**
   * Get approvals on a pull request.
   * Returns list of users who have approved the PR (latest review state per user).
   * For GitHub: reviews with state 'APPROVED'
   * For BitBucket: reviewers with approved: true
   */
  getApprovals(repo: Repository, prId: string): Promise<VcsApproval[]>;
}
```

### 3. GitHub Implementation

**API Endpoint:**
```
GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews
```

**Implementation in `connectors/github.ts`:**

```typescript
async getApprovals(repo: Repository, prId: string): Promise<VcsApproval[]> {
  const octokit = this.getOctokit();
  const { owner, repoName } = this.getOwnerRepo(repo);

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
    if (data.state === 'APPROVED') {
      approvals.push({ author, createdAt: data.submittedAt });
    }
  }

  return approvals;
}
```

### 4. BitBucket Server Implementation

**API Endpoint:**
```
GET /rest/api/1.0/projects/{projectKey}/repos/{repoSlug}/pull-requests/{prId}
```

**Implementation in `connectors/bitbucket.ts`:**

```typescript
async getApprovals(repo: Repository, prId: string): Promise<VcsApproval[]> {
  const { projectKey, repoSlug, baseUrl } = this.getProjectRepo(repo);

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
}
```

### 5. Polling Changes

**File:** `polling.ts`

#### Remove LGTM Detection

Delete the `detectLgtm()` function:

```typescript
// DELETE THIS FUNCTION:
export function detectLgtm(body: string): boolean {
  return /\bLGTM\b/i.test(body);
}
```

#### Update `pollPlanningPrs()`

Replace comment-based LGTM detection with approval polling:

```typescript
// In pollPlanningPrs():

// OLD:
const comments = await connector.getComments(repo, String(project.planningPr.number), since);
const hasLgtm = comments.some(c => detectLgtm(c.body));

// NEW:
const approvals = await connector.getApprovals(repo, String(project.planningPr.number));
if (approvals.length === 0) continue;

console.log(`[polling] ${approvals.length} approval(s) detected on planning PR for project ${project.id}`);
```

#### Remove `lgtmPollStates` Map

```typescript
// DELETE:
const lgtmPollStates = new Map<string, string>(); // projectId → lastSeenCommentAt
```

Since approvals don't need incremental polling, this state tracking is no longer needed.

### 6. Optional: Rename Store Function

Consider renaming for clarity:

- `listProjectsAwaitingLgtm` → `listProjectsAwaitingApproval`

This requires updating:
- `store/projects.ts` function name
- `polling.ts` import and usage

---

## Testing Strategy

### Unit Tests

#### GitHub Connector (`connectors.test.ts`)

```typescript
describe("GitHub getApprovals", () => {
  it("returns empty array when no reviews exist", async () => {
    mockListReviews.mockResolvedValue({ data: [] });
    const approvals = await connector.getApprovals(repo, "123");
    expect(approvals).toEqual([]);
  });

  it("returns users with APPROVED state", async () => {
    mockListReviews.mockResolvedValue({
      data: [
        { user: { login: "alice" }, state: "APPROVED", submitted_at: "2024-01-01T00:00:00Z" },
        { user: { login: "bob" }, state: "COMMENTED", submitted_at: "2024-01-01T00:00:00Z" },
        { user: { login: "carol" }, state: "APPROVED", submitted_at: "2024-01-02T00:00:00Z" },
      ]
    });
    const approvals = await connector.getApprovals(repo, "123");
    expect(approvals).toHaveLength(2);
    expect(approvals.map(a => a.author).sort()).toEqual(["alice", "carol"]);
  });

  it("uses latest review state when user has multiple reviews", async () => {
    mockListReviews.mockResolvedValue({
      data: [
        { user: { login: "alice" }, state: "CHANGES_REQUESTED", submitted_at: "2024-01-01T00:00:00Z" },
        { user: { login: "alice" }, state: "APPROVED", submitted_at: "2024-01-02T00:00:00Z" },
      ]
    });
    const approvals = await connector.getApprovals(repo, "123");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].author).toBe("alice");
  });

  it("handles missing submitted_at gracefully", async () => {
    mockListReviews.mockResolvedValue({
      data: [{ user: { login: "alice" }, state: "APPROVED", submitted_at: null }]
    });
    const approvals = await connector.getApprovals(repo, "123");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].createdAt).toBeDefined();
  });
});
```

#### BitBucket Connector (`connectors.test.ts`)

```typescript
describe("Bitbucket getApprovals", () => {
  it("returns empty array when no reviewers approved", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        reviewers: [{ user: { name: "alice" }, approved: false }]
      })
    });
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
        ]
      })
    });
    const approvals = await connector.getApprovals(repo, "123");
    expect(approvals).toHaveLength(2);
    expect(approvals.map(a => a.author).sort()).toEqual(["alice", "carol"]);
  });

  it("throws ConnectorError on API failure", async () => {
    mockFetch.mockRejectedValue(new Error("API error"));
    await expect(connector.getApprovals(repo, "123")).rejects.toThrow(ConnectorError);
  });
});
```

#### Polling Tests (`polling.test.ts`)

Remove `detectLgtm` tests and update any integration-style tests that mock approval detection.

### Integration Testing

Manual testing plan:

1. Create a test project with a spec PR
2. Verify no approvals → project stays in `awaiting_spec_approval`
3. Add approval via GitHub UI → project transitions to `plan_in_progress`
4. Repeat for plan approval flow with BitBucket Server

---

## Files Changed

| File | Change |
|------|--------|
| `backend/src/models/types.ts` | Add `VcsApproval` interface |
| `backend/src/connectors/types.ts` | Add `getApprovals` method to `VcsConnector` interface |
| `backend/src/connectors/github.ts` | Implement `getApprovals` for GitHub |
| `backend/src/connectors/bitbucket.ts` | Implement `getApprovals` for BitBucket Server |
| `backend/src/polling.ts` | Replace LGTM detection with approval polling; remove `detectLgtm()` and `lgtmPollStates` |
| `backend/src/store/projects.ts` | (Optional) Rename `listProjectsAwaitingLgtm` to `listProjectsAwaitingApproval` |
| `backend/src/__tests__/connectors.test.ts` | Add tests for `getApprovals` |
| `backend/src/__tests__/polling.test.ts` | Remove `detectLgtm` tests |

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| GitHub/BitBucket API rate limits | Approvals API calls are minimal (one per polling cycle). Same pattern as existing `getComments`. |
| Approval timestamp unavailable on BitBucket | Fall back to `new Date().toISOString()`; this doesn't affect approval detection. |
| Breaking change for LGTM-comment users | Document the change; users must use proper approval mechanism. |

---

## Success Criteria

- [ ] `getApprovals()` implemented for both GitHub and BitBucket Server
- [ ] Polling uses approval detection instead of LGTM comments
- [ ] All existing tests pass
- [ ] New tests for `getApprovals()` pass
- [ ] Manual validation on both platforms