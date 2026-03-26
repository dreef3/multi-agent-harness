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

Task A — Implement Dashboard UI changes (frontend)

Goal
Add a client-side toggle and hide projects with status === "completed" from the default Projects list. When completed projects are shown via the toggle, render them with a muted appearance and disable/hide actions that would resume work.

Repository context
- Repo: multi-agent-harness
- Frontend location: frontend/
- Main file to update: frontend/src/pages/Dashboard.tsx

Detailed requirements
1) New state & toggle
- Add: const [showCompleted, setShowCompleted] = useState(false);
- Add a toggle control in the header next to "+ New Project" with label: "Show completed projects". Default unchecked.
- Accessibility: add aria-label="Show completed projects" and ensure keyboard focusable (use a <label><input type="checkbox" .../></label> or accessible switch component).

2) Client-side filtering
- Replace the projects.map rendering with:
  const visibleProjects = projects.filter(p => p.status !== 'completed' || showCompleted);
  visibleProjects.map(...)

3) Completed project styling and actions
- For visible completed projects (p.status === 'completed'):
  - Apply muted visual style (suggestion: add Tailwind 'opacity-70' and slightly lighter background; keep layout identical).
  - Keep the status badge "Completed" but use a muted badge color (e.g., bg-gray-600 or lower saturation).
  - Disable or hide actions that would start or resume work: hide the "Execute" button and the "Retry" button for completed projects. Keep "Chat" (view) and "Delete" available.
  - Add accessibility: wrap the project card in <article aria-label={`Project ${project.name} — Completed`}>

4) Do not change routing or backend behavior
- Direct links to project detail (/projects/:id/*) must continue to work. This change is list-only.

Acceptance criteria
- By default, projects with status 'completed' are not present in the Dashboard list.
- Toggling "Show completed projects" displays completed projects.
- Completed projects display a visible "Completed" badge and muted visual style.
- Execute/Retry buttons are not actionable for completed projects.

How to test locally
- From repo root:
  cd frontend
  npm ci
  npm test
  npm run dev (or the project's dev/start command) to manually view the UI
- Manual steps:
  - Mock or seed a project with status 'completed' (API mock or local backend) and verify default hidden behavior; enable toggle and verify visibility and disabled actions.

Deliverables
- Create a small focused PR against main with changed files and a clear PR description: summary, testing notes, screenshots, how to run tests.
- Ensure the PR includes updated unit tests (Task B will cover tests, but include any changes needed for UI)

Notes
- Keep the implementation minimal — avoid refactors unrelated to the toggle/filter.
- If a ProjectCard component is factored out, ensure tests are updated accordingly.


---

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


---

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


General notes for implementers
- Create separate PRs for A+B and optionally C, or combine them if preferred; keep PRs small and focused.
- Include screenshots in PR for visual changes.
- Mark any flaky e2e tests as @slow if needed and document how to seed data.

Please implement and open PR(s) against the repository's default branch. Each PR should include testing instructions and a clear description of the change.

Note: AI agent completed but made no file changes.
Completed at: 2026-03-26T19:25:46.963Z
