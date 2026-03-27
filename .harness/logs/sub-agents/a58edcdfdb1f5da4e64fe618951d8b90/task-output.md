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

Implement Chat header back link and test

Goal: Add a visible "Back to projects" navigation control in Chat header that navigates to '/'. Add a unit test asserting the link exists.

Work to perform (self-contained):

1) Modify frontend/src/pages/Chat.tsx
- Import Link from react-router-dom.
- In the header JSX near <h1 className="text-2xl font-bold">Chat</h1>, add a Link to "/" with aria-label "Back to projects" and visible text like "← Projects" or "Back to projects". Keep existing title and layout. Ensure styling matches existing header styles (text-blue-400 or similar) and is keyboard accessible.

2) Update tests
- Modify frontend/src/pages/Chat.test.tsx and append a test that renders Chat and asserts that a link with name matching /projects/i exists and its href is '/'. Use getByRole('link', { name: /projects/i }).

3) Run frontend tests
- Run: bun run --cwd frontend test
- Ensure all tests pass.

4) Commit and push
- Commit files and push branch named: feat/chat-back-to-projects
- Create a PR referencing the spec PR: https://github.com/dreef3/multi-agent-harness/pull/37

Notes for implementer:
- Do not change any other behavior in Chat.tsx.
- Keep changes minimal and focused.
- If test selectors need small adjustments (e.g., link text), prefer using aria-label to make test robust.

Deliverable: PR URL with the implementation changes and tests.


Note: AI agent completed but made no file changes.
Completed at: 2026-03-27T22:32:08.222Z
