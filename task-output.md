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

Note: this is retry attempt 1. The branch for this task may contain partial work from a previous attempt — start from its current remote state.

**Task: Implement getApprovals in BitBucket Connector**

**Context:** We are replacing LGTM comment polling with native PR approval polling. This task implements the `getApprovals` method for BitBucket Server using its REST API.

**File to modify:** `backend/src/connectors/bitbucket.ts`

**Prerequisites:** The `VcsApproval` type and `getApprovals` method signature should already be added to the interface.

**Steps:**

1. Open `backend/src/connectors/bitbucket.ts`

2. Update the import to include `VcsApproval`:
```typescript
import type { Repository, VcsComment, VcsApproval } from "../models/types.js";
```

3. Add the `getApprovals` method to the `BitbucketConnector` class, after the `commitFile` method:

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

4. Verify TypeScript compiles: `cd backend && bun run build`

5. Run tests: `cd backend && bun run test`

**Expected Result:** TypeScript compiles without errors. All existing tests pass.

Note: AI agent completed but made no file changes.
Completed at: 2026-03-24T08:38:22.237Z
