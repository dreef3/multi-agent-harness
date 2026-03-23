# Review Phase Project Lifecycle — Design

**Date:** 2026-03-23
**Status:** Approved

---

## Problem

When all sub-agent tasks complete, the project moves to `"completed"` and stays there indefinitely. There is no distinction between:

- Tasks done, PR open and awaiting human review
- PR reviewed, merged, work truly finished

This makes the dashboard hard to read — projects pile up in "completed" with no signal of which are actually done. As the harness grows more autonomous (planning agent dispatches tasks, sub-agents push code), it becomes useful for the system itself to reflect the full lifecycle rather than stopping at "tasks done".

---

## Goals

1. Add a `"review"` status: project has completed all tasks, PR is open
2. Add a `"done"` status: user has confirmed the PR is merged and the work is finished
3. Surface these states clearly in the dashboard and on the PRs tab
4. Keep it simple: no auto-detection of merges, manual button is the `"done"` trigger

## Non-Goals

- Automatic `"done"` transition via webhook or polling — user clicks the button
- Tracking per-PR merge status on the project card
- Changes to the fix-run debounce loop (independent, stays as-is)

---

## Architecture

### Status enum

`Project["status"]` in `backend/src/models/types.ts`:

```
brainstorming → spec_in_progress → awaiting_spec_approval
  → plan_in_progress → awaiting_plan_approval
  → executing → review → done
                       ↘ failed
```

`"completed"` is **removed**. A startup DB migration renames any existing `"completed"` rows to `"done"`:

```sql
UPDATE projects SET status = 'done' WHERE status = 'completed'
```

### executing → review transition

`TaskDispatcher.dispatchTasks()` currently sets `"completed"` when all tasks succeed. Changes to `"review"`. No other change to the dispatch logic.

### review → done transition

New endpoint:

```
POST /api/projects/:id/mark-done
```

Guards:
- 404 if project not found
- 400 if project is not in `"review"` (error message includes current status)

On success: sets `status = "done"`, returns `{ success: true, status: "done" }`.

The cancel endpoint is updated to reject `"review"` and `"done"` projects (same as it rejects `"cancelled"` today).

### Dashboard changes (`frontend/src/pages/Dashboard.tsx`)

- `"review"` → amber badge, label `"In Review"`, "Pull Requests" link to `/projects/:id/prs`
- `"done"` → green badge, label `"Done"`, "View PRs" link to `/projects/:id/prs`

No inline PR count on the card — a link to the PRs tab is sufficient (option A from design discussion).

### ProjectLayout — shared tab nav

A new `frontend/src/components/ProjectLayout.tsx` wraps all project detail routes with a tab bar:

```
[ Chat ]  [ Plan ]  [ Execute ]  [ Pull Requests ]
```

`App.tsx` uses a nested React Router layout so all four tabs share the same `/:id` param. This is a UX improvement that makes the PRs tab discoverable from anywhere in the project, not just from the dashboard.

### PrOverview changes (`frontend/src/pages/PrOverview.tsx`)

- When project is in `"review"`: amber banner "Awaiting PR Merge" + "Mark as Done" button
- When project is in `"done"`: green banner "Project Complete"
- Clicking "Mark as Done": calls `api.projects.markDone(projectId)`, reloads project on success

### Frontend API (`frontend/src/lib/api.ts`)

- `Project["status"]` union updated to include `"review"` and `"done"`, remove `"completed"`
- New method: `api.projects.markDone(projectId)` → `POST /api/projects/:id/mark-done`

---

## What stays unchanged

- Fix-run debounce loop — review comments → polling → sub-agent fix-run. Fully independent.
- PR creation by sub-agents — unchanged.
- RecoveryService — queries for `status = 'executing'` projects; unaffected.
- `PlanTask.status` and `AgentSession.status` — both still use `"completed"` as a terminal value.

---

## Testing

- Backend: `projects.test.ts` — `mark-done` returns 404/400/200 correctly; cancel rejects `"review"` and `"done"`
- Backend: `taskDispatcher.test.ts` — `dispatchTasks` sets `"review"` (not `"completed"`) on all-tasks-success
- Frontend: TypeScript check (`tsc --noEmit`) — no errors after status union change
