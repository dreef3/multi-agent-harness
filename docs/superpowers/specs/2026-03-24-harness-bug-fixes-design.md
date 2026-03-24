# Multi-Agent Harness Bug Fixes Design Spec

**Date:** 2026-03-24
**Status:** Approved

---

## Overview

Seven bug fixes and improvements to the multi-agent harness covering: chat message display correctness, React rendering performance, planning agent lifecycle robustness, execution tab navigation, tool call visibility in chat, project failure recovery, and Docker container cleanup.

---

## Bug 1 — Chat Message Ordering, Wrong-Project Messages, Duplicates

### Root Causes

1. **Wrong-project messages:** When navigating between projects (same React route, different `:id` param), the `messages` state is not reset. Old project messages persist until new ones load.

2. **Duplicate messages:** `handleSend` adds an optimistic user message with `seqId: undefined`. When `loadMessages` runs after `message_complete`, the DB version has `seqId: 1`. The dedup filter (`existingSeqIds.has(m.seqId)`) passes both because `undefined !== 1`, producing two copies of the user message.

3. **Ordering:** Follows from dedup — merged list contains both the unsequenced optimistic message and the real one.

### Fix

- At the top of `useEffect([id])` in `Chat.tsx`: reset `messages` to `[]` and `lastSeqIdRef.current` to `0` so stale data from the previous project is cleared immediately.
- Change `loadMessages` to **replace** state with DB data directly (`setMessages(data)`) instead of merging. DB is the source of truth; the optimistic message only serves as transient visual feedback and should be superseded on first reload. `streamingContent` is unaffected (separate state).

### Tests

- State resets to empty when project ID changes
- No duplicate messages after optimistic send + `loadMessages`
- Messages sorted by `seqId` after reload

---

## Bug 2 — Slow Chat Input

### Root Cause

Every WebSocket `delta` event calls `setStreamingContent(prev => prev + text)`, triggering a full re-render of `Chat`. Each re-render runs `ReactMarkdown` for every historical message. The input `onChange` handler then executes in an already-expensive render cycle, causing perceived lag.

### Fix

- Extract message rendering into a `MessageBubble` component wrapped in `React.memo`. Props: `{ message: Message }`. Only re-renders when its own message reference changes.
- Wrap `handleSend` in `useCallback`.
- The streaming bubble stays inline in `Chat` (it changes every delta anyway; memoising it would be counterproductive).

### Tests

- `MessageBubble` does not re-render when `streamingContent` changes (verify with render spy)
- Input remains responsive during streaming

---

## Bug 3 — Planning Agent Lifecycle

### Design: State Machine

`ProjectState` gains `lifecycleState: "starting" | "running" | "idle" | "stopping"` and `stopTimer: ReturnType<typeof setTimeout> | null`.

**Transitions:**

| From | Event | To | Side effect |
|------|-------|----|-------------|
| `starting` | TCP RPC connected | `running` | — |
| `running` | last WS disconnects AND not streaming/pending | `idle` | Start 2-min stop timer |
| `idle` | new WS connects OR `sendPrompt` called | `running` | Cancel stop timer |
| `idle` | stop timer fires AND project is terminal OR grace exceeded | `stopping` | `stopContainer()` |
| `running`/`idle` | `onProjectTerminal()` | `stopping` | `stopContainer()` |
| `running`/`idle` | TCP socket closes unexpectedly | `crashed` | Remove from map; recovery service restarts |

**Key rules:**

- `checkStop` transitions to `idle` (starts timer) — never stops directly.
- `incrementConnections` cancels any pending stop timer before incrementing.
- `sendPrompt` calls `ensureRunning` if container is missing (already exists); additionally cancels stop timer and restores `running` if container is `idle`.
- `agent_end` does **not** stop the container — lifecycle is driven by WS connections and project status only.
- On unexpected TCP socket close while `lifecycleState !== "stopping"`: log error, set `lifecycleState` to `crashed`, remove project from map. Recovery service restarts on next poll.

**Recovery service addition:**

`recoverExecutingProjects()` (runs each polling cycle) also checks active projects with no running planning container and calls `ensureRunning` to restart crashed containers.

### Tests

- Container not stopped during 2-min grace period after disconnect
- Container stop cancelled when new connection arrives during grace period
- Container survives when project status is non-terminal at grace period expiry
- Sub-agent `sendPrompt` restarts container when idle
- Unexpected TCP close triggers crash state + recovery service restarts

---

## Bug 4 — Execution Tab Picker

### Design

Replace the `flex-wrap` pill container in `Execution.tsx` with a compact custom dropdown (`AgentPicker` component, ~50 lines, local to `Execution.tsx`).

**Trigger button:** `[●] <selected agent label> ▼` — colored status dot + label + chevron. Single line regardless of agent count.

**Dropdown list:** Appears below trigger on click. Each row: `[●] <label>`. Scrollable if tall. Status dot uses same `STATUS_DOT` color mapping and `animate-pulse` for `running` state.

**Outside-click close:** `useRef` on the wrapper + `useEffect` with `mousedown` listener on `document`.

**Labels:** Unchanged — `"Planning Agent"` for master, `(s.taskId ?? s.id).slice(0, 40)` for sub-agents (already task names).

**Status dot:** Preserved exactly — same colors, same animations.

### Tests

- Dropdown opens/closes on trigger click
- Selecting an agent updates `selectedAgent`
- Clicking outside closes the dropdown
- Status dot color matches agent status

---

## Bug 5 — Tool Calls Visible in Chat

### Design

Add two state values to `Chat.tsx`:

```typescript
const [currentToolCall, setCurrentToolCall] = useState<ToolEvent | null>(null);
const [toolCallCount, setToolCallCount] = useState(0);
```

Where `ToolEvent = { toolName: string; args?: Record<string,unknown>; result?: unknown; isError?: boolean }`.

**WS message handling:**

- `tool_call`: replace `currentToolCall` with new call (args, no result yet), increment `toolCallCount`.
- `tool_result`: update `currentToolCall` with result and `isError`.
- `conversation_complete`: clear `currentToolCall` and reset `toolCallCount` to `0`.

**Render:** When `thinkingMode !== "none"` and `currentToolCall !== null`, show a single card above the streaming bubble:

```
⚙ tool_name  [+N more ▼]  (collapsed by default)
   args / result shown when expanded
```

The `+N more` badge only appears when `toolCallCount > 1`. User can expand/collapse the card.

**No persistence:** Tool call state is ephemeral — lives only during the active processing turn. Historical tool calls are not shown (they're in the Execution tab).

### Tests

- Tool call card appears on `tool_call` WS message
- Card updates with result on `tool_result`
- Count badge shows correct number after multiple tool calls
- Card clears on `conversation_complete`
- No card shown when `thinkingMode === "none"`

---

## Bug 6 — Project Recovery from Failed State

### Backend: Retry Endpoint

`POST /api/projects/:id/retry`

- Validates project exists and is in `failed` or `error` state.
- Resets all `failed` tasks to `pending` (via `recoveryService.dispatchFailedTasks()`).
- Sets project `status` to `executing`.
- Calls `ensureRunning` on the planning agent if not already running.
- Clears `lastError` on the project.
- Returns `{ dispatched: number, agentRestarted: boolean }`.

### Backend: Error Persistence

`Project` model gains `lastError?: string`. Set via `updateProject` when container start fails. Cleared on successful recovery. Returned in all project API responses.

### Backend: WS Resilience

When `ensureRunning` throws:

1. Send `{ type: "error", message: "...", retrying: true, attempt: N, maxAttempts: 5 }` to client. Keep WS open.
2. Retry with backoff: 5s → 15s → 30s → 60s → 120s (5 attempts).
3. Abort if WS closes during retry.
4. On success: complete normal setup (increment connections, register handlers, flush queue).
5. On all retries exhausted: `updateProject(id, { lastError: message })`, send final error to client, close WS.

### Frontend: Dashboard

- Failed/error projects show a `Retry` button alongside `Chat` / `Execute`.
- Button shows spinner during the `POST /api/projects/:id/retry` call.
- On success: refresh project in list.
- `lastError` shown in small red text under project name when present.
- `api.projects.retry(id)` added to `api.ts`.

### Frontend: Chat

- On `{ type: "error", retrying: true }`: show non-blocking amber banner at top of message feed: `"Starting agent… (attempt N/5)"`.
- Banner dismisses on first successful WS message or on navigate-away.
- On final error (no `retrying`): show red banner, stays until dismissed or page reload.

### Tests

- `POST /api/projects/:id/retry` resets tasks and re-dispatches
- Returns 400 for non-failed project
- WS retries up to 5 times before closing
- Dashboard shows Retry button for failed projects
- Dashboard hides Retry button for non-failed projects
- Chat shows amber retry banner during retries

---

## Bug 7 — Docker Cleanup

### On Container Stop

In `PlanningAgentManager.stopContainer()`, after `docker.stop()`, call `docker.remove({ force: false })` on the same container. Log success. Errors are non-fatal (warn and continue).

### On Startup

`PlanningAgentManager.cleanupStaleContainers()` — called once from `index.ts` after manager initialization:

1. `docker.listContainers({ all: true })`
2. Filter: name starts with `planning-` or `task-`, state is not `running`
3. `docker.remove({ force: true })` for each match
4. Per-container errors are non-fatal (logged, loop continues)

### Volumes

Planning agent and sub-agent containers bind-mount the named `pi-agent` volume. Named volumes survive container removal (Docker default) — correct, this volume is shared and must persist. No anonymous volumes are created by these containers. `remove()` is called without `v: true`.

### Tests

- `stopContainer` calls `remove` after `stop`
- `cleanupStaleContainers` removes stopped `planning-*` and `task-*` containers
- `cleanupStaleContainers` does not remove running containers
- `cleanupStaleContainers` is non-fatal when removal fails

---

## Files Changed

| File | Change |
|------|--------|
| `frontend/src/pages/Chat.tsx` | Bugs 1, 2, 5 |
| `frontend/src/pages/Chat.test.tsx` | Tests for bugs 1, 2, 5 |
| `frontend/src/pages/Execution.tsx` | Bug 4 (AgentPicker component) |
| `frontend/src/pages/Execution.test.tsx` | Tests for bug 4 (new file) |
| `frontend/src/pages/Dashboard.tsx` | Bug 6 (Retry button + lastError) |
| `frontend/src/pages/Dashboard.test.tsx` | Tests for bug 6 (new file) |
| `frontend/src/lib/api.ts` | Add `projects.retry()` |
| `backend/src/orchestrator/planningAgentManager.ts` | Bugs 3, 7 |
| `backend/src/api/websocket.ts` | Bug 6 (WS retry on start failure) |
| `backend/src/api/projects.ts` | Bug 6 (retry endpoint) |
| `backend/src/models/types.ts` | Add `lastError` to Project |
| `backend/src/store/projects.ts` | Persist `lastError` |
| `backend/src/__tests__/planningAgentManager.test.ts` | Tests for bugs 3, 7 |
| `backend/src/__tests__/projects.test.ts` | Tests for bug 6 retry endpoint |

---

## Out of Scope

- Rewriting the WebSocket client singleton architecture
- Sub-agent container lifecycle state machine (sub-agents are fire-and-forget; recovery already handles them)
- Persistent tool call history in Chat (available in Execution tab)
- Volume cleanup beyond named volume preservation
