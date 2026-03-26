Feature spec: Hide / Archive completed projects

Summary

Add a soft-archive capability so completed (terminal) projects can be hidden from the default project list while still keeping all project data for retrieval and auditing. Provide UI controls to show archived projects and to archive/unarchive a project. Enforce archiving only for terminal projects; provide an API surface and DB migration. This is a non-destructive change (soft archive) and should not delete messages, agent sessions or PRs.

Goals

- Let users hide completed projects from the default projects view to reduce visual clutter.
- Preserve all project data so archived projects can be unarchived and inspected later.
- Prevent accidental archiving of active projects.
- Provide a simple API for archiving/unarchiving and a straightforward UI control in the Projects list and Project detail view.

Non-Goals / Out of scope

- Permanently deleting old projects (hard-delete) or implementing retention/auto-delete policy.
- Automatically archiving projects on a schedule (could be a follow-up enhancement).

Proposal

1) Data model

- Add column archived INTEGER NOT NULL DEFAULT 0 to projects table. Map to Project.archived: boolean in the backend model.
- Rationale: boolean is simple and explicit. Avoid re-using the status field which is used across many orchestrator flows.

DB migration steps (backend/src/store/db.ts):
- addColumnIfMissing("projects", "archived", "INTEGER DEFAULT 0");
- Ensure fromRow() maps archived (0/1) to Project.archived boolean with default false.

2) Backend API

New endpoints (backend/src/api/projects.ts):
- POST /api/projects/:id/archive
  - Behavior: Sets archived=true for the project if project.status is terminal (completed, cancelled, failed, error). If project is non-terminal (executing, brainstorming, awaiting_plan_approval etc.), return 400 with error "Cannot archive non-terminal project".
  - Returns: { success: true, archived: true }
- POST /api/projects/:id/unarchive
  - Behavior: Sets archived=false regardless of status. Returns { success: true, archived: false }.

List projects behavior change:
- GET /api/projects (existing) should accept an optional query param includeArchived=true. By default the API will exclude archived projects from the returned list.
- Also support GET /api/projects?includeArchived=true to return all projects (legacy behaviour preserved when explicitly requested).

Patch project update behavior:
- PATCH /api/projects/:id should accept an "archived" boolean to allow archiving/unarchiving through the patch endpoint as well (subject to the same validation: only allow archived=true for terminal projects).

Server-side considerations:
- updateProject() in store.projects.ts should continue to work; ensure callers that call updateProject({ status: ... }) are unaffected.
- deleteProject remains destructive; archiving only toggles archived.

3) Orchestrator / Recovery interactions

- The recovery service uses listExecutingProjects() (status == 'executing') and other status-based queries. Because archiving only applies to terminal projects this should not affect recovery or agent management flows.
- Ensure no code path enumerates projects by reading listProjects() and expecting archived projects to be present; default behavior change is only at the API level. Internal code that uses listProjects() directly in the backend should check project.archived when appropriate (we'll audit code locations that call listProjects()).

Audit points:
- Search for any logic that enumerates projects to start agents, dispatch tasks, or make decisions; ensure archived projects are ignored by UI-level listing only (we will not change behavior of status-driven internal flows). If any internal flows rely on listProjects() returning archived ones, we will either update the internal caller to explicitly include archived where needed or call listProjects() and filter locally.

4) Frontend UX

Changes required in frontend to hide archived by default and provide controls:
- Projects list page (frontend):
  - By default show only non-archived projects (call GET /api/projects without includeArchived).
  - Add a toggle/switch labelled "Show archived projects" near the top of the list. When enabled, call GET /api/projects?includeArchived=true and render archived projects.
  - Archived project card styling: display a muted/gray appearance and an "Archived" badge. Actions available: "Unarchive" and "Delete" (delete existing destructive endpoint). Disable actions that cannot be used (e.g., "Retry", "Retry" should not be shown for archived projects unless unarchived).
  - Support bulk actions (optional): select multiple archived projects and unarchive or delete — mark as follow-up.
- Project details page:
  - Show an "Archived" banner for archived projects and an "Unarchive" button in the header.
  - If project is archived, disable actions that would start agents or dispatch tasks and show guidance text like "This project is archived. Unarchive to resume or inspect the plan."

Accessibility / design notes:
- Ensure the toggle is keyboard accessible and has an ARIA label. Archived badge should be perceivable to screen readers.

5) Authorization / Security

- No new permission model required for this release: archiving will be available to any user that can update projects (same role that can call PATCH). Ensure server-side validation of status and input to prevent invalid state transitions.

6) Tests and QA

- Backend unit tests covering:
  - DB migration added column default false.
  - POST /api/projects/:id/archive: success when project is terminal; 400 when not terminal.
  - POST /api/projects/:id/unarchive: unarchives a project.
  - GET /api/projects default excludes archived; includeArchived=true returns archived.
  - PATCH /api/projects/:id with archived field validates terminal status.
- Frontend tests / e2e:
  - Projects list hides archived by default and toggles with Show archived switch.
  - Archive/unarchive flows show expected UI changes and call the correct endpoints.

7) Backwards compatibility / migration

- Migration adds the column with default 0 so existing projects remain unarchived.
- No breaking API changes. Endpoints added and query param is optional.

8) Acceptance criteria

- Users can archive a completed project via API or UI; archived projects no longer appear in the projects list by default.
- Users can toggle "Show archived projects" to reveal archived projects.
- Archived projects can be unarchived and will reappear in the default list.
- Attempting to archive a non-terminal project returns a 400 error and does not change the project.

Implementation plan (high-level tasks)

Backend (priority):
- Add DB migration column and update fromRow() to map archived -> Project.archived.
- Add POST /api/projects/:id/archive and POST /api/projects/:id/unarchive routes and validations.
- Modify GET /api/projects to accept includeArchived query param and implement default filtering.
- Allow PATCH /api/projects to set archived with same validations.
- Add unit tests for new behavior.

Frontend (priority):
- Projects list: add Show archived toggle, different styling for archived projects, Unarchive action and integration with API.
- Project detail: banner and Unarchive action, disable resume/agent actions while archived.
- Add e2e tests.

Docs

- Update README or docs area describing archiving behavior and APIs.

Rollout / Rollback

- Feature flagged by default behaviour: since we change GET /api/projects default to hide archived, with default archived=false for all existing projects this is a no-op until someone archives a project.
- Rollback: remove API endpoints and DB column (not required if non-destructive). No immediate risk.

Open questions / decisions for maintainers

1) Should we allow archiving of projects with status "failed" or only "completed" and "cancelled"? Proposal: allow any terminal status (completed, cancelled, failed, error) to be archived.
2) Do we want auto-archiving on a configurable schedule? Propose follow-up.
3) Bulk archive/unarchive UI? Follow-up.

Files likely touched

- backend/src/store/db.ts — migration addColumnIfMissing("archived")
- backend/src/store/projects.ts — fromRow() mapping; updateProject/deleteProject unaffected
- backend/src/api/projects.ts — add archive/unarchive endpoints; add includeArchived handling; patch validation
- frontend/src/pages/ProjectsList.tsx (or similar) — UI changes
- frontend/src/pages/ProjectDetail.tsx — banner + actions
- docs — user-facing docs

Estimated effort

- Backend: 1–2 engineer days (migration + API changes + tests)
- Frontend: 1–2 engineer days (UI + e2e tests)


-- End of spec
