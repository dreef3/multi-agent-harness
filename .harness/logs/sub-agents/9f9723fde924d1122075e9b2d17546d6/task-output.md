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

Files to modify
- frontend/src/pages/Dashboard.tsx — primary changes
- frontend/src/index.css or Tailwind classes — add muted styling if needed
- (optional) any shared component files if you refactor a card component

Detailed requirements
1) Add component state and toggle
- Add: const [showCompleted, setShowCompleted] = useState(false);
- Render a toggle control (checkbox or accessible switch) in the header area, right of the "Projects" title or near "+ New Project".
- Toggle label: "Show completed projects". Default unchecked.
- Accessibility: aria-label="Show completed projects" and keyboard focus.

2) Client-side filtering
- Replace the projects.map with a filtered list:
  const visibleProjects = projects.filter(p => p.status !== 'completed' || showCompleted);
- Render visibleProjects instead of projects.

3) Styling and actions for completed projects
- For projects with status === 'completed' when shown:
  - Apply muted visual style (suggestion: add Tailwind class 'opacity-70' or 'bg-gray-800' + reduced text contrast). Keep overall layout consistent.
  - Keep the status badge "Completed". Consider using a less-saturated badge color for completed state.
  - Disable or hide actions that would mutate project/execution state: hide "Execute" button or render it disabled; hide "Retry". Keep "Chat" and "Delete" as present (delete remains destructive and allowed in current UX).
  - Provide title/aria-label on the card: e.g., <article aria-label={`Project ${project.name} — Completed`}> so screen readers clearly announce.

4) Behavior: direct project links
- Do not block direct navigation to /projects/:id/* for completed projects. The Dashboard filtering is list-only.

Acceptance criteria
- By default a project with status 'completed' is not present in the rendered list.
- Toggle reveals completed projects.
- Completed projects display a visible "Completed" badge and muted visual style.
- Execute/Retry buttons are not actionable for completed projects.

How to test locally
- From repository root:
  cd frontend
  npm ci
  npm test (or the project's normal test command)
- Manual check: run the app and visit the Dashboard with a project mocked as status 'completed'.

Notes for implementer
- Keep changes minimal and avoid refactoring unrelated logic; aim for small PR with clear unit tests.
- If you introduce a small UI component for the toggle, ensure it is accessible and documented in the PR.


---

Task B — Update frontend unit tests (vitest)

Goal
Update Dashboard unit tests to verify default hiding of completed projects and toggle behaviour.

Files to modify
- frontend/src/pages/Dashboard.test.tsx

Detailed requirements
1) New tests to add:
- Test: A project with status 'completed' is NOT visible by default.
  - Mock api.projects.list to return [projectCompleted, projectOther]. Render Dashboard and assert that completed project is not in document.
- Test: Toggling "Show completed projects" displays completed project.
  - Mock api.projects.list to return [projectCompleted]. Render Dashboard, find toggle, click it, then assert completed project name and badge are in document.
- Test: Execute button disabled for completed projects when visible.
  - Mock a completed project; after revealing via toggle, query Execute button and assert it is disabled or absent.

2) Update any existing tests that assumed completed projects appear by default.

How to run tests
- cd frontend
- npm ci
- npm test

Acceptance criteria
- All Dashboard.test.tsx tests pass locally.

Notes for implementer
- Use existing test harness patterns and mocked api from the repository's current tests (see existing Dashboard.test.tsx for example).


---

Task C — Optional: Add e2e Playwright test (recommended)

Goal
Add an end-to-end test that verifies completed projects are hidden by default and are displayed when the toggle is enabled.

Files to add/modify
- e2e-tests/tests/dashboard-completed.spec.ts (new)

Test steps (Playwright)
1) Prepare test fixture or mock API to serve at least one completed project.
   - If the e2e test suite has fixtures or a way to stub API responses, use that; otherwise spin up a test server with known projects.
2) Visit the Dashboard page.
3) Assert that the completed project's name is not visible on the page.
4) Click the "Show completed projects" toggle.
5) Assert that the completed project's name and status badge become visible.

How to run
- cd e2e-tests
- npm ci
- npx playwright test tests/dashboard-completed.spec.ts

Acceptance criteria
- Playwright test passes in CI/local run.

Notes for implementer
- If adding e2e fixtures is heavy, add the test and mark it @slow or optional; we can iterate on CI integration.


General submission instructions (for each task)
- Create a small focused PR targeting the repo's main branch.
- In the PR description include: problem summary, files changed, screenshots (for UI) and how to run tests locally.
- Link unit tests and e2e tests in PR description and ensure CI passes.


Please implement tasks in parallel as independent PRs or combined into one small PR if you prefer. Each task is self-contained and includes test requirements and acceptance criteria.


Note: AI agent completed but made no file changes.
Completed at: 2026-03-26T19:23:10.825Z
