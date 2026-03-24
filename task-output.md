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

**Task: Add VcsApproval Type and Update VcsConnector Interface**

**Context:** We are replacing LGTM comment polling with native PR approval polling for both GitHub and BitBucket Server.

**Files to modify:**
1. `backend/src/models/types.ts`
2. `backend/src/connectors/types.ts`

**Steps:**

1. Open `backend/src/models/types.ts` and add the following interface after the existing `VcsComment` interface (around line 100):

```typescript
export interface VcsApproval {
  /** User identifier (login/username) */
  author: string;
  /** ISO timestamp of when approval was submitted */
  createdAt: string;
}
```

2. Open `backend/src/connectors/types.ts` and update the import at the top to include `VcsApproval`:

```typescript
import type { Repository, VcsComment, VcsApproval } from "../models/types.js";
```

3. In the same file, add the `getApprovals` method to the `VcsConnector` interface, after the `commitFile` method:

```typescript
  /**
   * Get approvals on a pull request.
   * Returns list of users who have approved the PR (latest review state per user).
   * For GitHub: reviews with state 'APPROVED'
   * For BitBucket: reviewers with approved: true
   */
  getApprovals(repo: Repository, prId: string): Promise<VcsApproval[]>;
```

4. Verify TypeScript compiles: `cd backend && bun run build`

5. Run tests: `cd backend && bun run test`

**Expected Result:** TypeScript compiles (will show errors in github.ts and bitbucket.ts about missing method - that's expected for now). All existing tests pass.

Note: AI agent completed but made no file changes.
Completed at: 2026-03-24T16:52:27.248Z
