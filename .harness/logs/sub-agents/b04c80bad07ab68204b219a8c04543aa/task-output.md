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

Task B — Update frontend unit tests (vitest)

Goal
Update and add unit tests to verify Dashboard default filtering and toggle behaviour.

Repository context
- File to update: frontend/src/pages/Dashboard.test.tsx
- Test framework: vitest + @testing-library/react

Test cases to add/update
1) Default behavior: completed project hidden
- Mock api.projects.list to return an array including a project with status 'completed'. Render Dashboard and assert the completed project's name is NOT in the document by default.

2) Toggle behavior: showing completed projects
- After rendering Dashboard with api.projects.list returning a completed project, click the toggle "Show completed projects" and assert the completed project name and status badge are present.

3) Disabled actions for completed projects
- When the completed project is shown, assert that the Execute button is not present (or is disabled) and that the Retry button is not present.

4) Regression updates
- Adjust existing tests if they rely on completed projects being visible by default (update mocks/assertions accordingly).

How to run tests
- cd frontend
- npm ci
- npm test

Acceptance criteria
- The updated Dashboard.test.tsx passes locally and in CI.

Deliverables
- Small PR with test updates and any necessary small UI change to make tests deterministic.
- Include in PR description how tests were run and what mocks were used.

Notes for implementer
- Use existing test harness patterns and mocked api from the repository's current tests (see existing Dashboard.test.tsx for example).

Note: AI agent completed but made no file changes.
Completed at: 2026-03-26T19:28:41.801Z
