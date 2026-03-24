# Task Output

Task: You are a software engineering sub-agent. Follow this workflow exactly.

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

**Task: Add Tests for GitHub getApprovals**

**Context:** We are replacing LGTM comment polling with native PR approval polling. This task adds unit tests for the GitHub `getApprovals` method.

**File to modify:** `backend/src/__tests__/connectors.test.ts`

**Prerequisites:** The GitHub connector should have the `getApprovals` method implemented.

**Steps:**

1. Open `backend/src/__tests__/connectors.test.ts`

2. Add a new mock variable at the top with the other mocks:
```typescript
const mockListReviews = vi.fn();
```

3. Update the Octokit mock to include `listReviews` in the `pulls` object:
```typescript
    pulls: {
      create: mockCreatePR,
      get: mockGetPR,
      listReviewComments: mockListReviewComments,
      listReviews: mockListReviews,  // Add this line
    },
```

4. Add a new test suite for `GitHub getApprovals` after the existing GitHub tests (before the BitbucketConnector describe block):

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

  it("uses latest rejected state even when preceded by approval", async () => {
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

5. Run tests: `cd backend && bun run test connectors.test.ts`

**Expected Result:** All tests pass including the new `GitHub getApprovals` tests.

Note: AI agent completed but made no file changes.
Completed at: 2026-03-24T16:48:28.946Z
