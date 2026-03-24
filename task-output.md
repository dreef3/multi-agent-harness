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

**Task: Implement getApprovals in BitBucket Connector**

## Context
This task failed earlier. The feature requires implementing the getApprovals method in the BitBucket connector.

## Implementation Details

In `backend/src/connectors/bitbucket.ts`, add the `getApprovals` method:

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

## Verification
Run: `cd backend && bun test connectors.test.ts`

All tests must pass.

Note: AI agent completed but made no file changes.
Completed at: 2026-03-24T22:39:38.315Z
