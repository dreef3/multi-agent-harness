# Multi-Agent CLI Integration Analysis

> Feasibility study for extending the harness beyond pi-coding-agent to support
> Gemini CLI, Copilot CLI, Claude Code, and OpenCode.

**Date:** 2026-04-02  
**Status:** Research / Analysis

---

## Table of Contents

1. [Current Architecture](#1-current-architecture)
2. [Target CLI Agents — Capability Matrix](#2-target-cli-agents--capability-matrix)
3. [Deep-Dive: Each CLI Agent](#3-deep-dive-each-cli-agent)
4. [Integration Protocols: ACP, A2A, MCP](#4-integration-protocols-acp-a2a-mcp)
5. [Integration Parity Assessment](#5-integration-parity-assessment)
6. [Architecture Options](#6-architecture-options)
7. [Recommendations](#7-recommendations)
8. [Appendix: Sources](#appendix-sources)

---

## 1. Current Architecture

### 1.1 How pi-coding-agent is integrated today

The harness wraps **pi-coding-agent SDK** (`@mariozechner/pi-coding-agent@0.61.1`) inside two Docker container types:

| Container | Role | Communication | Entrypoint |
|---|---|---|---|
| `planning-agent` | Orchestrates spec/plan/dispatch cycle | **TCP JSON-RPC** on port 3333 | `node /app/runner.mjs` |
| `sub-agent` | Implements a single task (clone → code → push) | **HTTP fire-and-forget** events to backend | `bun /app/runner.mjs` |

**Key integration surface (what must be replicated):**

| Capability | How it works today |
|---|---|
| **Session creation** | `createAgentSession()` — JS SDK call; returns a `session` object |
| **Prompt delivery** | Planning: `runRpcMode(session)` reads JSON-RPC from TCP stdin proxy; Sub-agent: `session.prompt(TASK_DESCRIPTION)` one-shot |
| **Streaming events** | Planning: JSON-RPC events over TCP (`message_update`, `tool_execution_start/end`, `turn_start/end`, `agent_start/end`); Sub-agent: `session.subscribe()` callback → HTTP POST to backend |
| **Custom tools** | JS objects with `name`, `parameters` (TypeBox schema), `execute` function — injected via `customTools` array |
| **Built-in tools** | `createCodingTools(workDir, { bash: { spawnHook } })` — file read/write/search, bash with guard hook |
| **Guard hook (security)** | `BashSpawnHook` blocks destructive commands (force push, `curl`, `gh api`, `.harness/` access); prepends `rtk` for token filtering |
| **Extensions** | `extensionFactories` array — currently `output-filter` (truncates large tool results) |
| **Auth/credentials** | Git credential store + `gh auth login` from token; Copilot PAT → `auth.json`; provider API keys via env vars |
| **OTEL** | Backend-side: `@opentelemetry/sdk-node` with OTLP HTTP exporter; planning agent manager creates spans for sessions, turns, tool calls; counters for tokens and tool call duration |
| **Model selection** | `AGENT_PLANNING_MODEL=provider/model` parsed in `config.ts`; `modelRegistry.find(provider, model)` |
| **Container lifecycle** | Docker API via `dockerode` through a socket proxy; `watchContainerExit`, idle timeout, graceful stop |
| **RTK (token filtering)** | Binary copied into container; bash spawn hook prepends `rtk` to all commands |
| **Skills** | Planning agent loads `superpowers` npm package; sub-agent runs with `noSkills: true` |

### 1.2 The coupling problem

The current architecture is **deeply coupled to pi-coding-agent's JS SDK**:
- `runner.mjs` directly imports `createAgentSession`, `runRpcMode`, `SessionManager`, `ModelRegistry`, etc.
- Custom tools are JS objects conforming to pi-coding-agent's tool interface
- Extensions use pi-coding-agent's extension API
- The TCP RPC bridge is built around pi-coding-agent's `runRpcMode` which hijacks `process.stdin`/`process.stdout`

Replacing the SDK means replacing the runner entirely — there is no abstraction layer between the harness and the agent runtime.

---

## 2. Target CLI Agents — Capability Matrix

| Capability | pi-coding-agent (current) | Gemini CLI | Claude Code | Copilot CLI | OpenCode |
|---|---|---|---|---|---|
| **Language** | JS/TS (npm) | JS/TS (npm) | JS/TS (npm binary) | Go (binary) | Go (binary) |
| **Headless / non-interactive** | SDK `runRpcMode` | `-p` flag, `--output-format json\|jsonl` | `-p` flag, `--output-format json\|stream-json` | `-p` flag | `opencode serve` (HTTP API) |
| **Structured I/O protocol** | Custom JSON-RPC over stdio | JSONL streaming, JSON, **ACP over stdio** (JSON-RPC 2.0) | stream-json (JSONL), JSON | **ACP over stdio or TCP** (JSON-RPC 2.0) | OpenAPI HTTP server, **ACP over stdio** (JSON-RPC 2.0) |
| **MCP support** | No (custom tool API) | Yes (stdio + SSE transports) | Yes (stdio + SSE) | Yes (stdio + SSE) | Yes (stdio + remote) |
| **Custom tools** | JS `customTools` array | MCP servers | MCP servers, hooks, skills | MCP servers | MCP servers, config-defined custom tools, plugins |
| **OTEL** | No (harness adds it) | Yes (built-in, configurable) | Yes (built-in, `OTEL_LOGS_EXPORTER`) | No built-in | No built-in |
| **Guard/security hooks** | `BashSpawnHook` | Extension hooks | Hooks system (`PreToolUse`, `PostToolUse`) | Permission request system via ACP | Plugin hooks |
| **Container/Docker** | Works in Docker | Works in Docker | Works in Docker (needs API key) | Works in Docker (needs GitHub auth) | Works in Docker |
| **SDK / programmatic API** | Full JS SDK | Headless CLI only (no SDK) | Python + TS SDK (subprocess-based) | `@github/copilot-sdk` (now ACP-based) | Go SDK, HTTP SDK |
| **Subprocess control** | Full (in-process) | `gemini -p "..." --output-format jsonl` | `claude -p "..." --output-format stream-json` | `copilot --acp --stdio` | `opencode serve` + HTTP client |
| **Session persistence** | JSONL session files | Built-in | Built-in (`--resume`) | ACP session management | Built-in |
| **ACP support** | No | **Yes (`gemini --acp`)** | **Yes (via [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp))** | **Yes (`copilot --acp`)** | **Yes (`opencode acp`)** |

---

## 3. Deep-Dive: Each CLI Agent

### 3.1 Gemini CLI

**Architecture:** Node.js/TypeScript open-source project ([google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)). Distributed via npm.

**Headless mode:**
- Triggered by non-TTY environment or `-p` / `--prompt` flag
- `--output-format json` returns single JSON with response + usage stats
- `--output-format jsonl` returns newline-delimited event stream
- `--non-interactive` prevents interactive prompts; `--yolo` auto-approves tool executions
- Supports stdin piping for context

**Extensibility:**
- Full MCP server support (stdio + SSE transports) via `.gemini/settings.json`
- Extension system packages prompts, MCP servers, and custom commands
- Extensions auto-loaded on startup

**OTEL:**
- Built-in OpenTelemetry with configurable backends
- Exports metrics (token usage, operation duration) and traces (tool interactions)
- Follows GenAI semantic conventions
- Configuration via `.gemini/settings.json` + env vars
- Pre-configured GCP monitoring dashboards available

**Docker integration:**
- Runs in Docker; needs `GEMINI_API_KEY` or Google Cloud auth
- No special requirements beyond standard Node.js environment

**ACP support:**
- `gemini --acp` starts Gemini CLI in ACP mode (JSON-RPC 2.0 over stdio)
- Client-server model: harness sends requests, Gemini processes and streams responses
- ACP client can expose MCP tools that Gemini's model can call
- Supported by Zed, JetBrains, Neovim, and other ACP-compliant editors

**Integration approach for harness:**
- **Preferred:** Start `gemini --acp` as subprocess or via TCP bridge — same pattern as Copilot CLI
- Alternative: `gemini -p "task" --output-format jsonl --non-interactive --yolo` for simpler one-shot use
- Custom tools via MCP sidecar server in same container
- OTEL can be configured natively — may reduce need for harness-side instrumentation

### 3.2 Claude Code

**Architecture:** Node.js/TypeScript, distributed as npm package (`@anthropic-ai/claude-code`). Also available as standalone binary.

**Headless mode:**
- `-p` / `--print` flag for non-interactive execution
- `--output-format json` for single JSON response
- `--output-format stream-json` for JSONL event stream
- `--input-format stream-json` for structured input
- `--include-partial-messages` and `--verbose` for detailed streaming

**SDK:**
- Python SDK (`claude-code-sdk`) and TypeScript SDK — both run CLI as subprocess
- Structured outputs, tool approval callbacks, native message objects
- Full access to Claude Code features (tools, file ops, agentic loop)

**Extensibility:**
- MCP servers (stdio + SSE) via `settings.json` or `CLAUDE.md`
- Hooks system: `PreToolUse`, `PostToolUse`, `UserPromptSubmit` — shell commands that run on events
- Skills system (plugin-like, loaded from filesystem)
- `CLAUDE.md` files for per-project configuration and instructions

**OTEL:**
- Built-in OpenTelemetry support via `OTEL_LOGS_EXPORTER`
- Exports events including tool calls, token usage, costs
- `OTEL_LOG_TOOL_DETAILS=1` to include tool arguments
- Third-party wrappers exist (claude-code-otel, claude_telemetry)

**Security:**
- Hooks can enforce policies (PreToolUse can block/allow/modify tool calls)
- Permission modes: `--allowedTools`, `--disallowedTools`
- `--dangerously-skip-permissions` for full auto-approve in containers

**Docker integration:**
- Works in Docker; needs `ANTHROPIC_API_KEY`
- No TTY required in headless mode

**ACP support:**
- Via [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) (npm package, v0.24.2)
- Bridges Claude Agent SDK to ACP (JSON-RPC 2.0 over stdio)
- Supports: context @-mentions, image input, tool execution with permissions, session management, MCP servers, slash commands, terminal access
- Actively maintained (72 releases as of March 2026)

**Integration approach for harness:**
- **Preferred:** Use `claude-agent-acp` as ACP subprocess — unified ACP pattern with all other agents
- Alternative: TS SDK or direct subprocess `claude -p "task" --output-format stream-json --dangerously-skip-permissions`
- Custom tools via MCP sidecar or hooks
- Built-in OTEL reduces harness instrumentation burden
- `CLAUDE.md` in workspace root provides per-task instructions (equivalent to system prompt)

### 3.3 Copilot CLI

**Architecture:** Go binary, distributed via GitHub releases. Generally available as of Feb 2026.

**Headless mode:**
- `-p` / `--prompt` flag for non-interactive execution
- `--allow-all-tools` for auto-approve in scripts

**ACP (Agent Client Protocol):**
- **Native ACP support** via `copilot --acp` (stdio or TCP)
- JSON-RPC 2.0 based protocol
- Methods: `initialize`, `session/new`, `session/prompt`, permission requests, streaming updates
- TCP mode: `copilot --acp --port 8080`
- Replaced the earlier `--headless --stdio` interface (breaking change in v0.0.410+)
- Device code flow (RFC 8628) for OAuth in headless/CI environments

**Extensibility:**
- Full MCP server support (stdio + SSE)
- Plugin architecture
- Tools discoverable via MCP standard

**OTEL:**
- No built-in OTEL; would need harness-side instrumentation

**Docker integration:**
- Works in Docker; needs GitHub authentication (token or device flow)
- Binary distribution simplifies container builds

**Integration approach for harness:**
- **ACP is the most promising integration path** — it's a standardized protocol
- Start `copilot --acp --port 3333` in container, connect via TCP
- JSON-RPC 2.0 message flow maps closely to current planning agent TCP bridge
- Permission requests can be auto-approved or routed through harness
- Custom tools via MCP sidecar
- OTEL must be added by harness (intercept ACP events)

### 3.4 OpenCode

**Architecture:** Go binary, open-source ([opencode-ai/opencode](https://github.com/opencode-ai/opencode)). Supports 75+ LLM providers.

**Headless mode:**
- `opencode serve` starts HTTP server with OpenAPI spec
- HTTP basic auth via `OPENCODE_SERVER_PASSWORD`
- `opencode attach` connects to running server (avoids MCP cold boot)
- Full REST API for programmatic access

**Extensibility:**
- MCP servers (local + remote)
- Custom tools defined in config file (arbitrary code execution)
- Plugin system: JS/TS files auto-loaded from plugin directory
- Rules system (like CLAUDE.md)

**OTEL:**
- No built-in OTEL; would need harness-side instrumentation

**Docker integration:**
- Works in Docker; configure API keys for chosen provider
- Go binary — small container footprint

**ACP support:**
- `opencode acp` starts OpenCode as an ACP-compatible subprocess (JSON-RPC 2.0 over stdio)
- All built-in tools, custom tools, MCP servers, rules, agents, and permissions flow through ACP
- Limitation: some built-in slash commands (`/undo`, `/redo`) are currently unsupported via ACP
- Supported by Zed, JetBrains, Neovim (Avante.nvim, CodeCompanion.nvim)

**Integration approach for harness:**
- **Preferred:** Start `opencode acp` as subprocess or via TCP bridge — unified ACP pattern
- Alternative: `opencode serve` for HTTP API access (useful for web-based integrations)
- Custom tools via MCP sidecar or config-defined tools
- OTEL must be added by harness (intercept ACP/HTTP events)
- Plugin hooks for security enforcement

---

## 4. Integration Protocols: ACP, A2A, MCP

### 4.1 ACP (Agent Client Protocol) — the emerging universal standard

Not to be confused with IBM's Agent Communication Protocol (same acronym, different project).

- **What:** JSON-RPC 2.0 protocol for client ↔ agent communication, often described as "the LSP for AI coding agents"
- **Spec:** [agentclientprotocol.com](https://agentclientprotocol.com)
- **Transport:** stdio (primary) or TCP
- **Key methods:** `initialize`, `session/new`, `session/prompt`, streaming events, permission requests
- **Adopted by all four target agents:**
  - Gemini CLI: `gemini --acp` (native)
  - Copilot CLI: `copilot --acp` (native, stdio or TCP)
  - OpenCode: `opencode acp` (native)
  - Claude Code: via [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) adapter (npm, actively maintained)
- **Also adopted by:** JetBrains AI, Zed, Kiro, Cline, goose, Codex CLI, and 19+ other tools
- **Relevance:** This is the **closest match** to the current pi-coding-agent TCP RPC pattern, and is now **the universal solution** for all target agents

### 4.2 A2A (Agent-to-Agent Protocol) — Google/Linux Foundation

- **What:** Open protocol for agent-to-agent communication and orchestration
- **Status:** Donated to Linux Foundation by Google; merged with IBM's ACP (Agent Communication Protocol) in August 2025
- **Transport:** REST/HTTP-based with well-defined endpoints
- **Key concepts:** Agent Cards (discovery), Tasks (lifecycle), Messages (communication), Artifacts (outputs)
- **Supported by:** 100+ technology companies
- **Relevance:** Designed for multi-agent orchestration — maps well to planning→sub-agent delegation pattern. However, **no CLI agent natively speaks A2A today**; would require writing A2A wrappers around each CLI

### 4.3 MCP (Model Context Protocol) — Anthropic

- **What:** Protocol for exposing tools, resources, and prompts to LLM agents
- **Status:** De facto standard for tool integration; supported by all target CLI agents
- **Transport:** stdio (local) or SSE (remote)
- **Relevance:** **The universal common denominator.** Every target agent supports MCP for tool registration. The harness's custom tools (`ask_planning_agent`, `dispatch_tasks`, `web_fetch`, etc.) can be exposed as MCP servers to any agent

### 4.4 Can ACP/A2A be "the solution"?

**ACP (Agent Client Protocol):**
- Pros: Implemented by **all four target agents** (Gemini CLI native, Copilot CLI native, OpenCode native, Claude Code via adapter); JSON-RPC 2.0 maps 1:1 to current TCP bridge; session/prompt model matches planning agent pattern; growing industry adoption (20+ tools); ACP clients can expose MCP tools to agents
- Cons: Claude Code requires an adapter package (not native); protocol still maturing (spec may evolve); permission request model may need customization for harness security policies
- Verdict: **Yes — ACP is the universal solution.** The harness should standardize on ACP as the agent communication protocol, replacing the current pi-coding-agent-specific TCP RPC bridge

**A2A (Google/Linux Foundation):**
- Pros: Designed for exactly this problem (multi-agent orchestration); REST-based (easy to implement); growing ecosystem
- Cons: No CLI agent speaks it natively; adding A2A wrappers adds a full protocol layer; current harness doesn't need discovery/negotiation (agents are known)
- Verdict: **Overkill for current needs.** The harness orchestrates known, trusted agents in containers it controls. A2A adds value when agents are opaque, untrusted, or discovered dynamically. Worth watching for future enterprise scenarios.

**MCP:**
- Pros: Universal tool support; every target agent supports it; well-suited for exposing harness capabilities (dispatch_tasks, planning docs, etc.) to agents
- Cons: MCP is for tool integration, not session/prompt management; doesn't solve the "how to start/stop/stream from an agent" problem
- Verdict: **Essential complement, not a standalone solution.** Use MCP for tool exposure; use agent-specific mechanisms for lifecycle/streaming.

---

## 5. Integration Parity Assessment

What can and cannot be replicated per agent:

| Feature | pi-coding (current) | Gemini CLI | Claude Code | Copilot CLI | OpenCode |
|---|---|---|---|---|---|
| **One-shot task execution** | Full | Full | Full | Full | Full |
| **Streaming text deltas** | Full | Full (JSONL) | Full (stream-json) | Full (ACP) | Partial (HTTP polling) |
| **Streaming tool call events** | Full | Full (JSONL) | Full (stream-json) | Full (ACP) | Partial (HTTP) |
| **Custom tools (harness-specific)** | Full (JS API) | Via MCP sidecar | Via MCP sidecar | Via MCP sidecar | Via MCP sidecar or config |
| **Guard hook (command blocking)** | Full (BashSpawnHook) | Via extension hooks | Via PreToolUse hooks | Via ACP permission requests | Via plugin hooks |
| **RTK (token filtering)** | Full (prepend to bash) | Needs custom solution | Needs custom solution | Needs custom solution | Needs custom solution |
| **OTEL (harness-side spans)** | Full | Reduced need (built-in) | Reduced need (built-in) | Must add harness-side | Must add harness-side |
| **OTEL (token metrics)** | Full | Native | Native | Must extract from events | Must extract from events |
| **Session persistence** | Full (JSONL) | Built-in | Built-in | ACP session management | Built-in |
| **Multi-turn conversation** | Full (RPC) | Requires session re-use | `--resume` flag or SDK | ACP sessions | HTTP server sessions |
| **System prompt injection** | resourceLoader.systemPrompt | `.gemini/GEMINI.md` | `CLAUDE.md` in workspace | Copilot instructions file | Rules files |
| **Model selection** | ModelRegistry.find() | `--model` flag | `--model` flag | GitHub-managed | Config file |
| **Skills/superpowers** | npm package in container | Extensions system | Skills system | N/A | Plugins |
| **ask_planning_agent tool** | Custom JS tool | MCP server | MCP server | MCP server | MCP server or custom tool |

### Key gaps:

1. **RTK (token filtering):** Currently works by prepending `rtk` to bash commands via spawn hook. Other CLIs control their own bash execution — injecting RTK requires either:
   - Modifying `PATH` so `rtk` wraps common commands (less reliable)
   - Running an MCP-based "bash" tool that routes through RTK (replaces built-in bash)
   - Accepting that built-in OTEL in Gemini/Claude already reduces the need for RTK

2. **Guard hooks:** Each agent has its own mechanism. No universal approach — must implement per-agent.

3. **Multi-turn planning sessions:** All four target agents support multi-turn sessions via ACP's `session/new` + `session/prompt` lifecycle. This is a significant improvement over the headless-only approach (which would require `--resume` flags or conversation IDs).

---

## 6. Architecture Options

### Option A: Agent-specific runners (current pattern, extended)

Write a `runner.mjs` (or equivalent) for each agent that:
1. Handles auth/credential setup
2. Starts the agent in headless mode
3. Parses its output format (JSONL, stream-json, ACP, HTTP)
4. Translates events to the harness's common event format
5. Runs an MCP sidecar for custom tools
6. Manages the commit/push lifecycle

```
┌─────────────────────────────────────┐
│ Container (per agent type)          │
│  ┌──────────────┐  ┌────────────┐  │
│  │  CLI Agent    │──│ MCP Sidecar│  │
│  │ (gemini/     │  │ (custom    │  │
│  │  claude/     │  │  tools)    │  │
│  │  copilot/    │  └────────────┘  │
│  │  opencode)   │                   │
│  └──────┬───────┘                   │
│         │ stdout (JSONL/ACP/HTTP)   │
│  ┌──────┴───────┐                   │
│  │  Runner      │──→ TCP/HTTP → Backend
│  │ (translator) │                   │
│  └──────────────┘                   │
└─────────────────────────────────────┘
```

**Pros:**
- Incremental — add one agent at a time without changing existing code
- Full control over each agent's quirks
- Each runner is small (~200-400 lines)

**Cons:**
- N runners to maintain
- Custom tools duplicated as MCP servers (but this is a one-time effort)
- Testing matrix grows linearly

### Option B: Unified ACP bridge

Standardize on ACP (JSON-RPC 2.0) as the harness ↔ agent protocol. Write thin ACP adapters for non-ACP agents.

```
┌─────────────────────────────────────┐
│ Container                           │
│  ┌──────────────┐  ┌────────────┐  │
│  │  CLI Agent    │──│ MCP Sidecar│  │
│  └──────┬───────┘  └────────────┘  │
│         │                           │
│  ┌──────┴───────┐                   │
│  │ ACP Adapter  │ (for non-ACP      │
│  │ (translate   │  agents: gemini,  │
│  │  JSONL/HTTP  │  claude, opencode)│
│  │  → ACP)      │                   │
│  └──────┬───────┘                   │
│         │ ACP (JSON-RPC 2.0 / TCP)  │
└─────────┼───────────────────────────┘
          │
    ┌─────┴──────┐
    │  Backend   │  (single ACP client)
    │ (unified   │
    │  handler)  │
    └────────────┘
```

**Pros:**
- Backend only speaks one protocol
- Adding new agents = minimal config (all targets already support ACP)
- Copilot CLI, Gemini CLI, OpenCode: native ACP — zero adapter code
- Claude Code: well-maintained ACP adapter (`claude-agent-acp`, 72 releases)
- ACP has strong industry traction (20+ tools, backed by Zed/JetBrains/GitHub)
- JSON-RPC 2.0 maps almost directly to current TCP bridge code in `planningAgentManager.ts`

**Cons:**
- ACP spec may evolve (though convergence is happening)
- Claude Code requires adapter package (additional dependency)
- Permission request model may need harness-specific handling

### Option C: MCP-first architecture (tool-centric)

Flip the model: instead of the harness controlling agents via protocol, expose harness capabilities as MCP servers that any agent can consume. The agent becomes the "driver" — it calls harness tools when needed.

```
┌─────────────────────────────────────┐
│ Container                           │
│  ┌──────────────┐                   │
│  │  CLI Agent    │                  │
│  │  (any)       │                   │
│  └──┬────┬──────┘                   │
│     │    │                          │
│  ┌──┴──┐ ┌┴─────────┐              │
│  │MCP: │ │MCP:       │              │
│  │guard│ │harness-api│              │
│  │hook │ │(dispatch, │              │
│  └─────┘ │planning,  │              │
│          │status)    │              │
│          └─────┬─────┘              │
│                │ HTTP                │
└────────────────┼────────────────────┘
                 │
           ┌─────┴──────┐
           │  Backend   │
           └────────────┘
```

**Pros:**
- MCP is universally supported — zero protocol translation
- Agent-agnostic by design
- Custom tools written once as MCP servers, consumed by any agent
- Guard hook can be an MCP tool that wraps bash execution

**Cons:**
- Loses direct streaming control (agent decides when/how to stream)
- Multi-turn conversation management must be agent-native
- Harness becomes more passive (can't inject prompts mid-session as easily)
- Planning agent pattern (TCP RPC for interactive use) doesn't fit as well

### Recommended: Option B — Unified ACP bridge + MCP tools

With all four target agents supporting ACP, the unified bridge approach is now clearly the best path:

1. **Standardize on ACP** (JSON-RPC 2.0) as the harness ↔ agent protocol, replacing the pi-coding-agent-specific TCP RPC bridge
2. **Extract custom tools into MCP servers** that any ACP agent can consume (ACP clients can expose MCP tools to agents)
3. **Write one `AcpAgentManager`** that replaces `PlanningAgentManager` — same TCP bridge pattern, but speaking standard ACP instead of pi-coding-agent's custom RPC
4. **Use native OTEL** where available (Gemini CLI, Claude Code) and harness-side OTEL where not (Copilot CLI, OpenCode)
5. **Container images differ only in the agent binary** — the runner logic is the same ACP subprocess start

This eliminates per-agent runner code almost entirely. The harness becomes agent-agnostic.

---

## 7. Recommendations

### 7.1 Priority order for agent integration

| Priority | Agent | Rationale |
|---|---|---|
| 1 | **Claude Code** | Best headless mode (`stream-json`), TS SDK, built-in OTEL, MCP, hooks, `CLAUDE.md` for system prompts. Closest feature parity to pi-coding-agent |
| 2 | **Gemini CLI** | Excellent headless JSONL streaming, built-in OTEL, MCP, extensions. Already have `.env.google-gemini-cli` |
| 3 | **Copilot CLI** | Native ACP is compelling but auth is complex (GitHub-only, device flow). MCP support is mature |
| 4 | **OpenCode** | HTTP server mode is unique advantage; Go binary is lightweight. Good for niche provider access (75+ providers) |

### 7.2 Implementation roadmap

**Phase 1 — Extract MCP tool servers (shared foundation)**
- Convert `ask_planning_agent`, `dispatch_tasks`, `get_task_status`, `get_pull_requests`, `write_planning_document`, `reply_to_subagent`, `web_fetch` into MCP server(s)
- Create `harness-guard` MCP tool that wraps bash execution with blocked command patterns
- Package as a container sidecar or in-process MCP server
- **Effort:** ~2-3 days. This unblocks all future agents.

**Phase 2 — AcpAgentManager (unified ACP bridge)**
- Define `AcpAgentManager` that replaces `PlanningAgentManager`'s pi-coding-specific RPC handling with standard ACP JSON-RPC 2.0
- Reuse the existing TCP bridge pattern (connect to container on port 3333, parse newline-delimited JSON-RPC)
- Map ACP events to the existing `PlanningAgentEvent` type (or a superset `HarnessEvent`)
- Handle ACP permission requests: auto-approve or route through harness policy
- Create `Dockerfile.base` with common foundation (git, gh, rtk, MCP sidecar)
- **Effort:** ~3-4 days

**Phase 3 — First ACP agent: Gemini CLI or Copilot CLI**
- Pick one native ACP agent (no adapter needed) as the first integration
- Dockerfile: `FROM harness-base` + install agent binary + configure ACP mode
- Container entrypoint: agent binary in ACP mode, listening on TCP 3333 (or stdio bridged to TCP)
- MCP server from Phase 1 provides custom tools
- System prompt via agent-native config (`GEMINI.md` or Copilot instructions)
- Validate: streaming, tool calls, OTEL, guard hooks all work through ACP
- **Effort:** ~2-3 days

**Phase 4 — Claude Code via ACP adapter**
- Install `@agentclientprotocol/claude-agent-acp` in container
- Same ACP bridge — `AcpAgentManager` works unchanged
- `CLAUDE.md` in workspace for system prompt
- Built-in OTEL configured via env vars
- **Effort:** ~2 days

**Phase 5 — Remaining agents (OpenCode + whichever wasn't done in Phase 3)**
- OpenCode: `opencode acp` — native ACP, same bridge
- Copilot or Gemini (whichever remains): same pattern
- **Effort:** ~1-2 days each (ACP infrastructure already proven)

**Phase 6 — Retire pi-coding-agent runner (optional)**
- If pi-coding-agent adds ACP support, migrate it to the unified bridge
- Otherwise keep the existing runner as a legacy path
- **Effort:** ~1 day if ACP support lands; 0 if kept as-is

### 7.3 What ACP/A2A mean for the future

- **Now:** ACP is supported by all four target agents. It is the clear integration standard for CLI coding agents. The harness should adopt it immediately.
- **Medium term (6-12 months):** ACP ecosystem will mature. Expect better tooling, SDKs, and possibly a formal spec versioning process. The harness benefits from early adoption — less migration work later.
- **Long term (12+ months):** A2A may become the standard for multi-agent orchestration in enterprise settings. The harness's planning→sub-agent pattern maps well to A2A's task delegation model. Consider A2A when the harness needs to integrate with external agent systems (not just CLI agents it controls). ACP and A2A are complementary: ACP for client↔agent, A2A for agent↔agent.

### 7.4 What cannot achieve parity

| Feature | Limitation |
|---|---|
| **In-process extension API** | Only pi-coding-agent supports this. Other agents: use MCP or hooks instead |
| **BashSpawnHook (exact current behavior)** | Only pi-coding-agent has this. Others: MCP bash wrapper or agent-native hooks |
| **RTK token filtering** | Requires wrapping bash. Partially solved by `PATH` manipulation; better solved by accepting native OTEL replaces the need |
| **Model registry (multi-provider from single agent)** | pi-coding-agent's `ModelRegistry` supports many providers. Others are typically single-provider (Gemini → Google, Copilot → GitHub). OpenCode is the exception (75+ providers) |
| **Session log commit to repo** | Currently reads pi-agent JSONL directly. Other agents have their own session formats — need format-specific extraction |

---

## Appendix: Sources

### Gemini CLI
- [Headless mode reference](https://geminicli.com/docs/cli/headless/)
- [MCP servers](https://geminicli.com/docs/tools/mcp-server/)
- [Extensions](https://google-gemini.github.io/gemini-cli/docs/extensions/)
- [Observability with OpenTelemetry](https://geminicli.com/docs/cli/telemetry/)
- [Automate tasks with headless mode](https://geminicli.com/docs/cli/tutorials/automation/)

### Claude Code
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Agent SDK reference - Python](https://platform.claude.com/docs/en/agent-sdk/python)
- [Monitoring](https://code.claude.com/docs/en/monitoring-usage)
- [claude-code-otel](https://github.com/ColeMurray/claude-code-otel)

### Copilot CLI
- [About GitHub Copilot CLI](https://docs.github.com/copilot/concepts/agents/about-copilot-cli)
- [ACP support in Copilot CLI](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/)
- [Copilot CLI ACP server reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- [Adding MCP servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
- [Breaking change: --headless --stdio removed](https://github.com/github/copilot-cli/issues/1606)

### OpenCode
- [Server mode](https://opencode.ai/docs/server/)
- [CLI reference](https://opencode.ai/docs/cli/)
- [Custom tools](https://opencode.ai/docs/custom-tools/)
- [MCP servers](https://opencode.ai/docs/mcp-servers/)
- [Plugins](https://opencode.ai/docs/plugins/)
- [SDK](https://opencode.ai/docs/sdk/)

### ACP (Agent Client Protocol)
- [Agent Client Protocol spec](https://agentclientprotocol.com)
- [ACP: The LSP for AI Coding Agents](https://blog.promptlayer.com/agent-client-protocol-the-lsp-for-ai-coding-agents/)
- [Gemini CLI ACP Mode](https://geminicli.com/docs/cli/acp-mode/)
- [OpenCode ACP docs](https://opencode.ai/docs/acp/)
- [claude-agent-acp adapter](https://github.com/agentclientprotocol/claude-agent-acp)
- [Zed: Bring Your Own Agent](https://zed.dev/blog/bring-your-own-agent-to-zed)
- [ACP progress report](https://zed.dev/blog/acp-progress-report)

### Protocols (A2A / IBM ACP)
- [ACP (IBM/BeeAI) — GitHub](https://github.com/i-am-bee/acp)
- [A2A Protocol](https://a2a-protocol.org/latest/)
- [Linux Foundation A2A announcement](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)
- [AI Agent Protocol Ecosystem Map 2026](https://www.digitalapplied.com/blog/ai-agent-protocol-ecosystem-map-2026-mcp-a2a-acp-ucp)
- [MCP vs A2A vs ACP guide](http://jitendrazaa.com/blog/ai/mcp-vs-a2a-vs-acp-vs-anp-complete-ai-agent-protocol-guide/)
