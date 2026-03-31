Implementation Plan: UI-only — Hide Completed Projects

Overview

This plan implements the approved UI-only change: hide projects with status === "completed" from the default Projects list. The change is frontend-only and non-destructive. No backend or DB work is required.

Goals

- By default, the Dashboard / Projects list should not display projects whose status is "completed".
- Add a toggle "Show completed projects" (default off) to reveal completed projects when enabled.
- Completed projects that are shown should be visually muted and include a "Completed" badge.
- Actions that would resume or restart work (e.g., "Retry", "Execute") should be disabled or hidden for completed projects. Read-only actions (View/Chat) and Delete may remain available per current UX.
- Ensure accessibility: toggle keyboard focusable and has aria-label; badge announced to screen readers.

Scope (frontend-only)

Files likely to change
- frontend/src/pages/Dashboard.tsx — add toggle, client-side filter, conditional styling, disable actions
- frontend/src/pages/Dashboard.test.tsx — update tests and add new tests for toggle/filter behavior
- frontend/src/components/* (if ProjectCard component exists) — but current code renders cards directly in Dashboard.tsx, so changes mainly in Dashboard.tsx
- frontend/src/index.css or Tailwind classes — add muted styling if needed
- docs/ or README — note the UI change (optional)

Detailed Implementation Tasks (for engineer)

1) Dashboard UI changes
- Add local state: const [showCompleted, setShowCompleted] = useState(false);
- Add a toggle control in the header (right side, near + New Project) labeled "Show completed projects". Implementation guidance:
  - Use a checkbox or accessible switch control.
  - Provide aria-label="Show completed projects" and keyboard focus styles.
- When rendering the list, filter projects client-side:
  - const visibleProjects = projects.filter(p => p.status !== 'completed' || showCompleted);
  - Use visibleProjects.map(...) instead of projects.map(...).
- For completed projects (p.status === 'completed') when they are shown:
  - Apply a muted visual style: e.g., reduce opacity, change background to a slightly lighter/dimmer color, or add 'opacity-60' Tailwind class.
  - Ensure the status badge still reads "Completed" (existing statusLabels already contain Completed). Optionally add a distinct muted badge style.
  - Disable or hide actions that should not be actionable: "Execute" should be disabled; "Retry" is irrelevant for completed. Keep "Chat"/"View" and "Delete" as per current UX.
  - Add title / aria-label to the card or badge so screen readers announce "Completed project".
- If project.description is undefined, keep existing fallback behavior.

2) Tests — unit tests (vitest/Jest-like tests in frontend)
- Update Dashboard.test.tsx to cover the new behavior:
  - Test that a project with status 'completed' is NOT visible by default.
  - Test that toggling "Show completed projects" causes the completed project to become visible.
  - Verify that completed project card contains the status badge "Completed" when shown.
  - Verify that the Execute button is disabled (or not present) for completed projects when shown.
- Adjust any existing tests that assumed completed projects are visible. Ensure tests still mock api.projects.list as before.
- Run unit tests with the repository's test command (frontend): usually `pnpm --filter frontend test` or `cd frontend && npm test` depending on repo setup. Provide exact commands in task description: `cd frontend && npm ci && npm test` (or `pnpm i && pnpm test`). The repo uses bun/npm; maintainers should run project's normal test workflow; include both `npm ci` and `pnpm install` variants in instructions.

3) Optional: e2e test (Playwright)
- Add a short e2e test in e2e-tests/tests (or the existing e2e suite) that:
  - Starts with a test server or assumes API fixtures where there is a project with status completed and other statuses.
  - Visits the Dashboard page, asserts the completed project is not visible, clicks the "Show completed projects" toggle, and asserts it's visible.
- Provide playwright test code skeleton and how to run: `cd e2e-tests && npm ci && npx playwright test`.

Accessibility & UX details

- Toggle must be keyboard accessible and have aria-label and visible focus styles.
- Completed badge must be semantically accessible (e.g., a <span role="status"> or have aria-hidden false with visually hidden text for screen readers).
- Ensure color contrast for muted styling still meets accessibility minima for any readable text.

Testing and QA

- Unit tests: Dashboard.test.tsx changes + new tests described above.
- Run frontend unit tests and snapshot tests (if any).
- Run e2e test(s) if added.
- Manual QA:
  - Confirm completed projects hidden by default on a populated list.
  - Confirm toggle reveals completed projects.
  - Confirm direct link to a completed project's detail still works.
  - Confirm disabled actions behave correctly (no network calls triggered).

Rollout plan

- This is a safe, UI-only change. Deploy frontend; no backend changes required.
- If a rollback is required, revert the frontend commit.

Estimate

- Frontend implementation: 0.5–1 engineer day.
- Unit tests: 0.25 day.
- Optional e2e: 0.25 day.

Implementation tasks to dispatch

We will dispatch 3 parallel implementation tasks to the repository (one developer can take multiple tasks):
A) Implement Dashboard UI changes and styling (primary change)
B) Update/add frontend unit tests (Dashboard.test.tsx)
C) Add optional e2e Playwright test that verifies toggle behavior and document how to run it

Each task is self-contained and includes file paths, test commands and acceptance criteria.

--- End of plan
