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

**Task: Implement getApprovals in GitHub Connector**

**Context:** We are replacing LGTM comment polling with native PR approval polling. This task implements the `getApprovals` method for GitHub using the Reviews API.

**File to modify:** `backend/src/connectors/github.ts`

**Prerequisites:** The `VcsApproval` type and `getApprovals` method signature should already be added to the interface.

**Steps:**

1. Open `backend/src/connectors/github.ts`

2. Update the import to include `VcsApproval`:
```typescript
import type { Repository, VcsComment, VcsApproval } from "../models/types.js";
```

3. Add the `getApprovals` method to the `GitHubConnector` class, after the `commitFile` method:

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

4. Verify TypeScript compiles: `cd backend && bun run build`

5. Run tests: `cd backend && bun run test`

**Expected Result:** TypeScript compiles without errors. All existing tests pass.

Note: AI agent completed but made no file changes.
Completed at: 2026-03-24T22:53:14.900Z
