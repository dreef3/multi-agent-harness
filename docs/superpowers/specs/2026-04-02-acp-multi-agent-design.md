# ACP Multi-Agent Transition Design

> Transition the harness from pi-coding-agent-specific integration to a
> universal ACP-based architecture supporting Pi, Gemini CLI, Claude Code,
> Copilot CLI, and OpenCode with full feature parity.

**Date:** 2026-04-02  
**Status:** Draft spec

---

## 1. Goals

1. Replace the pi-coding-agent-specific TCP RPC bridge with standard ACP (Agent Client Protocol) JSON-RPC 2.0.
2. Support five CLI agents with feature parity: Pi (via pi-acp), Gemini CLI, Claude Code (via claude-agent-acp), Copilot CLI, OpenCode.
3. Unify planning agent and sub-agent lifecycle management under a single `AcpAgentManager`.
4. Make sub-agents reusable within a project (multi-task, CI-fix loops) with idle timeout.
5. Enable superpowers skills on sub-agents (executing-plans, systematic-debugging, verification-before-completion).
6. Push ACP events end-to-end to the frontend (no translation layer).

## 2. Non-Goals

- A2A protocol support (future consideration for cross-organization agent orchestration).
- Replacing per-agent native mechanisms (guard hooks, RTK, skills) with a universal abstraction.
- Supporting agents that don't speak ACP.

---

## 3. Architecture Overview

```
Frontend (browser)
    │ WebSocket
    │ (raw ACP session/update notifications)
    ▼
┌──────────────────────────────────────────────────────────┐
│ Backend                                                   │
│                                                           │
│  ┌──────────────────────────────────┐                     │
│  │         AcpAgentManager          │                     │
│  │                                  │                     │
│  │  - Manages ALL agent containers  │                     │
│  │    (planning + sub-agents)       │                     │
│  │  - Connects TCP to :3333        │                     │
│  │  - ACP JSON-RPC 2.0 client      │                     │
│  │  - Forwards session/update → WS  │                     │
│  │  - OTEL spans from tool_call     │                     │
│  │  - Idle timeout → stop           │                     │
│  └────────────┬─────────────────────┘                     │
│               │ ACP (JSON-RPC 2.0 / TCP :3333)            │
└───────────────┼───────────────────────────────────────────┘
                │
    ┌───────────┴────────────┐
    │   Agent Container       │
    │                         │
    │  ┌───────────────────┐  │
    │  │ stdio→TCP bridge  │  │  (listens :3333, pipes to ACP subprocess)
    │  └────────┬──────────┘  │
    │           │ stdio        │
    │  ┌────────┴──────────┐  │
    │  │  ACP agent        │  │  pi-acp / gemini --acp / claude-agent-acp /
    │  │                   │  │  copilot --acp / opencode acp
    │  │  Native config:   │  │
    │  │  - Guard hooks    │  │  (per-agent mechanism)
    │  │  - RTK            │  │  (per-agent mechanism)
    │  │  - Skills         │  │  (per-agent mechanism)
    │  │  - System prompt  │  │  (AGENTS.md / CLAUDE.md / GEMINI.md / etc.)
    │  │  - MCP: harness   │  │  (remote MCP → backend:3000/mcp)
    │  └───────────────────┘  │
    └─────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ Backend                                                   │
│                                                           │
│  ┌──────────────────────┐  ┌──────────────────────────┐  │
│  │   AcpAgentManager    │  │  MCP SSE Server           │  │
│  │   (TCP → agents)     │  │  (http://backend:3000/mcp)│  │
│  │                      │  │                            │  │
│  │                      │  │  Tools call store/         │  │
│  │                      │  │  orchestrator directly     │  │
│  │                      │  │  — no HTTP round-trip      │  │
│  └──────────────────────┘  └──────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### 3.1 Protocol responsibilities

| Layer | Protocol | Purpose |
|---|---|---|
| Backend ↔ Agent | ACP (JSON-RPC 2.0 over TCP) | Session lifecycle, prompts, streaming events |
| Agent ↔ Harness tools | MCP (SSE, remote — `http://backend:3000/mcp`) | Custom tool invocation (dispatch, plan docs, status, etc.) |
| Backend ↔ Frontend | WebSocket | Forward raw ACP `session/update` notifications |
| Per-agent native | Each CLI's own system | Guard hooks, RTK, skills, system prompt, OTEL config |

### 3.2 What changes from today

| Component | Current | New |
|---|---|---|
| `PlanningAgentManager` | pi-coding-agent-specific RPC, planning-only | `AcpAgentManager` — generic ACP, manages all agents |
| Sub-agent runner | `runner.mjs` imports pi SDK, one-shot | ACP subprocess, reusable session, idle timeout |
| Custom tools | JS objects via `customTools` array | MCP server hosted in backend (SSE), agents connect remotely |
| Guard hook | `BashSpawnHook` in runner.mjs | Per-agent native hook mechanism |
| Frontend events | `PlanningAgentEvent` (custom type) | Raw ACP `session/update` notifications |
| Container images | `planning-agent` + `sub-agent` | `agent-{pi,gemini,claude,copilot,opencode}` |
| Skills (sub-agent) | `noSkills: true` | Superpowers enabled (executing-plans, systematic-debugging, verification) |
| Model selection | `AGENT_PLANNING_MODEL=provider/model` | Same format + `AGENT_TYPE={pi,gemini,claude,copilot,opencode}` |

---

## 4. AcpAgentManager

Replaces `PlanningAgentManager`. Single class managing all agent containers.

### 4.1 State model

```typescript
interface AgentState {
  containerId: string;
  containerName: string;
  tcpSocket: Socket;              // TCP connection to agent :3333
  lineBuffer: string;             // partial JSON-RPC line buffer
  acpSessionId: string | null;    // ACP session ID after session/new
  acpInitialized: boolean;        // true after initialize handshake
  isStreaming: boolean;           // true during an active prompt turn
  promptPending: boolean;
  wsConnectionCount: number;
  outputHandlers: Set<(event: AcpNotification) => void>;
  lifecycleState: "running" | "idle" | "stopping" | "crashed";
  stopTimer: ReturnType<typeof setTimeout> | null;
  // OTEL
  sessionSpan: Span | null;
  turnSpan: Span | null;
  toolSpans: Map<string, Span>;   // toolCallId → span
}
```

Registry: `Map<string, AgentState>` keyed by composite ID:
- Planning agents: `planning-{projectId}`
- Sub-agents: `sub-{taskId}`

### 4.2 Lifecycle

```
ensureRunning(agentId, config)
  ├─ Find or create Docker container (same as today)
  ├─ Start container
  ├─ Connect TCP to :3333 (exponential backoff, up to 120s)
  ├─ ACP initialize handshake
  │   → send: { method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }
  │   ← recv: { protocolVersion, agentCapabilities, agentInfo }
  ├─ ACP session/new
  │   → send: { method: "session/new", params: { cwd: "/workspace/repo" } }
  │   ← recv: { sessionId: "..." }
  ├─ Register in state map
  └─ Start listening for ACP events on TCP socket

sendPrompt(agentId, message)
  → send: { method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: message }] } }
  ← stream: session/update notifications (agent_message_chunk, tool_call, tool_call_update, plan)
  ← final: session/prompt response with { stopReason: "end_turn" | "cancelled" | ... }

stopAgent(agentId)
  ├─ Close TCP socket
  ├─ Stop + remove container
  └─ End OTEL spans
```

### 4.3 ACP event handling

The TCP socket receives newline-delimited JSON-RPC messages. The manager handles:

| ACP message | Action |
|---|---|
| `session/update` notification with `agent_message_chunk` | Forward to WS handlers; emit text for OTEL |
| `session/update` notification with `tool_call` | Forward to WS; start OTEL tool span; record tool name, kind |
| `session/update` notification with `tool_call_update` | Forward to WS; update OTEL span status; on `completed`/`failed` end span |
| `session/update` notification with `plan` | Forward to WS |
| `session/prompt` response | Extract `stopReason`; end turn OTEL span; emit completion event |
| `session/request_permission` request | Auto-allow (agents enforce their own guard hooks) |

### 4.4 OTEL instrumentation

Same metrics as today, derived from ACP events:

- **Counter:** `harness.tool_calls.total` — incremented on each `tool_call` notification
- **Histogram:** `harness.tool_calls.duration_ms` — measured between `tool_call` (status: pending/in_progress) and `tool_call_update` (status: completed/failed)
- **Counter:** `harness.tokens.input` / `harness.tokens.output` — extracted from ACP `session/prompt` response if the agent includes usage data. Not all ACP agents report token usage; for agents that don't (e.g. pi-acp), these counters will be zero. Agents with built-in OTEL (Gemini CLI, Claude Code) export their own token metrics directly to the OTEL collector, bypassing this counter.
- **Spans:** session → turn → tool call hierarchy, same as today

### 4.5 Sub-agent reuse

Sub-agents are now persistent ACP sessions (like planning agents). A sub-agent container stays alive between tasks within the same project:

1. First task: `ensureRunning("sub-{taskId}", ...)` creates container + ACP session
2. Task completes: container enters idle state, 2-minute grace timer
3. Next task for same project: reuse the container, send new `session/prompt`
4. CI failure detected: planning agent sends follow-up prompt to same sub-agent session
5. No more tasks + idle timeout: container stops

Container naming: `sub-{projectId}-{slot}` where slot is 0..maxImplAgentsPerProject-1.

---

## 5. Container Layout

### 5.1 Directory structure

```
agents/
├── base/
│   └── Dockerfile.base          # shared: git, gh, node, rtk, stdio-tcp-bridge
├── stdio-tcp-bridge.mjs         # ~30 lines: listen TCP :3333, spawn ACP subprocess, pipe stdio
├── pi/
│   ├── Dockerfile               # FROM base + pi-acp + superpowers
│   ├── config/                  # pi-coding-agent settings, guard hook config
│   └── system-prompt.md         # planning agent system prompt (existing, moved)
├── gemini/
│   ├── Dockerfile               # FROM base + gemini CLI
│   ├── .gemini/settings.json    # OTEL, MCP server registration, extension hooks
│   └── GEMINI.md                # system prompt
├── claude/
│   ├── Dockerfile               # FROM base + claude CLI + claude-agent-acp
│   ├── settings.json            # hooks (guard), MCP server registration
│   └── CLAUDE.md                # system prompt
├── copilot/
│   ├── Dockerfile               # FROM base + copilot CLI
│   ├── mcp.json                 # MCP server registration
│   └── instructions.md          # system prompt
└── opencode/
    ├── Dockerfile               # FROM base + opencode binary
    ├── opencode.json            # config, MCP registration
    └── AGENTS.md                # system prompt + rules
```

### 5.2 Shared base Dockerfile

```dockerfile
FROM node:22-slim

RUN apt-get update && apt-get install -y \
    git curl build-essential python3 \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       | tee /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# RTK binary + config
COPY shared/bin/rtk /usr/local/bin/rtk
RUN chmod +x /usr/local/bin/rtk
COPY shared/config/rtk-config.toml /root/.config/rtk/config.toml

# stdio→TCP bridge
COPY agents/stdio-tcp-bridge.mjs /app/stdio-tcp-bridge.mjs

RUN mkdir -p /workspace /agent-data
```

### 5.3 stdio→TCP bridge

Most ACP agents communicate via stdio. The backend connects via TCP. A small bridge script runs as the container entrypoint:

```javascript
// stdio-tcp-bridge.mjs — ~30 lines
// Listens on TCP :3333, spawns ACP agent subprocess, pipes stdin↔socket, stdout↔socket
import { createServer } from "net";
import { spawn } from "child_process";

const [agentCmd, ...agentArgs] = process.argv.slice(2);
const agent = spawn(agentCmd, agentArgs, { stdio: ["pipe", "pipe", "inherit"] });

const server = createServer((socket) => {
  socket.pipe(agent.stdin, { end: false });
  agent.stdout.pipe(socket, { end: false });
  socket.on("close", () => { /* handle reconnect */ });
});

server.listen(3333, "0.0.0.0");
agent.on("exit", (code) => process.exit(code));
```

Exception: Copilot CLI supports `--acp --port 3333` natively, so its entrypoint skips the bridge.

### 5.4 Per-agent entrypoints

| Agent | Container entrypoint |
|---|---|
| Pi | `node /app/stdio-tcp-bridge.mjs npx pi-acp` |
| Gemini | `node /app/stdio-tcp-bridge.mjs gemini --acp` |
| Claude | `node /app/stdio-tcp-bridge.mjs claude-agent-acp` |
| Copilot | `copilot --acp --port 3333` |
| OpenCode | `node /app/stdio-tcp-bridge.mjs opencode acp` |

---

## 6. MCP Server (Backend-Hosted)

The backend hosts an MCP server over SSE at `http://backend:3000/mcp`. Agent containers connect to it as a remote MCP server. Tool handlers call the backend's store and orchestrator modules directly — no HTTP API round-trip, no duplicate REST surface.

### 6.1 Implementation

The MCP SSE endpoint is added to the existing Express app in `backend/src/`:

```
backend/src/mcp/
├── server.ts               # MCP SSE endpoint setup (Express middleware)
├── tools/
│   ├── dispatch_tasks.ts   # calls taskDispatcher directly
│   ├── ask_planning_agent.ts  # calls planningAgentManager.injectMessage()
│   ├── write_planning_document.ts  # calls gitHub connector directly
│   ├── get_task_status.ts  # calls store/tasks directly
│   ├── get_pull_requests.ts  # calls store/pullRequests directly
│   ├── reply_to_subagent.ts  # calls message store directly
│   └── web_fetch.ts        # HTTP fetch with SSRF guard (Pi agents only)
```

Uses `@modelcontextprotocol/sdk` server with SSE transport. Each tool is defined with JSON Schema input, and calls existing backend functions — the same code paths that the current REST API routes use, but without the HTTP serialization layer.

### 6.2 Session context

The MCP connection needs to know which agent is calling. The agent's MCP config includes query parameters in the URL:

```
http://backend:3000/mcp?projectId={PROJECT_ID}&sessionId={AGENT_SESSION_ID}&role={planning|implementation}
```

The MCP server reads these from the connection to:
- Filter tools by role (planning agents get `dispatch_tasks`; sub-agents get `ask_planning_agent`)
- Scope tool operations to the correct project
- Correlate tool calls with OTEL spans

### 6.3 Tool availability by agent role

| Tool | Planning agent | Sub-agent |
|---|---|---|
| `dispatch_tasks` | Yes | No |
| `write_planning_document` | Yes | No |
| `get_task_status` | Yes | No |
| `get_pull_requests` | Yes | No |
| `reply_to_subagent` | Yes | No |
| `ask_planning_agent` | No | Yes |
| `web_fetch` | Yes | Yes (Pi only; others have built-in) |

### 6.4 Per-CLI registration

Each CLI registers the backend MCP server as a remote SSE server. Example for Gemini:

```json
// .gemini/settings.json
{
  "mcpServers": {
    "harness": {
      "url": "http://backend:3000/mcp?projectId=${PROJECT_ID}&sessionId=${AGENT_SESSION_ID}&role=planning"
    }
  }
}
```

Equivalent configs for Claude (`settings.json`), Copilot (`mcp.json`), OpenCode (`opencode.json`), Pi (native MCP config). The URL template variables are resolved at container startup (injected via env vars or config file generation).

### 6.5 Advantages over in-container sidecar

- **No duplicate API surface:** Tools call store/orchestrator directly, not via HTTP. The existing REST API routes (`/api/projects/:id/tasks`, `/api/agents/:id/message`, etc.) can be gradually deprecated for agent use.
- **No sidecar process:** One fewer process per container. Simpler container images.
- **Centralized:** Tool logic lives in the backend codebase, same language (TypeScript), same test infrastructure. Tool changes deploy once.
- **Auth:** Backend can authenticate MCP connections using the session ID, ensuring agents can only access their own project's data.

---

## 7. Per-Agent Native Configuration

### 7.1 Guard hooks

Each CLI enforces command blocking using its own mechanism. The blocked patterns are the same as today (force push, `gh pr create`, `curl`, `wget`, `.harness/` access).

| CLI | Mechanism | Implementation |
|---|---|---|
| Pi | `BashSpawnHook` passed to `createCodingTools()` | Existing `tools.mjs` `createGuardHook()` — called by pi-acp or a wrapper |
| Gemini | Extension hook or `.gemini/settings.json` tool restrictions | Config-based |
| Claude | `PreToolUse` hook in `settings.json` → shell script | `/app/guard-hook.sh` checks command against blocked patterns |
| Copilot | Permission request handler (auto-reject blocked patterns) | Handled by AcpAgentManager's `session/request_permission` response |
| OpenCode | Plugin hook or permissions config | Config-based or plugin file |

For Copilot specifically: since it sends `session/request_permission` for tool execution, the `AcpAgentManager` can inspect the tool call and reject blocked commands. This is the one case where ACP participates in guard enforcement.

### 7.2 RTK (token filtering)

RTK binary is in the base image. Each agent needs to route bash output through it:

| CLI | RTK integration |
|---|---|
| Pi | BashSpawnHook prepends `rtk` (existing behavior, preserved by pi-acp) |
| Gemini | Extension hook or `PATH` manipulation |
| Claude | `PostToolUse` hook pipes bash output through `rtk` |
| Copilot | `PATH` manipulation or system prompt instruction |
| OpenCode | Plugin hook or `PATH` manipulation |

### 7.3 System prompts

Planning agent and sub-agent each get a system prompt. Delivered via each CLI's native mechanism:

| CLI | Planning prompt | Sub-agent prompt |
|---|---|---|
| Pi | `system-prompt.md` via `resourceLoader.systemPrompt` (existing) | New `sub-agent-prompt.md` |
| Gemini | `GEMINI.md` in working directory | `GEMINI.md` in workspace root |
| Claude | `CLAUDE.md` in working directory | `CLAUDE.md` in workspace root |
| Copilot | `instructions.md` or `.github/copilot-instructions.md` | Same, in workspace root |
| OpenCode | `AGENTS.md` or rules files | `AGENTS.md` in workspace root |

Sub-agent system prompt content (common across all CLIs):
- You are an implementation agent. Your job is to implement a specific task.
- Use the `ask_planning_agent` tool when blocked.
- Follow the executing-plans skill workflow.
- Use systematic-debugging when encountering failures.
- Run verification-before-completion before claiming done.
- Commit and push changes when task is complete.

### 7.4 Skills / superpowers

| CLI | Skill delivery | Planning skills | Sub-agent skills |
|---|---|---|---|
| Pi | `superpowers` npm package (existing) | brainstorming, writing-plans | executing-plans, systematic-debugging, verification-before-completion |
| Gemini | Extension or inline in system prompt | Same set | Same set |
| Claude | Skills directory in container | Same set | Same set |
| Copilot | Inline in system prompt (no native skills) | Same set | Same set |
| OpenCode | Plugin directory or inline | Same set | Same set |

For CLIs without a native skill loader (Copilot), the key skill instructions are embedded directly in the system prompt. The full skill files are ~100 lines each — small enough to inline without excessive prompt bloat.

---

## 8. Frontend Changes

### 8.1 WebSocket event model

Current `PlanningAgentEvent` is replaced by raw ACP notifications forwarded by `AcpAgentManager`.

**New event types over WebSocket:**

```typescript
// Forwarded directly from ACP session/update notifications
type WsEvent =
  | { type: "acp:agent_message_chunk"; agentId: string; content: AcpContentBlock }
  | { type: "acp:tool_call"; agentId: string; toolCallId: string; title: string; kind: string; status: string; content?: AcpContentBlock[]; locations?: AcpLocation[] }
  | { type: "acp:tool_call_update"; agentId: string; toolCallId: string; status: string; content?: AcpContentBlock[]; locations?: AcpLocation[] }
  | { type: "acp:plan"; agentId: string; items: AcpPlanItem[] }
  | { type: "acp:turn_complete"; agentId: string; stopReason: string }
  | { type: "acp:error"; agentId: string; message: string }
  // Lifecycle events (harness-specific, not ACP)
  | { type: "agent:started"; agentId: string }
  | { type: "agent:stopped"; agentId: string }
  | { type: "agent:crashed"; agentId: string; message: string };
```

### 8.2 Frontend component changes

| Current | New |
|---|---|
| `delta` → append text | `acp:agent_message_chunk` → append text from content block |
| `tool_call` + `tool_result` → show tool activity | `acp:tool_call` → show tool with status badge; `acp:tool_call_update` → update status (pending→in_progress→completed/failed). Richer than before — shows progress, file locations |
| `thinking` → show thinking | `acp:agent_message_chunk` with thinking content type (if agent supports) |
| `message_complete` | `acp:turn_complete` with `stopReason` |
| `conversation_complete` | `acp:turn_complete` with `stopReason: "end_turn"` |
| (none) | `acp:plan` → new UI element showing agent's structured task plan |

### 8.3 Agent type indicator

Frontend should display which agent type is running (Pi, Gemini, Claude, Copilot, OpenCode). The backend includes `agentId` in all WS events, and the frontend can query `/api/agents/{id}` for metadata including agent type.

---

## 9. Configuration

### 9.1 Environment variables

```bash
# Agent type selection
AGENT_TYPE=gemini                           # pi | gemini | claude | copilot | opencode

# Model selection (same format as today)
AGENT_PLANNING_MODEL=gemini/gemini-2.5-pro
AGENT_IMPLEMENTATION_MODEL=gemini/gemini-2.5-flash

# Agent-specific auth (only the relevant ones needed)
GEMINI_API_KEY=...                          # for gemini
ANTHROPIC_API_KEY=...                       # for claude
COPILOT_GITHUB_TOKEN=...                    # for copilot
OPENCODE_API_KEY=...                        # for opencode
# Pi uses existing auth mechanisms (Copilot PAT, API keys, etc.)
```

### 9.2 Config.ts changes

```typescript
// New config fields
agentType: process.env.AGENT_TYPE ?? "pi",

// Image selection based on agent type
agentImage(role: "planning" | "implementation"): string {
  const type = config.agentType;
  return process.env[`${role.toUpperCase()}_AGENT_IMAGE`]
    ?? `multi-agent-harness/agent-${type}:latest`;
}
```

### 9.3 docker-compose.yml

Replace the single `planning-agent` and `sub-agent` services with per-type build targets:

```yaml
services:
  agent-pi:
    build:
      context: .
      dockerfile: agents/pi/Dockerfile
    image: multi-agent-harness/agent-pi:latest
    profiles: [build-only]

  agent-gemini:
    build:
      context: .
      dockerfile: agents/gemini/Dockerfile
    image: multi-agent-harness/agent-gemini:latest
    profiles: [build-only]

  agent-claude:
    build:
      context: .
      dockerfile: agents/claude/Dockerfile
    image: multi-agent-harness/agent-claude:latest
    profiles: [build-only]

  agent-copilot:
    build:
      context: .
      dockerfile: agents/copilot/Dockerfile
    image: multi-agent-harness/agent-copilot:latest
    profiles: [build-only]

  agent-opencode:
    build:
      context: .
      dockerfile: agents/opencode/Dockerfile
    image: multi-agent-harness/agent-opencode:latest
    profiles: [build-only]
```

---

## 10. Migration Path

### 10.1 Backward compatibility

During transition, the existing `PlanningAgentManager` and pi-coding-agent runners remain functional. The new `AcpAgentManager` is additive. `AGENT_TYPE=pi` with the new system uses pi-acp; omitting `AGENT_TYPE` falls back to the existing `PlanningAgentManager` code path.

### 10.2 Deprecation

Once all five agent types are validated, the old `PlanningAgentManager`, `planning-agent/runner.mjs`, `sub-agent/runner.mjs`, and their Dockerfiles are removed. The `planning-agent/` and `sub-agent/` directories are replaced by `agents/pi/`.

---

## 11. Testing Strategy

### 11.1 Unit tests

- `AcpAgentManager`: mock TCP socket, verify ACP handshake, event parsing, OTEL span creation
- Shared MCP server: verify each tool makes correct HTTP calls to backend API
- stdio→TCP bridge: verify bidirectional piping

### 11.2 Integration tests

- Per-agent: start container, connect ACP, send prompt, verify streaming events and tool calls
- Guard hook: verify blocked commands are rejected per-agent
- MCP tools: verify dispatch_tasks, get_task_status work through each CLI

### 11.3 E2E tests

- Full flow: create project → start planning agent → send prompt → dispatch tasks → sub-agent executes → PR created
- Run with at least 2 agent types (Pi + one other) to validate parity
