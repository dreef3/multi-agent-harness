# Project Lifecycle Fixes — Design Spec

**Date:** 2026-03-26
**Status:** Approved

## Summary

Three fixes to the project lifecycle:

1. Spec-document-reviewer runs in the planning agent (not as a sub-agent container task).
2. When all implementation PRs for a project are merged, the project is automatically marked `completed`.
3. When a user sends a chat message to a `completed` project, the project is reactivated to `executing`.

## Background

The current system has three related bugs:

- The `planning-agent/system-prompt.md` instructs the planning agent to dispatch the spec-document-reviewer as a `dispatch_tasks` sub-agent. This spins up a container for a review task that fails with Docker errors, permanently failing the task and poisoning the project status via `checkAllTerminal`.
- When GitHub merges an implementation PR, `pollPullRequest` updates the local PR record but does not update the project status. Projects stay `failed` or `executing` even after all PRs are merged.
- A `completed` project has no path back to active work. If a user opens the chat of a completed project and sends a message, the planning agent responds but the project status never reflects that work is resuming.

## Design

### Change 1 — Spec-reviewer inline in planning agent

**File:** `planning-agent/system-prompt.md`

Remove the override that instructs the planning agent to use `dispatch_tasks` for the spec-document-reviewer:

```
# Remove this line from Phase 1 overrides:
- When the skill instructs you to dispatch a spec-document-reviewer subagent, use the `dispatch_tasks` tool for this — include the full reviewer prompt contents and the spec content in the task description.
```

The brainstorming skill already includes an inline spec self-review step (placeholder scan, consistency check, scope check, ambiguity check). The planning agent performs this review itself before calling `write_planning_document`. No container is started; no task is dispatched.

Code-review tasks dispatched to implementation sub-agents are unaffected — those are separate `dispatch_tasks` calls in Phase 2 and remain correct.

**Why this is safe:** The spec reviewer was never meant to be an independent parallel task. It is a quality gate in the planning agent's own workflow. Running it inline is cheaper, faster, and cannot poison the project status.

### Change 2 — All implementation PRs merged → project completed

**File:** `backend/src/polling.ts`

In `pollPullRequest`, after persisting a non-open PR status, check whether the project should be marked complete:

```
When prInfo.status !== "open":
  updatePullRequest(pr.id, { status: prInfo.status })
  if prInfo.status === "merged":
    allPrs = listPullRequestsByProject(pr.projectId)
    if allPrs.every(p => p.status === "merged" || p.status === "declined"):
      project = getProject(pr.projectId)
      if project.status not in ("completed", "cancelled"):
        updateProject(pr.projectId, { status: "completed" })
```

**Edge cases:**

| Scenario | Behaviour |
|---|---|
| Project already `completed` or `cancelled` | No-op |
| Some PRs `declined`, rest `merged` | Treated as complete (declined = abandoned, not blocking) |
| Zero PRs on project | Not triggered (path requires at least one merged PR) |
| PR merged but tasks still `failed` in plan | Project marked `completed` — merged PR is authoritative over task state |
| Multiple repos, partial merge | Waits until all PRs in `merged`/`declined` |

### Change 3 — User chat reactivates completed project

**File:** `backend/src/api/websocket.ts`

In the WebSocket `message` handler, before forwarding a `prompt` message to the planning agent container, check project status:

```
if incoming.type === "prompt" and project.status === "completed":
  updateProject(projectId, { status: "executing" })
```

The planning agent receives the user's message normally and handles it from there — it can discuss what was done, plan follow-up work, or dispatch new tasks.

**Scope:** Only `type === "prompt"` triggers reactivation. `steer`, `resume`, and connection events do not change the status.

## Files Changed

| File | Change |
|---|---|
| `planning-agent/system-prompt.md` | Remove `dispatch_tasks` override for spec-document-reviewer |
| `backend/src/polling.ts` | Add all-merged check after PR status update |
| `backend/src/api/websocket.ts` | Add `completed → executing` transition on user prompt |

## Out of Scope

- Changing `declined` PR semantics (already treated as terminal, not a new decision).
- Adding a new project status (e.g. `revisiting`) — unnecessary complexity.
- Bulk-reactivation of historical completed projects — only forward-looking.
- Auto-archiving completed projects — separate feature.
