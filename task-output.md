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

**Task: Remove detectLgtm Tests**

**Context:** We are replacing LGTM comment polling with native PR approval polling. The `detectLgtm` function has been removed from `polling.ts`, so we need to remove its corresponding tests.

**File to modify:** `backend/src/__tests__/polling.test.ts`

**Steps:**

1. Open `backend/src/__tests__/polling.test.ts`

2. Find and remove the entire `detectLgtm` test suite:

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

3. Run tests: `cd backend && bun run test polling.test.ts`

4. Run all tests to verify nothing else is broken: `cd backend && bun run test`

**Expected Result:**
- Test file compiles without errors
- All remaining tests pass
- The test suite no longer references `detectLgtm`

Note: AI agent completed but made no file changes.
Completed at: 2026-03-24T08:15:08.683Z
