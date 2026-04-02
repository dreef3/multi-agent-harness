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
| **Structured I/O protocol** | Custom JSON-RPC over stdio | JSONL streaming, JSON single-shot | stream-json (JSONL), JSON | **ACP over stdio or TCP** (JSON-RPC 2.0) | OpenAPI HTTP server |
| **MCP support** | No (custom tool API) | Yes (stdio + SSE transports) | Yes (stdio + SSE) | Yes (stdio + SSE) | Yes (stdio + remote) |
| **Custom tools** | JS `customTools` array | MCP servers | MCP servers, hooks, skills | MCP servers | MCP servers, config-defined custom tools, plugins |
| **OTEL** | No (harness adds it) | Yes (built-in, configurable) | Yes (built-in, `OTEL_LOGS_EXPORTER`) | No built-in | No built-in |
| **Guard/security hooks** | `BashSpawnHook` | Extension hooks | Hooks system (`PreToolUse`, `PostToolUse`) | Permission request system via ACP | Plugin hooks |
| **Container/Docker** | Works in Docker | Works in Docker | Works in Docker (needs API key) | Works in Docker (needs GitHub auth) | Works in Docker |
| **SDK / programmatic API** | Full JS SDK | Headless CLI only (no SDK) | Python + TS SDK (subprocess-based) | `@github/copilot-sdk` (now ACP-based) | Go SDK, HTTP SDK |
| **Subprocess control** | Full (in-process) | `gemini -p "..." --output-format jsonl` | `claude -p "..." --output-format stream-json` | `copilot --acp --stdio` | `opencode serve` + HTTP client |
| **Session persistence** | JSONL session files | Built-in | Built-in (`--resume`) | ACP session management | Built-in |
| **ACP support** | No | No | No | **Yes (native)** | No |

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

**Integration approach for harness:**
- Spawn as subprocess: `gemini -p "task" --output-format jsonl --non-interactive --yolo`
- Parse JSONL stream for events (tool calls, text deltas, completion)
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

**Integration approach for harness:**
- Run via TS SDK or direct subprocess: `claude -p "task" --output-format stream-json --dangerously-skip-permissions`
- Parse stream-json events for real-time activity
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

**Integration approach for harness:**
- Run `opencode serve` in container, communicate via HTTP API
- OpenAPI spec enables strongly-typed client generation
- Custom tools via MCP sidecar or config-defined tools
- OTEL must be added by harness (intercept HTTP events)
- Plugin hooks for security enforcement

---

## 4. Integration Protocols: ACP, A2A, MCP

### 4.1 ACP (Agent Client Protocol) — JetBrains/GitHub flavor

Not to be confused with IBM's Agent Communication Protocol (same acronym).

- **What:** JSON-RPC 2.0 protocol for IDE/client ↔ agent communication
- **Adopted by:** GitHub Copilot CLI (`copilot --acp`), JetBrains AI Assistant, Kiro, Cline, and 19+ other tools
- **Transport:** stdio or TCP
- **Key methods:** `initialize`, `session/new`, `session/prompt`, streaming events, permission requests
- **Relevance:** This is the **closest match** to the current pi-coding-agent TCP RPC pattern

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

**ACP (JetBrains/GitHub flavor):**
- Pros: Already implemented by Copilot CLI; JSON-RPC 2.0 maps 1:1 to current TCP bridge; session/prompt model matches planning agent pattern
- Cons: Only Copilot CLI supports it natively; Gemini CLI, Claude Code, and OpenCode do not speak ACP
- Verdict: **Good for Copilot CLI specifically, not a universal solution**

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

3. **Multi-turn planning sessions:** Only pi-coding-agent and Copilot CLI (ACP) natively support long-lived multi-turn sessions over a protocol. Gemini CLI and Claude Code require repeated subprocess invocations with `--resume` or conversation IDs. OpenCode's HTTP server supports persistent sessions.

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
- Adding new agents = writing a small adapter
- Copilot CLI needs no adapter (native ACP)
- ACP is gaining industry traction

**Cons:**
- Adapter layer adds complexity and latency
- Mapping non-ACP semantics to ACP may lose information
- ACP spec may evolve (it's still maturing outside of Copilot)

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

### Recommended: Option A + MCP tools (pragmatic hybrid)

1. **Keep agent-specific runners** for lifecycle management (start, stream, stop, commit/push)
2. **Extract custom tools into MCP servers** that work with any agent
3. **Use native OTEL** where available (Gemini CLI, Claude Code) and harness-side OTEL where not (Copilot CLI, OpenCode)
4. **Standardize the event translation layer** — define a common `HarnessEvent` type and implement a translator per agent output format

This gives the best incremental migration path while converging toward a common tool layer.

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

**Phase 2 — Generic runner framework**
- Define `HarnessEvent` interface (superset of current `PlanningAgentEvent`)
- Create `AgentRunner` abstraction with methods: `start()`, `sendPrompt()`, `onEvent()`, `stop()`
- Implement `PiCodingAgentRunner` first (refactor existing code)
- Create `Dockerfile.template` with common base (git, gh, rtk) + agent-specific layers
- **Effort:** ~3-4 days

**Phase 3 — Claude Code runner**
- Install `claude` CLI in container
- Runner spawns `claude -p "task" --output-format stream-json --dangerously-skip-permissions`
- Parse stream-json events → `HarnessEvent`
- `CLAUDE.md` in workspace replaces system prompt
- MCP server from Phase 1 provides custom tools
- Configure OTEL via env vars (`OTEL_LOGS_EXPORTER=otlp`)
- **Effort:** ~2-3 days

**Phase 4 — Gemini CLI runner**
- Install `gemini` CLI in container
- Runner spawns `gemini -p "task" --output-format jsonl --non-interactive --yolo`
- Parse JSONL events → `HarnessEvent`
- `GEMINI.md` in workspace for instructions
- MCP server from Phase 1 provides custom tools
- Configure OTEL via `.gemini/settings.json`
- **Effort:** ~2-3 days

**Phase 5 — Copilot CLI runner (ACP)**
- Install `copilot` binary in container
- Runner connects via ACP TCP (`copilot --acp --port 3333`)
- ACP JSON-RPC maps almost directly to existing TCP bridge code
- MCP server from Phase 1 provides custom tools
- Auth: device flow or PAT injection
- **Effort:** ~3-4 days (auth complexity)

**Phase 6 — OpenCode runner**
- Install `opencode` binary in container
- Runner starts `opencode serve` and communicates via HTTP API
- Parse HTTP responses → `HarnessEvent`
- MCP server from Phase 1 provides custom tools
- **Effort:** ~2-3 days

### 7.3 What ACP/A2A mean for the future

- **Short term (now):** ACP is only relevant for Copilot CLI. Not a universal solution.
- **Medium term (6-12 months):** If more CLI agents adopt ACP (plausible given industry momentum), Option B becomes viable. Monitor adoption.
- **Long term (12+ months):** A2A may become the standard for multi-agent orchestration in enterprise settings. The harness's planning→sub-agent pattern maps well to A2A's task delegation model. Consider A2A when the harness needs to integrate with external agent systems (not just CLI agents it controls).

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

### Protocols
- [ACP (IBM/BeeAI) — GitHub](https://github.com/i-am-bee/acp)
- [A2A Protocol](https://a2a-protocol.org/latest/)
- [Linux Foundation A2A announcement](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)
- [AI Agent Protocol Ecosystem Map 2026](https://www.digitalapplied.com/blog/ai-agent-protocol-ecosystem-map-2026-mcp-a2a-acp-ucp)
- [MCP vs A2A vs ACP guide](http://jitendrazaa.com/blog/ai/mcp-vs-a2a-vs-acp-vs-anp-complete-ai-agent-protocol-guide/)
