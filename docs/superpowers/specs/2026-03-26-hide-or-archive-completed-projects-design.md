Feature spec (UI-only): Hide completed projects

Summary

This is a minimal, UI-only change to hide projects with status "completed" from the default Projects list to reduce visual clutter. No database, API, or orchestrator changes will be made: the filtering is performed client-side in the frontend. A toggle will allow users to reveal completed projects when desired.

Key decisions

- Scope: Frontend-only. No backend DB columns, API endpoints, or server-side behavior changes.
- Which statuses are hidden: only projects with status === "completed". Projects with status "cancelled", "failed", or "error" remain visible.
- Toggle label: "Show completed projects" (default: off). When enabled, the list shows completed projects as well.
- Direct links / project detail: Completed projects remain accessible via URL; project detail view is unchanged except for a subtle status indicator.

User-facing behavior

- Projects list (default): excludes completed projects.
- Projects list (toggle on): includes completed projects, which are visually muted and display a "Completed" badge.
- Project card actions: For completed projects, actions that would start new work or change status should be disabled or hidden (e.g., resume/retry). Delete remains available if already present.
- Project detail page: If a user navigates directly to a completed project, they can view it normally. A banner or badge indicates the completed status. No unarchive controls exist because there is no archive state.

Frontend implementation details

Files (example locations — adjust to actual paths):
- frontend/src/pages/ProjectsList.tsx (or equivalent)
- frontend/src/components/ProjectCard.tsx (or equivalent)
- frontend/src/pages/ProjectDetail.tsx (or equivalent)
- frontend/src/styles/ — add muted style rule for completed projects

Behavior changes (client-side):
1) Fetch projects as before via GET /api/projects (no query params). This keeps backend unchanged.
2) Filter results in the client to remove projects with project.status === "completed" when the toggle is off.
3) Add a toggle control near the top of the Projects list with label "Show completed projects". Default is unchecked.
4) When enabled, the toggle re-runs the display logic to include completed projects.
5) Completed projects are rendered with:
   - A muted/gray card style (reduced visual weight).
   - A visible "Completed" badge.
   - Disabled/hidden actions that would resume or dispatch agents; Keep read-only actions like "View" and destructive "Delete" if already allowed.
6) Accessibility: ensure toggle is keyboard-focusable and has aria-label; the badge should have an aria-live-friendly label so screen readers announce status.

Edge cases & tradeoffs

- Performance: client-side filtering requires fetching all projects. If project lists grow large, consider server-side filtering in a follow-up.
- Metrics / selectors: because there is no server-side archived flag, other services or clients that call the API (e.g., dropdowns, metrics endpoints) continue to see completed projects unless they also implement client-side filtering.
- Consistency: UI-only approach means there is no persisted "archived" state; projects will appear/disappear solely based on their status value.

Tests / QA

Frontend unit/e2e tests:
- ProjectsList: default view filters out projects with status "completed".
- ProjectsList: toggling "Show completed projects" shows completed projects and retains other projects.
- ProjectCard: completed projects render muted style and "Completed" badge.
- Actions: attempt to click disabled actions on completed project cards — ensure they are not actionable.
- ProjectDetail: direct navigation to a completed project shows the page and status indicator.

Acceptance criteria

- By default the Projects list does not show projects with status === "completed".
- The "Show completed projects" toggle reveals completed projects when enabled.
- Completed projects are visually distinguished and have an accessible badge.
- No backend or DB changes are required for this behavior.

Implementation tasks (frontend-only)

1. Add toggle to Projects list UI and wire state (boolean showCompleted default false).
2. Fetch projects as before; filter client-side: visible = projects.filter(p => !(p.status === "completed") || showCompleted).
3. Update ProjectCard to render muted style and badge for p.status === "completed".
4. Disable or hide actions that would start or resume work on completed projects.
5. Add unit and e2e tests.
6. Update any UI docs or README sections describing the Projects list behaviour.

Estimated effort

- Frontend: 0.5–1 engineer days (small UI change + tests)

Follow-up suggestions (not required now)

- If you later want true archiving (persisted flag, server-side filtering, RBAC, audit), we can follow the full spec that adds DB/API changes.
- Consider server-side support if the projects list becomes large and client-side filtering becomes costly.

-- End of spec (UI-only)
