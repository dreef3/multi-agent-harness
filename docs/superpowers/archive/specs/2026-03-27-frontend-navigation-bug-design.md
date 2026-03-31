# Add "Back to projects" navigation and fix New Project history behavior

Date: 2026-03-27

Summary

When a user creates a new project and is redirected to the project's Chat tab, there are two UX problems:

1. The Chat page header lacks any navigation control to return to the projects list (it only displays the title "Chat").
2. If the user uses the browser Back button after arriving at Chat from the New Project flow, the browser returns to the New Project form ("/projects/new") instead of the projects list ("/"). This is surprising and can re-open the New Project dialog.

This spec proposes a small, low-risk UI and navigation change to make the Chat header provide a clear, predictable way back to the projects list and to ensure browser Back behavior returns the user to the projects list after creating a project.

Motivation

- Users expect a clear way to get back to the list of projects from a project's workspace.
- Returning to the New Project form when hitting Back from Chat is confusing and can cause duplicate project creation attempts or lost context.

Goals

- Add an explicit "Back to projects" control in the Chat header that always navigates to "/" (projects list).
- When a user creates a new project and is redirected to Chat, ensure the browser Back button returns to the projects list rather than the New Project form.
- Do this without broad changes to routing or global history behavior.

Non-goals

- Reworking global navigation or introducing complex history heuristics.
- Removing the ability to navigate to the New Project form intentionally from other flows.

Proposed solution (recommended)

Implement two coordinated changes in the frontend (React Router-based app):

1) Chat header: add a visible navigation control labeled "Back to projects" (text link or left-chevron + "Projects") that always navigates to the projects list route "/".
   - This should use Link (or navigate("/")) so it is deterministic and does not depend on browser history.
   - Place the control in the existing header area alongside the "Chat" title.

2) New Project redirection: when the NewProject page successfully creates a project, navigate to the Chat route using replace: true so the /projects/new entry is removed from the browser history stack. Concretely, change the redirect to:

   navigate(`/projects/${project.id}/chat`, { state: { project }, replace: true });

   - This ensures that pressing Back in the browser after being redirected to Chat will not return to /projects/new and will instead go to the prior entry (typically "/").
   - Keep the project passed in location.state to preserve the existing auto-start behavior (auto-send of freeform description) on Chat.

Optional additional improvement (recommended but lower priority):

- Change the NewProject "Cancel" button to navigate to the projects list explicitly rather than navigate(-1). Replace the call with navigate("/") so Cancel is deterministic and avoids returning to arbitrary history entries.

Alternative approaches (brief)

A. Keep history as-is but implement a history-detection check on Chat load that inspects location.state or a custom marker and, if the immediately-previous route was /projects/new, programmatically navigate to "/". Trade-offs: brittle (browsers/React Router don't expose the previous path reliably) and more complex.

B. Push an intermediate history entry for "/" before redirecting to Chat so Back goes to "/". Trade-offs: hacky and may create unnatural history entries for users.

Why recommended approach wins

- Minimal changes, low risk, easy to reason about.
- Uses standard React Router replace behavior which is well-supported and semantically matches the desired UX (replace the temporary New Project form entry with the Chat page).
- Adding an explicit "Back to projects" control covers users who prefer an on-screen navigation affordance.

Files / components to change

- frontend/src/pages/Chat.tsx
  - Update header to include a "Back to projects" Link/button that navigates to "/".
  - Keep existing title and layout; ensure responsive alignment.

- frontend/src/pages/NewProject.tsx
  - Update the post-create navigation call to use replace: true when navigating to Chat.
    - Before: navigate(`/projects/${project.id}/chat`, { state: { project } })
    - After: navigate(`/projects/${project.id}/chat`, { state: { project }, replace: true })
  - (Optional) Update the Cancel button from navigate(-1) to navigate("/") for deterministic behavior.

Behavior and UX details

- Chat header control
  - Visible label: "← Projects" or "Back to projects" (implementor should match current UI language/spacing). Use an inline chevron icon followed by the word "Projects".
  - Clicking this control navigates to the projects list route "/".
  - Should be keyboard accessible and have appropriate aria-label (e.g., "Back to projects list").

- Browser Back behavior after project creation
  - After creating a project through the New Project flow, the history entry for /projects/new will be replaced by /projects/{id}/chat. Pressing the browser Back button should go to the previous page before /projects/new (usually the dashboard/projects list). The exact prior entry is preserved; we only remove the transient new-project entry.

Acceptance criteria

1. The Chat page header displays a visible navigation control that navigates to "/" when clicked.
2. When a user creates a project using the New Project form and arrives at Chat, pressing the browser Back button does not return to the New Project form; instead it returns to the projects list (or the previous relevant entry).
3. The Chat auto-start behavior (auto-sending freeform description when present in location.state.project) continues to work.
4. The New Project "Cancel" button continues to cancel creation — if the optional change to navigate("/") is included, Cancel deterministically returns to the projects list.

Testing

Unit / Integration

- Update or add a React test for Chat.tsx header to assert a Link/button to "/" exists and is visible.
- Add/modify a test that simulates creating a project and ensures navigate is called with replace: true (mock useNavigate), and that location.state is passed through.

E2E

- Create an E2E test that:
  1. Visits the projects list.
  2. Opens New Project, fills required fields, creates a project.
  3. Asserts the app is now on /projects/{id}/chat.
  4. Uses browser.back()
  5. Asserts the app shows the projects list (not the New Project form).

Accessibility

- Ensure the new header control has an aria-label and focus styles consistent with other header controls.

Rollout / migration

- This is a frontend-only, backward-compatible change. No data migrations required.

Risks

- Very low. Changing navigation.replace semantics is well-understood. The main risk is forgetting to pass location.state when using replace; the spec explicitly requires preserving location.state.project.

Implementation notes for engineers

- Use react-router-dom Link or useNavigate("/") for the header control. When using Link, set to="/"; when using programmatic navigation ensure you call navigate("/", { replace: false }) — no replace needed here.
- For the NewProject redirect, add replace: true to the navigate call.
- Keep changes focused and small; no other routing logic needs modification.

Spec written by: Planning agent

---

Please review this design. If it looks good I will open the spec as a PR (already done) and then dispatch a spec review task to the reviewer sub-agent. After the spec review loop passes and you approve the spec file, I'll prepare the implementation plan.