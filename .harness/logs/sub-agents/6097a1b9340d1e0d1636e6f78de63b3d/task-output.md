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

Plan review task: Review the implementation plan at docs/superpowers/plans/2026-03-27-chat-back-nav-and-new-project-history-plan.md

Instructions for the reviewer sub-agent:
- Read the plan document at docs/superpowers/plans/2026-03-27-chat-back-nav-and-new-project-history-plan.md and the spec at docs/superpowers/specs/2026-03-27-chat-back-nav-and-new-project-history-design.md.
- Verify the plan follows the project's conventions and that file paths, test commands, and proposed code snippets are accurate and sufficient for implementation.
- Confirm tests are well-scoped and will catch regressions described in the spec.
- Provide a JSON response with { approved: boolean, issues: Array<{severity: 'blocking'|'non-blocking', file: string, line?: number, message: string}>, comments: string }.

If blocking issues are found, list them precisely and suggest fixes. If approved, return Approved in the JSON.

Deliverable: JSON as described above.

Note: AI agent completed but made no file changes.
Completed at: 2026-03-27T22:29:31.426Z
