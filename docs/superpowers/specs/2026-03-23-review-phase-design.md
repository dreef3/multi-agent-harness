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

## Files Changed

| File | Change |
|---|---|
| `backend/src/models/types.ts` | Remove `"completed"`, add `"review"` and `"done"` to `Project.status` union |
| `backend/src/store/db.ts` | Add migration: `UPDATE projects SET status = 'done' WHERE status = 'completed'` |
| `backend/src/orchestrator/taskDispatcher.ts` | Set `"review"` instead of `"completed"` in `dispatchTasks()` |
| `backend/src/orchestrator/recoveryService.ts` | Set `"review"` instead of `"completed"` in `checkAllTerminal()` |
| `backend/src/api/projects.ts` | Add `POST /:id/mark-done`; update cancel guard |
| `backend/src/api/websocket.ts` | Add `"project_status_changed"` to the `type` literal union in `WsServerMessage`; export `broadcastProjectStatusChanged()` |
| `frontend/src/lib/api.ts` | Update `Project.status` union; add `api.projects.markDone()` |
| `frontend/src/pages/Dashboard.tsx` | Amber/green badges; "Pull Requests" link for review projects |
| `frontend/src/components/ProjectLayout.tsx` | New file — shared tab nav |
| `frontend/src/App.tsx` | Restructure project routes to nested layout |
| `frontend/src/pages/PrOverview.tsx` | Review banner + Mark as Done button |

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

`"failed"` is only reachable from `"executing"` (all retries exhausted). A project in `"review"` has already succeeded — it cannot transition to `"failed"`.

`"completed"` is **removed**. A startup DB migration renames any existing `"completed"` rows to `"done"`:

```sql
UPDATE projects SET status = 'done' WHERE status = 'completed'
```

### executing → review transition

There are **two write sites** that currently set `"completed"` on project success — both must be updated to `"review"`:

1. **`TaskDispatcher.dispatchTasks()`** (`backend/src/orchestrator/taskDispatcher.ts`) — the original dispatch path, sets `"completed"` at the post-`Promise.all` status update.
2. **`RecoveryService.checkAllTerminal()`** (`backend/src/orchestrator/recoveryService.ts`) — the production path introduced by the self-healing system; called after each task completes via `dispatchWithRetry`. This is the live path for all tasks dispatched through the recovery service.

Both must be updated. Missing either one means projects that go through the retry path will never reach `"review"`.

### review → done transition

New endpoint:

```
POST /api/projects/:id/mark-done
```

Guards:
- 404 if project not found
- 400 if project is not in `"review"` (error message includes current status)

On success: sets `status = "done"`, broadcasts `project_status_changed` via WebSocket to the project's connected clients, returns `{ success: true, status: "done" }`.

The broadcast message shape — `"project_status_changed"` is added to the `type` literal in `WsServerMessage`, and the message carries `projectId` and `status`:
```ts
{ type: "project_status_changed"; projectId: string; status: string }
```
`WsServerMessage` already has `[key: string]: unknown` so extra fields are allowed — only the `type` literal union needs extending. `projects.ts` must import `broadcastProjectStatusChanged` from `websocket.ts`.

Note: `broadcastToProject` is project-scoped (only reaches clients connected to that project's WS channel). The Dashboard does not connect to a per-project channel, so it does not receive this broadcast. The Dashboard will reflect updated status on next navigation/load. No global WS channel is needed.

The cancel endpoint currently rejects `project.status === "completed" || project.status === "cancelled"`. Since `"completed"` is being removed, this guard must be updated to: reject `"review"`, `"done"`, and `"cancelled"`.

### Dashboard changes (`frontend/src/pages/Dashboard.tsx`)

- `"review"` → amber badge, label `"In Review"`, "Pull Requests" link to `/projects/:id/prs`
- `"done"` → green badge, label `"Done"`, "View PRs" link to `/projects/:id/prs`

No inline PR count on the card — a link to the PRs tab is sufficient (option A from design discussion).

Dashboard does not subscribe to WebSocket events — badge state reflects whatever the REST API returns on page load. Updated state appears on next navigation to the Dashboard.

### ProjectLayout — shared tab nav

A new `frontend/src/components/ProjectLayout.tsx` wraps all project detail routes with a tab bar:

```
[ Chat ]  [ Plan ]  [ Execute ]  [ Pull Requests ]
```

`App.tsx` restructures the four flat project routes into a nested React Router layout:

```tsx
<Route path="/projects/:id" element={<ProjectLayout />}>
  <Route path="chat"    element={<Chat />} />
  <Route path="plan"    element={<PlanApproval />} />
  <Route path="execute" element={<Execution />} />
  <Route path="prs"     element={<PrOverview />} />
</Route>
```

The existing four flat routes (`/projects/:id/chat` etc.) are replaced by this nested structure. Child components continue to use `useParams<{ id: string }>()` unchanged — the `/:id` param is inherited from the parent route.

The `/projects/new` route remains as a sibling **before** the `/:id` parent route. React Router v6 matches static segments (`new`) with higher priority than dynamic params (`/:id`), so the ordering is safe and no collision occurs.

### PrOverview changes (`frontend/src/pages/PrOverview.tsx`)

- When project is in `"review"`: amber banner "Awaiting PR Merge" + "Mark as Done" button
- When project is in `"done"`: green banner "Project Complete"
- Clicking "Mark as Done": calls `api.projects.markDone(projectId)`, reloads project on success

### Frontend API (`frontend/src/lib/api.ts`)

- `Project["status"]` union updated: remove `"completed"`, `"draft"`, and `"error"` (pre-existing strays not in the backend type); add `"review"` and `"done"`
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
