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

**Task: Add Tests for BitBucket getApprovals**

**Context:** We are replacing LGTM comment polling with native PR approval polling. This task adds unit tests for the BitBucket `getApprovals` method.

**File to modify:** `backend/src/__tests__/connectors.test.ts`

**Prerequisites:** The BitBucket connector should have the `getApprovals` method implemented.

**Steps:**

1. Open `backend/src/__tests__/connectors.test.ts`

2. Add a new test suite for `Bitbucket getApprovals` after the existing Bitbucket tests (at the end of the file, before the final `getConnector` describe block):

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

3. Run tests: `cd backend && bun run test connectors.test.ts`

**Expected Result:** All tests pass including the new `Bitbucket getApprovals` tests.

Note: AI agent completed but made no file changes.
Completed at: 2026-03-24T17:18:57.786Z
