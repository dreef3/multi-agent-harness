# Sub-agent Communication & Execution Tab Design

**Date:** 2026-03-23
**Status:** Approved for implementation

---

## Goal

Enable real-time bidirectional communication between the planning agent and implementation sub-agents, and expose all agent activity (tool calls, conversations, status) in a unified Execution tab. The Chat tab becomes pure conversation text; all tool-level activity moves to the Execution tab.

## Architecture Overview

Three communication channels serve distinct purposes:

1. **Blocking message requests** — sub-agent asks planning agent for clarification; blocks until answered
2. **Activity event stream** — sub-agent streams structured tool calls and output to the harness in real-time
3. **Heartbeat** — runner confirms liveness every 2 minutes; backend detects stuck agents

---

## Section 1: Communication Architecture

### 1.1 Blocking Message Requests

When a sub-agent's AI (pi-coding-agent) is blocked and needs clarification:

1. Sub-agent calls `ask_planning_agent(question: string) → string` tool
2. Tool POSTs `{ question }` to `POST /api/agents/{sessionId}/message`
3. Request long-polls (5-minute timeout)
4. Harness injects a new turn into the planning agent's conversation:
   > *"[Sub-agent: {taskDescription}] asks: {question}"*
5. Planning agent answers autonomously if it has enough context; otherwise asks the human via Chat
6. Planning agent calls `reply_to_subagent(sessionId, reply)` tool
7. Harness resolves the pending long-poll; sub-agent unblocks and receives the reply

**5-minute timeout behaviour:** If no reply arrives within 5 minutes, the harness sends a WebSocket notification to the frontend Chat tab prompting the human to respond.

### 1.2 Activity Event Stream

As pi-coding-agent runs, runner.mjs parses its structured JSONL output and forwards events to the harness:

- `tool_call` — tool name and arguments
- `tool_result` — result or error from a tool invocation
- `text` — narrative text from the AI
- `thinking` — internal reasoning (if exposed by the model)

Events are POSTed to `POST /api/agents/{sessionId}/events` fire-and-forget — they do not block execution.

The harness persists events and broadcasts them over WebSocket with a new event type `agent_activity`, tagged with `{ sessionId, agentType: "sub" }`.

**Fallback:** If pi-coding-agent does not emit structured JSONL, runner.mjs forwards raw log lines as `text` events. Structured display degrades gracefully to a log view.

### 1.3 Heartbeat & Stuck Detection

- Runner.mjs sends `POST /api/agents/{sessionId}/heartbeat` every 2 minutes
- Backend holds an in-memory timer per running `AgentSession`, reset on each heartbeat
- If no heartbeat arrives for **4 minutes**, backend injects a stuck notification into the planning agent:
  > *"[Sub-agent: {taskDescription}] has had no activity for 4 minutes — it may be stuck."*
- Planning agent decides whether to intervene or alert the human
- Timer is cleared when the session completes or fails

### 1.4 Planning Agent Tool Calls in Execution Tab

Planning agent tool calls (`tool_call`, `tool_result`, `thinking`) are already emitted over WebSocket. They are tagged with `agentType: "master"` and routed to the Execution tab. The Chat tab stops rendering these events entirely — it shows conversation text only (`delta`, `message_complete`).

---

## Section 2: Sub-agent Changes

### 2.1 New Environment Variables

Injected by `containerManager.ts` when creating a sub-agent container:

| Variable | Value |
|---|---|
| `HARNESS_API_URL` | Internal URL of the harness backend (reachable on the Docker network) |
| `AGENT_SESSION_ID` | This sub-agent's session ID |

### 2.2 runner.mjs Changes

**A) Local MCP server for `ask_planning_agent`**

Runner starts a small local MCP server before launching pi-coding-agent. Pi-coding-agent connects to it and gains access to one tool:

```
ask_planning_agent(question: string) → string
```

Implementation: when called, runner POSTs to `${HARNESS_API_URL}/api/agents/${AGENT_SESSION_ID}/message` and holds the MCP response open until the harness replies. The AI is fully blocked at this tool call — no further tool invocations execute until the reply arrives.

**Note on `AGENT_PROVIDER` default:** `sub-agent/runner.mjs` currently defaults `AGENT_PROVIDER` to `"opencode-go"`. This default must be updated to the correct pi-coding-agent provider string as part of this work.

**B) Activity event forwarding**

Runner pipes pi-coding-agent's stdout and parses each JSONL line. For each recognised event type (`tool_call`, `tool_result`, `text`, `thinking`), it immediately POSTs to:

```
POST ${HARNESS_API_URL}/api/agents/${AGENT_SESSION_ID}/events
Body: { type, payload, timestamp }
```

Fire-and-forget — network errors are swallowed to avoid disrupting execution.

**C) Heartbeat loop**

Runner starts a `setInterval` (2 minutes) after pi-coding-agent launches:

```
POST ${HARNESS_API_URL}/api/agents/${AGENT_SESSION_ID}/heartbeat
```

Cleared when pi-coding-agent exits.

---

## Section 3: Backend Changes

### 3.1 New API Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/agents/:id/message` | Sub-agent sends question; long-polls for reply (5-min timeout) |
| `POST` | `/api/agents/:id/message/:msgId/reply` | Planning agent delivers reply; resolves pending long-poll |
| `POST` | `/api/agents/:id/events` | Sub-agent posts an activity event |
| `POST` | `/api/agents/:id/heartbeat` | Sub-agent confirms alive; resets stuck timer |
| `GET` | `/api/agents/:id/events` | Fetch full accumulated event array for the session (no pagination; mirrors existing messages replay pattern) |

### 3.2 Planning Agent Notification

`planningAgentManager` gains a `injectMessage(projectId, text)` method that sends a new user turn to the planning agent via the existing TCP RPC channel. Called by:

- `agentsRouter` when a sub-agent message arrives — the router resolves `projectId` from `session.projectId` in the agents store before calling `injectMessage`
- The stuck detection timer when it fires (it already holds `projectId` from the session it is watching)

### 3.2a Message ID Lifecycle

Each blocking question from a sub-agent is assigned a UUID (`msgId`) at request time by the harness. The `msgId` is included verbatim in the injected planning agent message:

> *"[msgId: {uuid}] [Sub-agent: {taskDescription}] asks: {question}"*

The planning agent's `reply_to_subagent` tool signature is:

```
reply_to_subagent(msgId: string, sessionId: string, reply: string) → void
```

The tool description instructs the planning agent to copy the `msgId` exactly from the injected message. The harness maps `msgId → pending response resolver` in memory. If two sub-agents have simultaneous pending questions, each has a distinct `msgId` and both can be resolved independently. Unresolved `msgId`s are cleaned up when their 5-minute timeout fires.

### 3.3 New Planning Agent Tool: `reply_to_subagent`

Registered in the planning agent container's tool configuration:

```
reply_to_subagent(sessionId: string, reply: string) → void
```

Calls `POST /api/agents/{sessionId}/message/{msgId}/reply`. Resolves the blocked sub-agent.

### 3.4 Stuck Detection

In-memory map of `sessionId → NodeJS.Timeout` in `taskDispatcher` (or a dedicated `heartbeatMonitor` module). On each `POST /heartbeat`, the timer for that session is cleared and reset to 4 minutes. On fire: calls `planningAgentManager.injectMessage()` with the stuck notification. Cleared on session completion or failure.

### 3.5 Event Storage

Activity events stored per session in a new in-memory store (`agentEvents.ts`), following the existing store pattern. Events accumulate for the session lifetime and are cleaned up when the session is deleted. The store exposes:

- `appendEvent(sessionId, event)` — add event
- `getEvents(sessionId)` — return all events (for replay)

### 3.6 WebSocket Changes

**Prerequisite — extend `PlanningAgentEvent`:** The existing `PlanningAgentEvent` union type in `planningAgentManager.ts` does not currently include `tool_result` or `thinking` variants. These must be added, and `handleRpcLine` must be updated to parse them from the planning agent's TCP event stream, before the Execution tab can display them.

- Planning agent `tool_call` / `tool_result` / `thinking` events gain an `agentType: "master"` tag before broadcast
- New event type `agent_activity` broadcast when sub-agent events arrive: `{ type: "agent_activity", sessionId, agentType: "sub", event }`
- Chat.tsx stops rendering `tool_call` / `tool_result` / `thinking` events

---

## Section 4: Execution Tab UI

### 4.1 Agent Selector

A horizontal pill bar at the top of the Execution tab:

- **Planning Agent** — always present; shows from the moment the project is opened
- **[Task name]** — one pill per dispatched sub-agent, labelled by task description (truncated to ~40 chars)

Each pill carries a status dot:
- Pulsing blue — running
- Green — completed
- Red — failed
- Amber — stuck (missed heartbeat)

Selecting a pill switches the activity feed below. Default selection: Planning Agent while planning; switches to first sub-agent automatically when execution begins.

### 4.2 Activity Feed

A chronological, scrolling stream of event cards for the selected agent.

**Tool call card**
```
⚙ bash                          ▼
  cd /workspace && git log --oneline -5
  ─────────────────────────────────────
  [result collapsed by default — click to expand]
```
Tool name and arguments visible by default. Result collapsed. Errors shown inline in red.

**Text / thinking bubble**
Inline, lighter style. Thinking prefixed with a subtle italic indicator.

**Conversation cards (sub-agent feed only)**
- Inbound from planning agent: left-aligned bubble labelled `Planning Agent`
- Outbound from sub-agent: right-aligned bubble labelled with task name
- Visually distinct from tool cards — uses the chat bubble style

**Stuck indicator**
Amber full-width banner:
> ⚠ No activity for 4 minutes

Dismissed automatically when activity resumes.

### 4.3 Scroll Behaviour

Auto-scrolls to the bottom while the selected agent is running. Stops auto-scrolling if the user scrolls up (standard chat UX). A "Jump to bottom" button appears when not at the bottom and the agent is still running.

### 4.4 Chat Tab Cleanup

`Chat.tsx` stops rendering `tool_call`, `tool_result`, and `thinking` WebSocket events. It renders only `delta` and `message_complete` events. The existing tool call indicator spinners and tool call history cards are removed from Chat.

---

## Data Flow Summary

```
User → Chat tab (text only)
         ↓
   Planning Agent container (TCP RPC)
         ↓ tool calls → tagged agent_activity (master) → WebSocket → Execution tab
         ↓ injectMessage() ↑ reply_to_subagent()
         ↓
   Harness backend
    ├─ POST /agents/:id/message   ← Sub-agent (blocking ask)
    ├─ POST /agents/:id/events    ← Sub-agent (activity stream)
    ├─ POST /agents/:id/heartbeat ← Sub-agent (liveness)
    └─ WebSocket broadcast: agent_activity (sub) → Execution tab
         ↑
   Sub-agent container (pi-coding-agent + runner.mjs)
    ├─ MCP tool: ask_planning_agent()
    ├─ Event forwarding loop
    └─ Heartbeat interval
```

---

## Out of Scope

- Parallel sub-agent sessions having direct agent-to-agent communication (they communicate only via planning agent)
- Persisting activity events to disk / database (in-memory only for session lifetime)
- QoL improvements (tracked separately)
