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

**Task: Complete VcsApproval Implementation for Approval Polling**

## Context
The feature to replace LGTM comments with native PR approvals was never fully implemented. The spec at `docs/superpowers/specs/2024-03-23-approval-polling-design.md` outlines what needs to be done.

## Required Changes

### 1. Add VcsApproval Type
Add to `backend/src/models/types.ts`:
```typescript
export interface VcsApproval {
  /** User identifier (login/username) */
  author: string;
  /** ISO timestamp of when approval was submitted */
  createdAt: string;
}
```

### 2. Update VcsConnector Interface
Add to `backend/src/connectors/types.ts`:
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

### 3. Implement getApprovals in GitHub Connector
In `backend/src/connectors/github.ts`, add the method that:
- Uses `octokit.pulls.listReviews()` to get all reviews
- Filters for the latest review state per user
- Returns only those with `APPROVED` state
- Handles missing `submitted_at` gracefully

### 4. Implement getApprovals in BitBucket Connector
In `backend/src/connectors/bitbucket.ts`, add the method that:
- Fetches PR details from `/rest/api/1.0/projects/{projectKey}/repos/{repoSlug}/pull-requests/{prId}`
- Returns reviewers where `approved: true`
- Handles missing `lastUpdated` gracefully

### 5. Update Polling
In `backend/src/polling.ts`:
- Remove the `detectLgtm()` function
- Remove `lgtmPollStates` Map
- Update `pollPlanningPrs()` to use `getApprovals()` instead of LGTM comment detection

### 6. Add Unit Tests
Add tests for `getApprovals` in `backend/src/__tests__/connectors.test.ts`:
- Test empty results
- Test filtering for APPROVED state only
- Test that latest review state is used when multiple reviews exist
- Test error handling

### Verification
```bash
cd backend && bun test
```

All tests must pass.

Note: AI agent completed but made no file changes.
Completed at: 2026-03-24T23:12:10.412Z
