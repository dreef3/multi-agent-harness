# Review Phase Project Lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the project lifecycle with two new statuses — `"review"` (PR open, awaiting human merge) and `"done"` (all PRs merged) — and plumb the full automation path: `dispatchTasks` sets `"review"`, the GitHub `pull_request.closed` webhook sets `"done"`, a manual `/mark-done` escape hatch covers webhook-less setups, and the debounce callback gap in `webhooks.ts` is plugged so fix-runs actually fire from webhooks as well as from polling.

**Architecture key facts (verified from source):**
- `Project["status"]` union is in `backend/src/models/types.ts`
- Migration function is in `backend/src/store/db.ts` — idempotent `UPDATE` statements go there
- `TaskDispatcher.dispatchTasks()` currently sets `"completed"` on success — changes to `"review"`
- `backend/src/api/webhooks.ts` handles `pull_request` closed events but does NOT update `PullRequest.status` or call `runFixRun` from the debounce callback — both gaps fixed here
- `pull_requests` table with `PullRequest` model already exists (`status: "open" | "merged" | "declined"`)
- `PrOverview` page already exists at `/projects/:id/prs`

**Tech Stack:** TypeScript, Node.js, better-sqlite3 (sync SQLite), Express, Vitest, React + Tailwind

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `backend/src/models/types.ts` | **Modify** | Add `"review"` and `"done"` to `Project["status"]` union; remove `"completed"` |
| `backend/src/store/db.ts` | **Modify** | Migration: rename `"completed"` → `"done"` rows |
| `backend/src/store/pullRequests.ts` | **Modify** | Add `listOpenPullRequestsByProject` helper |
| `backend/src/orchestrator/taskDispatcher.ts` | **Modify** | Set `"review"` instead of `"completed"` when all tasks succeed |
| `backend/src/api/websocket.ts` | **Modify** | Export `broadcastProjectStatusChanged()` |
| `backend/src/api/webhooks.ts` | **Modify** | Handle PR closed → update PR status + set project `"done"`; extract `triggerFixRunForPr()` shared helper; wire debounce callback |
| `backend/src/polling.ts` | **Modify** | Use shared `triggerFixRunForPr()` helper instead of inline body |
| `backend/src/api/projects.ts` | **Modify** | Add `POST /:id/mark-done`; update cancel guard |
| `frontend/src/lib/api.ts` | **Modify** | Add `"review"`/`"done"` to status union; add `markDone` method |
| `frontend/src/pages/Dashboard.tsx` | **Modify** | Status colors/labels for new statuses + "Pull Requests" link |
| `frontend/src/App.tsx` | **Modify** | Wrap project routes in `ProjectLayout` |
| `frontend/src/components/ProjectLayout.tsx` | **Create** | Shared tab nav (Chat / Plan / Execute / Pull Requests) |
| `frontend/src/pages/PrOverview.tsx` | **Modify** | Review-phase banner + "Mark as Done" button |

---

### Task 1: Backend types + DB migration

**Files:**
- Modify: `backend/src/models/types.ts`
- Modify: `backend/src/store/db.ts`

- [ ] **Step 1: Extend `Project["status"]` union**

In `backend/src/models/types.ts`, replace the `status` field union — remove `"completed"`, add `"review"` and `"done"`:

```typescript
  status:
    | "brainstorming"
    | "spec_in_progress"
    | "awaiting_spec_approval"
    | "plan_in_progress"
    | "awaiting_plan_approval"
    | "executing"
    | "review"
    | "done"
    | "failed"
    | "cancelled";
```

- [ ] **Step 2: Add DB migration in `backend/src/store/db.ts`**

At the end of the `migrate()` function, add:

```typescript
  // Rename "completed" → "done" for review-phase lifecycle
  database.exec(`UPDATE projects SET status = 'done' WHERE status = 'completed'`);
```

- [ ] **Step 3: Verify TypeScript compiles cleanly**

```bash
cd backend && npx tsc --noEmit 2>&1
```

Fix any type errors caused by the removal of `"completed"` from the union (look for exhaustive checks or `=== "completed"` comparisons in non-test files).

- [ ] **Step 4: Run tests**

```bash
cd backend && npx vitest run 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/models/types.ts backend/src/store/db.ts
git commit -m "feat: add review and done to Project status union; rename completed→done in DB migration"
```

---

### Task 2: Store helper + TaskDispatcher transition

**Files:**
- Modify: `backend/src/store/pullRequests.ts`
- Modify: `backend/src/orchestrator/taskDispatcher.ts`

- [ ] **Step 1: Add `listOpenPullRequestsByProject` helper**

In `backend/src/store/pullRequests.ts`, add after existing list helpers:

```typescript
export function listOpenPullRequestsByProject(projectId: string): PullRequest[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM pull_requests WHERE project_id = ? AND status = 'open' ORDER BY created_at DESC"
    )
    .all(projectId) as PullRequestRow[];
  return rows.map(prFromRow);
}
```

- [ ] **Step 2: Change `dispatchTasks()` to set `"review"` instead of `"completed"`**

In `backend/src/orchestrator/taskDispatcher.ts`, the `allCompleted` branch:

```typescript
// before
    if (allCompleted) {
      updateProject(projectId, { status: "completed" });

// after
    if (allCompleted) {
      updateProject(projectId, { status: "review" });
```

- [ ] **Step 3: Search for remaining `"completed"` references in test files**

```bash
grep -rn '"completed"' backend/src/__tests__/
```

For any assertion on `Project.status === "completed"`, change it to `"review"`. Do NOT change assertions on `PlanTask.status` or `AgentSession.status` — those still use `"completed"`.

- [ ] **Step 4: Run tests**

```bash
cd backend && npx vitest run 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/store/pullRequests.ts backend/src/orchestrator/taskDispatcher.ts
git commit -m "feat: set project status to review after tasks complete; add listOpenPullRequestsByProject"
```

---

### Task 3: WebSocket `broadcastProjectStatusChanged` export

**Files:**
- Modify: `backend/src/api/websocket.ts`

- [ ] **Step 1: Add `"project_status_changed"` to the `WsServerMessage` type union**

Add `"project_status_changed"` to the `type` discriminant in the `WsServerMessage` interface.

- [ ] **Step 2: Export `broadcastProjectStatusChanged`**

Following the same pattern as `broadcastStuckAgent`:

```typescript
export function broadcastProjectStatusChanged(
  projectId: string,
  status: string
): void {
  broadcastToProject(projectId, { type: "project_status_changed", status });
}
```

- [ ] **Step 3: TypeScript check**

```bash
cd backend && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/api/websocket.ts
git commit -m "feat: export broadcastProjectStatusChanged from websocket"
```

---

### Task 4: Webhook handler — PR closed + debounce callback gap

**Files:**
- Modify: `backend/src/api/webhooks.ts`
- Modify: `backend/src/polling.ts`

This is the largest task. It fixes two independent bugs plus adds the `"done"` transition.

- [ ] **Step 1: Add `merged` field to `GitHubWebhookPayload.pull_request`**

```typescript
interface GitHubWebhookPayload {
  // ...
  pull_request?: {
    number: number;
    html_url: string;
    state?: string;
    merged?: boolean;   // new
  };
}
```

- [ ] **Step 2: Extract `triggerFixRunForPr()` as an exported helper in `webhooks.ts`**

Add before `createWebhooksRouter`. This function retrieves pending comments, marks them `"fixing"`, runs a fix-run via `TaskDispatcher`, and marks them `"fixed"` or restores to `"pending"` on failure. Export it so `polling.ts` can import and reuse it.

Check `backend/src/polling.ts` for the existing inline logic (lines 71–113) to replicate accurately. The function signature is:

```typescript
export async function triggerFixRunForPr(docker: Dockerode, prId: string): Promise<void>
```

- [ ] **Step 3: Wire the debounce callback in `insertCommentAndNotify`**

Replace the logging-only callback body with a call to `triggerFixRunForPr`. Store the docker instance at module scope via a setter `export function setDockerInstance(d: Dockerode): void`.

- [ ] **Step 4: Handle `pull_request.closed` to update PR status and check for `"done"` transition**

In the event handler, after the existing closed-event handling (currently just cancels debounce timer):

1. Look up the PR by `payload.pull_request.number` via a new `getPullRequestByExternalId` store call (or existing equivalent — check `pullRequests.ts` for the right function name)
2. Update PR status to `"merged"` or `"declined"` based on `payload.pull_request.merged`
3. List all PRs for the project; if none are `"open"` and project is in `"review"`, set project to `"done"` and call `broadcastProjectStatusChanged`

- [ ] **Step 5: Thread docker into the webhook router**

Change `createWebhooksRouter()` signature to `createWebhooksRouter(docker: Dockerode): Router`. Call `setDockerInstance(docker)` at the top. Update the call site in `backend/src/index.ts`.

- [ ] **Step 6: Update `backend/src/polling.ts`**

Replace the inline debounce body in `pollPullRequest` with:

```javascript
import { triggerFixRunForPr } from "../api/webhooks.js";
// ...
debounceEngine.notify(pr.id, async (prId) => {
  await triggerFixRunForPr(docker, prId);
});
```

- [ ] **Step 7: Create `backend/src/__tests__/webhooks.test.ts`**

Cover:
- `pull_request.closed` with `merged: true` → PR status becomes `"merged"`
- `pull_request.closed` with `merged: false` → PR status becomes `"declined"`
- All PRs non-open + project in `"review"` → project becomes `"done"`, broadcast fired
- Any PR still open → project stays in `"review"`
- Project not in `"review"` → no status change
- `triggerFixRunForPr`: runs fix, marks comments fixed on success
- `triggerFixRunForPr`: restores comments to pending on failure
- `triggerFixRunForPr`: no-op when no pending comments

- [ ] **Step 8: Run tests**

```bash
cd backend && npx vitest run 2>&1 | tail -10
```

- [ ] **Step 9: Commit**

```bash
git add backend/src/api/webhooks.ts backend/src/polling.ts backend/src/__tests__/webhooks.test.ts
git commit -m "feat: webhook sets PR and project done status on PR merge; fix debounce callback gap"
```

---

### Task 5: `POST /api/projects/:id/mark-done` endpoint

**Files:**
- Modify: `backend/src/api/projects.ts`

- [ ] **Step 1: Add the route**

After the cancel route, add:

```typescript
  router.post("/:id/mark-done", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    if (project.status !== "review") {
      res.status(400).json({
        error: `Cannot mark done: project must be in "review" status, currently "${project.status}"`,
      });
      return;
    }
    updateProject(req.params.id, { status: "done" });
    import("./websocket.js").then(({ broadcastProjectStatusChanged }) => {
      broadcastProjectStatusChanged(req.params.id, "done");
    }).catch(() => {});
    res.json({ success: true, status: "done" });
  });
```

- [ ] **Step 2: Update cancel route guard**

Change the cancel guard from `=== "completed"` to cover the new terminal statuses:

```typescript
    if (["review", "done", "cancelled"].includes(project.status)) {
      res.status(400).json({ error: `Cannot cancel project with status: ${project.status}` });
```

- [ ] **Step 3: Add tests in `backend/src/__tests__/projects.test.ts`**

- `POST /:id/mark-done` returns 404 for unknown project
- `POST /:id/mark-done` returns 400 when project is not in `"review"`
- `POST /:id/mark-done` returns 200 and updates status to `"done"` when in `"review"`
- `POST /:id/cancel` returns 400 for `"review"` and `"done"` projects

- [ ] **Step 4: Run tests**

```bash
cd backend && npx vitest run src/__tests__/projects.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/projects.ts backend/src/__tests__/projects.test.ts
git commit -m "feat: add POST /api/projects/:id/mark-done; update cancel guard for new statuses"
```

---

### Task 6: Frontend types + API method

**Files:**
- Modify: `frontend/src/lib/api.ts`

- [ ] **Step 1: Update `Project["status"]` union**

Remove `"completed"`, add `"review"` and `"done"`.

- [ ] **Step 2: Add `markDone` to `api.projects`**

```typescript
    markDone: (projectId: string) =>
      fetchJson<{ success: boolean; status: string }>(
        `${API_BASE}/projects/${projectId}/mark-done`,
        { method: "POST" }
      ),
```

- [ ] **Step 3: TypeScript check**

```bash
cd frontend && npx tsc --noEmit
```

Fix any type errors from removing `"completed"` (e.g., `statusColors` in Dashboard).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/api.ts
git commit -m "feat: add review and done to frontend Project status type; add api.projects.markDone"
```

---

### Task 7: Dashboard — status colors + Pull Requests link

**Files:**
- Modify: `frontend/src/pages/Dashboard.tsx`

- [ ] **Step 1: Add to `statusColors` map**

```typescript
    review: "bg-amber-600",
    done: "bg-green-600",
```

- [ ] **Step 2: Add to `statusLabels` map**

```typescript
    review: "Awaiting Review",
    done: "Done",
```

- [ ] **Step 3: Add "Pull Requests" action link for `"review"` and `"done"` projects**

In the project card actions section, after the `"executing"` block:

```tsx
{project.status === "review" && (
  <Link to={`/projects/${project.id}/prs`} className="text-amber-400 hover:text-amber-300 px-3 py-1 text-sm">
    Pull Requests
  </Link>
)}
{project.status === "done" && (
  <Link to={`/projects/${project.id}/prs`} className="text-green-400 hover:text-green-300 px-3 py-1 text-sm">
    View PRs
  </Link>
)}
```

- [ ] **Step 4: TypeScript check**

```bash
cd frontend && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Dashboard.tsx
git commit -m "feat: dashboard shows amber/green for review/done statuses with Pull Requests link"
```

---

### Task 8: `ProjectLayout` shared tab nav

**Files:**
- Create: `frontend/src/components/ProjectLayout.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Create `frontend/src/components/ProjectLayout.tsx`**

```tsx
import { NavLink, Outlet, useParams } from "react-router-dom";

export default function ProjectLayout() {
  const { id } = useParams<{ id: string }>();

  const tabs = [
    { label: "Chat",          to: `/projects/${id}/chat` },
    { label: "Plan",          to: `/projects/${id}/plan` },
    { label: "Execute",       to: `/projects/${id}/execute` },
    { label: "Pull Requests", to: `/projects/${id}/prs` },
  ];

  return (
    <div className="space-y-4">
      <nav className="flex gap-1 border-b border-gray-800 pb-0">
        {tabs.map(tab => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                isActive
                  ? "border-blue-500 text-white"
                  : "border-transparent text-gray-400 hover:text-gray-200"
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
```

- [ ] **Step 2: Update `frontend/src/App.tsx`**

Import `ProjectLayout` and wrap the four project routes in a nested layout:

```tsx
import ProjectLayout from "./components/ProjectLayout";

// Replace the four flat /projects/:id/* routes with:
<Route path="/projects/:id" element={<ProjectLayout />}>
  <Route path="chat"    element={<Chat />} />
  <Route path="plan"    element={<PlanApproval />} />
  <Route path="execute" element={<Execution />} />
  <Route path="prs"     element={<PrOverview />} />
</Route>
```

- [ ] **Step 3: TypeScript check**

```bash
cd frontend && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ProjectLayout.tsx frontend/src/App.tsx
git commit -m "feat: add ProjectLayout with Chat/Plan/Execute/Pull Requests tab nav"
```

---

### Task 9: `PrOverview` — review banner and Mark as Done button

**Files:**
- Modify: `frontend/src/pages/PrOverview.tsx`

- [ ] **Step 1: Fetch the parent project**

Add `project` state and load it alongside PRs in the existing effect:

```typescript
const [project, setProject] = useState<Project | null>(null);
// in the effect: setProject(await api.projects.get(projectId!));
```

- [ ] **Step 2: Add `markDoneLoading` state and `handleMarkDone` handler**

```typescript
const [markDoneLoading, setMarkDoneLoading] = useState(false);

const handleMarkDone = async () => {
  if (!projectId) return;
  try {
    setMarkDoneLoading(true);
    await api.projects.markDone(projectId);
    setProject(await api.projects.get(projectId));
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to mark project as done");
  } finally {
    setMarkDoneLoading(false);
  }
};
```

- [ ] **Step 3: Add the banner JSX**

At the top of the returned JSX, before the PR list:

```tsx
{project?.status === "review" && (
  <div className="bg-amber-900 border border-amber-700 rounded-lg p-4 flex items-center justify-between">
    <div>
      <p className="font-semibold text-amber-200">Awaiting PR Merge</p>
      <p className="text-amber-300 text-sm">
        All tasks are complete. Merge the pull requests below to finish the project.
      </p>
    </div>
    <button
      onClick={handleMarkDone}
      disabled={markDoneLoading}
      className="bg-green-700 hover:bg-green-600 disabled:bg-gray-700 px-4 py-2 rounded-lg text-sm font-medium ml-4 shrink-0"
    >
      {markDoneLoading ? "Marking..." : "Mark as Done"}
    </button>
  </div>
)}
{project?.status === "done" && (
  <div className="bg-green-900 border border-green-700 rounded-lg p-4">
    <p className="font-semibold text-green-200">Project Complete</p>
    <p className="text-green-300 text-sm">All pull requests have been merged.</p>
  </div>
)}
```

- [ ] **Step 4: TypeScript check**

```bash
cd frontend && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/PrOverview.tsx
git commit -m "feat: PrOverview shows review-phase banner and Mark as Done button"
```

---

## Final Verification

- [ ] All backend tests pass:

```bash
cd backend && npx vitest run 2>&1 | tail -10
```

- [ ] Frontend TypeScript clean:

```bash
cd frontend && npx tsc --noEmit
```

- [ ] Manual smoke test:
  - Create a test project, approve spec + plan, run execution
  - After tasks complete, project shows `"review"` + amber badge in Dashboard
  - Dashboard shows "Pull Requests" link for review-status project
  - Tab nav (Chat / Plan / Execute / Pull Requests) renders on all project pages
  - `PrOverview` shows amber review banner with "Mark as Done" button
  - Clicking "Mark as Done" transitions project to `"done"`, badge turns green
  - Simulate `POST /api/webhooks/github` with `action: "closed"`, `merged: true` — project transitions to `"done"` automatically
