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

Task C — Optional: Add e2e Playwright test verifying toggle behavior

Goal
Add an end-to-end test that the Dashboard hides completed projects by default and shows them when the toggle is clicked.

Repository context
- e2e tests live in e2e-tests/
- Add file: e2e-tests/tests/dashboard-completed.spec.ts

Test steps
1) Arrange: provide a backend fixture or stub for API /api/projects that returns at least one completed project and another non-completed project. If the e2e harness supports network stubbing, stub the response; otherwise ensure the test environment seeds such projects.
2) Visit the Dashboard page.
3) Assert completed project name is not visible.
4) Click the "Show completed projects" toggle.
5) Assert completed project name and "Completed" badge become visible.

How to run
- cd e2e-tests
- npm ci
- npx playwright test tests/dashboard-completed.spec.ts

Acceptance criteria
- Playwright test passes locally/CI.

Deliverables
- PR adding test and documentation on how to run it and seed data if required.

Notes for implementer
- If adding e2e fixtures is heavy, add the test and mark it @slow or optional; we can iterate on CI integration.

Note: AI agent completed but made no file changes.
Completed at: 2026-03-26T19:32:11.248Z
