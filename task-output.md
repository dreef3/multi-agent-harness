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

**Task: Update Polling to Use Approvals Instead of LGTM Comments**

**Context:** We are replacing LGTM comment polling with native PR approval polling. This task updates the polling logic and removes the old LGTM detection.

**File to modify:** `backend/src/polling.ts`

**Steps:**

1. Open `backend/src/polling.ts`

2. Remove the `detectLgtm` function (around lines 62-64):
```typescript
// DELETE THIS ENTIRE FUNCTION:
export function detectLgtm(body: string): boolean {
  return /\bLGTM\b/i.test(body);
}
```

3. Remove the `lgtmPollStates` map (around line 67):
```typescript
// DELETE THIS LINE:
const lgtmPollStates = new Map<string, string>(); // projectId → lastSeenCommentAt
```

4. In the `pollPlanningPrs` function, find the section that fetches comments and checks for LGTM. Replace the comment-based detection with approval polling:

**Find this code block:**
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

**Replace with:**
```typescript
      const approvals = await connector.getApprovals(repo, String(project.planningPr.number));
      console.log(`[polling] project ${project.id}: ${approvals.length} approval(s) detected`);
      if (approvals.length === 0) continue;

      console.log(`[polling] Approval detected on planning PR for project ${project.id} (status: ${project.status})`);
```

5. Update the system messages to reflect approval instead of LGTM:
- Change `"[SYSTEM] The spec has been approved (LGTM received on the PR)."` to `"[SYSTEM] The spec has been approved (approval received on the PR)."`
- Change `"[SYSTEM] The implementation plan has been approved (LGTM received on the PR)."` to `"[SYSTEM] The implementation plan has been approved (approval received on the PR)."`

6. Remove any remaining `lgtmPollStates.delete(project.id)` calls (they were used to track comment timestamps for incremental polling, but approvals don't need this).

7. Verify TypeScript compiles: `cd backend && bun run build`

8. Run tests: `cd backend && bun run test`

**Expected Result:** TypeScript compiles without errors. The polling now uses approval detection instead of LGTM comment matching.

Note: AI agent completed but made no file changes.
Completed at: 2026-03-24T21:05:12.184Z
