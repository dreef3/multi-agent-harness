# Agent Log Persistence & Execution Screen Fix

**Date:** 2026-03-23
**Status:** Approved

## Problem Statement

Three related issues with how agent activity is logged and surfaced:

1. **Sub-agent `task-output.md` pollutes repo root.** The fallback file written when a sub-agent makes no code changes lands at the repo root instead of the hidden log directory. Its content is also minimal (task description + note only).

2. **Agent events are lost on backend restart.** The `agentEvents` store is an in-memory Map. Sub-agent events (tool calls, results, text) are replayed correctly from this store when the Execution screen loads — but a backend restart wipes them. Planning agent events are never stored at all.

3. **Execution screen shows nothing for the Planning Agent.** Planning agent events (tool calls, results, thinking) are broadcast live over WebSocket but never persisted. Opening the Execution screen after activity has occurred shows an empty feed for the Planning Agent pill.

---

## Solution Overview

Three targeted fixes, independent of each other but delivered together:

| Fix | Scope |
|-----|-------|
| A — Move sub-agent fallback file | `sub-agent/runner.mjs` |
| B — Durable agent events via SQLite | `backend/src/store/agentEvents.ts`, `db.ts`, `websocket.ts`, `projects.ts`, `Execution.tsx` |
| C — Planning agent session committed to git | `backend/src/orchestrator/planningAgentManager.ts` |

---

## Fix A: Sub-agent fallback file path

**Current behaviour:** When the AI agent completes but makes no file changes, `runner.mjs` writes a placeholder to `task-output.md` at the repo root. This file is then committed, polluting every branch.

**Change:** Write the fallback file to `.harness/logs/sub-agents/${TASK_ID}/task-output.md` instead. This directory is already created a few lines later in the same runner for `session.jsonl`, so no additional `mkdirSync` is required — just reorder to create the dir first, then write both files.

The two log artefacts for a task end up co-located:
```
.harness/logs/sub-agents/<taskId>/
  session.jsonl      ← complete JSONL session log (already committed)
  task-output.md     ← human-readable fallback summary (moved here)
```

No other files change for this fix.

---

## Fix B: Durable agent events via SQLite

### SQLite migration (`db.ts`)

Add a new table to the existing `migrate()` function:

```sql
CREATE TABLE IF NOT EXISTS agent_events (
  session_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,   -- JSON-serialised payload object
  timestamp   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_events_session
  ON agent_events (session_id);
```

No existing tables are altered.

### `agentEvents.ts` — swap storage backend

Replace the in-memory `Map<string, AgentEvent[]>` with SQLite reads/writes. The public interface (`appendEvent`, `getEvents`, `clearEvents`) stays identical — no callers change.

```ts
// appendEvent: INSERT INTO agent_events ...
// getEvents:   SELECT ... WHERE session_id = ? ORDER BY rowid
// clearEvents: DELETE FROM agent_events WHERE session_id = ?
```

### Planning agent event persistence (`websocket.ts`)

In the project-wide broadcaster registered once per project, the `tool_call`, `tool_result`, `thinking`, and `message_complete` cases already call `broadcastToProject`. They will also call `appendEvent("master-${projectId}", ...)` so planning agent activity is durable.

The `delta` case (streaming text) is intentionally excluded — deltas are high-frequency partial tokens; only `message_complete` (which writes the assembled message to the chat store) is persisted.

### New endpoint (`projects.ts` or `api/routes.ts`)

```
GET /api/projects/:id/master-events
→ returns getEvents("master-${projectId}")
```

Returns the same `AgentEvent[]` shape as `GET /api/agents/:id/events`.

### Execution screen replay (`Execution.tsx`)

Add a `useEffect` alongside the existing sub-agent session replay:

```ts
fetch(`/api/projects/${id}/master-events`)
  .then(r => r.json())
  .then(evts => {
    const mapped: ActivityEvent[] = evts.map((e, i) => ({ ... }));
    setEvents(prev => { const m = new Map(prev); m.set("master", mapped); return m; });
  });
```

The mapping from `AgentEvent` → `ActivityEvent` follows the same pattern used for sub-agent replay (lines 89–100 of current `Execution.tsx`).

---

## Fix C: Planning agent session committed to git

### Trigger points

The planning agent session file at `/pi-agent/sessions/planning-${projectId}.jsonl` is committed to git at two points:

1. **On `conversation_complete`** — saves a snapshot after each full agent response. Protects against crash data loss mid-session.
2. **On `stopContainer`** — final save when the container is stopped (idle timeout or explicit stop).

Both are best-effort: failures are logged as warnings but never block the stop or raise an error to callers.

### Mechanism (`planningAgentManager.ts`)

A new private async method `commitSessionLog(projectId)`:

1. Read `/pi-agent/sessions/planning-${projectId}.jsonl` using `fs.readFileSync`. If the file doesn't exist, return silently.
2. Look up `getProject(projectId)` → `project.primary_repository_id` → `getRepository(id)`. If no primary repo, return silently.
3. Instantiate `GitHubConnector` (already used elsewhere in the backend).
4. Call `connector.commitFile(repo, repo.defaultBranch, path, content, message)` where:
   - `path` = `.harness/logs/planning-agent/${projectId}.jsonl`
   - `message` = `"chore: save planning agent session log [${projectId}]"`
5. `commitFile` already handles create-vs-update (SHA lookup), so repeated calls are safe.

`stopContainer` calls `await this.commitSessionLog(projectId)` before stopping the Docker container.

The `conversation_complete` handler in `handleRpcLine` calls `void this.commitSessionLog(projectId)` (fire-and-forget).

### Imports needed in `planningAgentManager.ts`

- `fs.readFileSync` from `node:fs`
- `GitHubConnector` from `../connectors/github.js`
- `getProject` from `../store/projects.js`
- `getRepository` from `../store/repositories.js` (or equivalent)

---

## Data Flow Summary

```
Sub-agent container
  └─ session.jsonl (complete)  →  git: .harness/logs/sub-agents/<taskId>/session.jsonl
  └─ task-output.md (summary)  →  git: .harness/logs/sub-agents/<taskId>/task-output.md  [FIX A]

Planning agent container
  └─ /pi-agent/sessions/planning-<projectId>.jsonl (volume, readable by backend)
       ├─ on conversation_complete → git: .harness/logs/planning-agent/<projectId>.jsonl  [FIX C]
       └─ on stopContainer        → git: .harness/logs/planning-agent/<projectId>.jsonl  [FIX C]

Backend (SQLite, harness-data volume)
  └─ agent_events table
       ├─ session_id = <subAgentSessionId>  ← sub-agent tool calls/results  [FIX B]
       └─ session_id = master-<projectId>  ← planning agent tool calls/results/thinking  [FIX B]
            └─ served via GET /api/projects/:id/master-events
                 └─ replayed in Execution screen on load  [FIX B]
```

---

## Out of Scope

- Converting `session.jsonl` (JSONL) to a human-readable HTML/Markdown log — the raw JSONL is sufficient for now.
- Bitbucket connector support for Fix C — only GitHub repos get the planning session committed; Bitbucket projects silently skip it.
- Retention / pruning of `agent_events` rows — no limit on row count for now.
