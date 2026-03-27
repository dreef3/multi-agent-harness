# Dashboard: Completed Projects Expander — Design Spec

Date: 2026-03-27

Owners: Planning Agent (you), Frontend Team

Status: Draft (awaiting LGTM)

## Summary

Replace the header "Show completed projects" checkbox on the Projects dashboard with a single, visually-integrated expander control placed at the end of the active projects list. The expander reveals completed projects appended to the bottom of the list when clicked. This is a frontend-only change and should be implemented inline in Dashboard (no backend changes). Unit tests will be updated; no E2E tests are required.

This change aims to improve visual consistency (match the app's card layout and Tailwind styling), reduce header clutter, and present completed projects in a less prominent but discoverable way.

## Goals & Non-goals

Goals
- Remove the header checkbox and replace it with an expander at the end of the active projects list
- Keep the UI consistent with the rest of the application (tailwind classes used across Dashboard)
- Default state: collapsed (user preference: collapses on navigation / no persistence)
- Accessibility: keyboard operable, aria-expanded and aria-controls used
- Update unit tests to cover the new behavior

Non-goals
- Persisting expand state across reloads
- Changing backend or API
- Adding E2E tests

## Acceptance criteria

1. The Projects dashboard no longer displays the "Show completed projects" checkbox in the header.
2. If there are completed projects, a single expander control appears at the end of the active projects list with text like "Show N completed projects".
3. Clicking the expander reveals the completed projects rendered as the same card components used for active projects (with the existing opacity styling preserved).
4. When expanded, the button reads "Hide completed projects" (or similar) and toggles aria-expanded accordingly.
5. Completed projects do not show Execute buttons or Retry actions (same behavior as before).
6. Unit tests updated to reflect behavior (no E2E changes required).

## Design

High-level change: inline update to Dashboard with a small, focused UI element at the end of the projects grid. We will not introduce a separate reusable component file for this task (per chosen approach). Keep the logic localized to Dashboard.tsx for minimal churn.

User flow
- Page load: completed projects are hidden by default.
- If projects contain completed items, the active list is rendered followed by a full-width expander button/pill.
- Clicking the pill expands a collapsible region that reveals completed project cards appended to the list. Clicking again collapses it.

Visual & styling guidelines
- Use the existing card styles used for project entries: bg-gray-900, border-gray-800, rounded-lg, p-4. Completed items keep the opacity-70 style.
- Expander control appearance:
  - Full-width element within the grid column.
  - Looks like a clean pill/card matching the theme: bg-gray-800 (slightly lighter than cards), border border-gray-700, rounded-lg, px-4 py-3, flex items-center justify-between.
  - Left: label text — "Show X completed projects" (or "Hide completed projects"). Text uses text-gray-300 / text-gray-200 when hovered.
  - Right: small chevron icon (SVG) that rotates 180deg when expanded. Chevron color: text-gray-400.
  - On hover: border/outline or text color changes consistent with other action elements in Dashboard.
  - Use subtle transition (transition-transform for chevron, transition-all for max-height) ~200ms.

Accessibility
- Expander is a <button> with aria-expanded and aria-controls pointing to the collapsible region id.
- Collapsible region has role="region" and an id matching aria-controls.
- Ensure keyboard interaction (Enter/Space) toggles expansion.
- Provide a visually-discernible focus style (reuse project's focus-visible utilities).

Implementation details
- Files to modify
  - frontend/src/pages/Dashboard.tsx — primary modifications
    - Remove header checkbox markup and the showCompleted state variable.
    - Compute two arrays: activeProjects = projects.filter(p => p.status !== 'completed') and completedProjects = projects.filter(p => p.status === 'completed').
    - Render active projects as currently implemented.
    - After the active list, when completedProjects.length > 0, render the expander button and collapsible region markup.
    - Collapsible region markup should reuse the same article card markup used for projects to preserve visuals and actions. Keep the same conditional logic for Execute/Retry/Delete, but completed projects naturally won't display Execute or Retry as before.
    - Local state: const [expanded, setExpanded] = useState(false); default false.
    - Use max-height CSS + overflow-hidden + transition for simple animation. Keep tests robust by avoiding animation timing dependence.

- No new API calls required. No backend changes.

Example (informal) structure inside Dashboard.tsx
- const activeProjects = projects.filter(...)
- const completedProjects = projects.filter(...)
- render activeProjects
- if (completedProjects.length > 0) render (
    <div>
      <button aria-expanded={expanded} aria-controls="completed-projects-region" onClick=>
         <span>{expanded ? 'Hide' : `Show ${completedProjects.length} completed projects`}</span>
         <ChevronIcon className={expanded ? 'rotate-180' : ''} />
      </button>
      <div id="completed-projects-region" role="region" className={expanded ? 'max-h-[1000px]' : 'max-h-0 overflow-hidden transition-all'}>
         {completedProjects.map(...render project card...)}
      </div>
    </div>
  )

Testing
- Update unit tests in frontend/src/pages/Dashboard.test.tsx
  - Remove references to the header checkbox label and toggling it. Replace with tests that find the expander button and click it.
  - Keep existing tests for Retry button presence/absence, lastError render, etc. Ensure they pass with the new layout.
  - New/updated test cases:
    - "does not show completed projects by default" — ensure completed project names not visible initially.
    - "shows completed project when expander is clicked" — click the expander and assert the completed project is visible and displays the Completed badge.
    - "does not render Execute button for completed projects when visible" — after expanding, assert Execute is not present and Retry is not present for completed projects.
    - "expander has appropriate aria attributes" — assert aria-expanded toggles from false to true and aria-controls references the region id.
  - Keep the Retry-related tests unchanged for non-completed projects.

Backward compatibility & migration
- No persistence of expanded state — behavior resets on reload.
- Tests will be updated; any external automation that looked for the header checkbox must be updated accordingly.

Risks & mitigation
- Risk: animation leads to flaky tests. Mitigation: tests await DOM content; do not assert on animation timing.
- Risk: visual mismatch with existing theme. Mitigation: reuse existing Tailwind utility classes and spacing.

Developer notes
- The implementation should be kept small and localized to Dashboard.tsx to match the chosen approach.
- If later reuse is desired, the expander can be refactored into a small component.

Spec review
- After this spec is approved by the stakeholder (LGTM), the next step will be writing the implementation plan and dispatching tasks.

---

Please review this spec. If it looks good, reply "LGTM" and I will write the implementation plan.