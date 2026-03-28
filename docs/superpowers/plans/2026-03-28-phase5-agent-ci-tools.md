# Agent CI Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose `get_build_status` and `get_build_logs` CI tools to the planning agent by documenting them in the system prompt and injecting the CI tool descriptions into the master agent context at startup.

**Architecture:** The harness backend already has `GET /api/pull-requests/:id/build-status` and `GET /api/pull-requests/:id/build-logs/:buildId` endpoints (from the VCS CI Extensions plan). The planning agent calls the harness via its `WebFetch` tool using `HARNESS_API_URL`. A new `ciTools.ts` module defines the CI tool description string, which is injected into `buildMasterAgentContext()` in `backend/src/api/websocket.ts`. The planning agent's `system-prompt.md` is also updated to document these tools so the agent knows when and how to use them.

**Tech Stack:** TypeScript, Express, planning-agent system prompt (Markdown), `HARNESS_API_URL` environment variable, WebFetch tool (already available in planning-agent runner).

---

## Prerequisites

- [ ] Confirm VCS CI Extensions plan is implemented: `GET /api/pull-requests/:id/build-status` and `GET /api/pull-requests/:id/build-logs/:buildId` endpoints exist
- [ ] Read `backend/src/api/websocket.ts` to find `buildMasterAgentContext()` or equivalent function that assembles the planning agent's initial context
- [ ] Read `planning-agent/system-prompt.md` to understand existing tool documentation style
- [ ] Confirm `planning-agent/runner.mjs` creates a `WebFetch` tool via `createWebFetchTool` or equivalent
- [ ] Confirm `HARNESS_API_URL` is available in the planning agent container environment

---

## Task 1 — Create `backend/src/agents/ciTools.ts`

- [ ] Create directory `backend/src/agents/` if it does not exist
- [ ] Create `backend/src/agents/ciTools.ts`:

```typescript
/**
 * CI tool descriptions injected into the planning agent's system context.
 *
 * These tools are available via the harness backend HTTP API.
 * The planning agent calls them using its WebFetch tool.
 */

/**
 * Build the CI tools section for the master agent context.
 * @param harnessApiUrl - The base URL of the harness backend (e.g. http://localhost:3000)
 */
export function buildCiToolsDescription(harnessApiUrl: string): string {
  return `
## CI Integration Tools

You have access to CI build status and logs via the harness backend API.
Use these tools to verify implementation quality before approving PRs.

---

### get_build_status

Fetch the CI build status for a pull request's source branch.

**Request:**
\`\`\`
GET ${harnessApiUrl}/api/pull-requests/{pullRequestId}/build-status
\`\`\`

**Response:**
\`\`\`json
{
  "state": "success" | "failure" | "pending" | "unknown",
  "checks": [
    {
      "name": "CI / test-backend",
      "status": "success" | "failure" | "pending" | "skipped",
      "url": "https://github.com/...",
      "buildId": "12345678",
      "startedAt": "2026-03-28T10:00:00Z",
      "completedAt": "2026-03-28T10:05:00Z"
    }
  ]
}
\`\`\`

**When to use:**
- After a sub-agent completes a task and opens a PR, check CI status before approving the PR
- If \`state\` is \`"failure"\`, read the logs and decide whether to re-dispatch a fix
- If \`state\` is \`"pending"\`, wait 60 seconds and poll again (up to 10 minutes)
- If \`state\` is \`"unknown"\` with empty \`checks\`, CI is not configured — treat as passing

---

### get_build_logs

Fetch the raw logs for a specific CI check run.

**Request:**
\`\`\`
GET ${harnessApiUrl}/api/pull-requests/{pullRequestId}/build-logs/{buildId}
\`\`\`

Use the \`buildId\` field from a failing check in the \`get_build_status\` response.

**Response:**
\`\`\`json
{
  "logs": "...raw log text or URL..."
}
\`\`\`

**When to use:**
- When \`get_build_status\` returns \`state: "failure"\`, fetch logs for each failing check
- Analyze the logs to understand what went wrong
- Include the relevant error excerpt in the dispatch message when re-running the sub-agent
- Do not fetch logs for successful checks — this wastes API quota

---

### Workflow example

\`\`\`
1. Sub-agent completes and opens PR #42
2. Call: GET ${harnessApiUrl}/api/pull-requests/42/build-status
3. If state == "pending": wait 60s, retry up to 10 times
4. If state == "failure":
   a. Identify failing checks (status == "failure")
   b. For each: GET ${harnessApiUrl}/api/pull-requests/42/build-logs/{buildId}
   c. Extract error message from logs
   d. Re-dispatch sub-agent with context: "CI failed with: <error>"
5. If state == "success": proceed to PR approval
\`\`\`
`;
}
```

- [ ] Run `bunx tsc --noEmit` from `backend/` to confirm the module compiles

---

## Task 2 — Inject CI tools into `buildMasterAgentContext()`

- [ ] Open `backend/src/api/websocket.ts`
- [ ] Find the function that assembles the planning agent's initial system context (likely named `buildMasterAgentContext`, `buildSystemPrompt`, or similar — search for where the agent's initial message/context is assembled)
- [ ] Import the CI tools builder:

```typescript
import { buildCiToolsDescription } from "../agents/ciTools";
```

- [ ] In `buildMasterAgentContext()` (or equivalent), add the CI tools section:

```typescript
import { config } from "../config.js";  // already imported in websocket.ts

function buildMasterAgentContext(project: Project, repos: Repository[]): string {
  // config.harnessApiUrl defaults to "http://backend:3000" — the URL the
  // planning-agent container uses to reach the backend over the Docker network.
  const harnessApiUrl = config.harnessApiUrl;

  return `
## Your Role
You are the planning agent for project "${project.name}".
...

${buildCiToolsDescription(harnessApiUrl)}

## Repositories
${repos.map(r => `- ${r.name}: ${r.cloneUrl}`).join("\n")}
...
`;
}
```

If the context is assembled differently (e.g. loaded from a file), find the correct injection point and add the CI tools description after the existing tool documentation section.

- [ ] Run `bunx tsc --noEmit` to confirm no type errors

---

## Task 3 — Update `planning-agent/system-prompt.md`

- [ ] Open `planning-agent/system-prompt.md`
- [ ] Locate the "Tools" or "Available Tools" section
- [ ] Add after the last existing tool description:

```markdown
### get_build_status — Check CI build status for a PR

Use the WebFetch tool to call:
```
GET ${HARNESS_API_URL}/api/pull-requests/{pullRequestId}/build-status
```

Returns the aggregated CI state (`success`, `failure`, `pending`, `unknown`) and
a list of individual check results with their `buildId` for log retrieval.

**Use this tool:**
- After a sub-agent opens a PR, before approving it
- To decide whether to re-dispatch a fix run when CI is failing

---

### get_build_logs — Retrieve raw CI logs for a failing check

Use the WebFetch tool to call:
```
GET ${HARNESS_API_URL}/api/pull-requests/{pullRequestId}/build-logs/{buildId}
```

Use the `buildId` from a failing check in the `get_build_status` response.

Returns `{ "logs": "..." }` — either raw text or a URL to the logs.

**Use this tool:**
- Only when a specific check has `status: "failure"`
- Extract the relevant error lines and include them in re-dispatch messages
```

- [ ] Commit: `feat: document CI tools in planning-agent system-prompt.md`

---

## Task 4 — Environment variable wiring

`HARNESS_API_URL` is already handled — no new docker-compose changes required.

**How it's wired (verified 2026-03-28):**
- `backend/src/config.ts:74`: `harnessApiUrl: process.env.HARNESS_API_URL ?? "http://backend:3000"`
- `backend/src/orchestrator/containerManager.ts:66`: sub-agent containers receive `HARNESS_API_URL=${config.harnessApiUrl}`
- Task 2 above uses `config.harnessApiUrl` (which defaults to `"http://backend:3000"`) — correct for the Docker network

- [ ] Verify `docker-compose.yml` does not need a change: the backend service reads from `.env` via `env_file: .env`, and `HARNESS_API_URL` defaults in `config.ts` are appropriate for Docker networking.

- [ ] Add `HARNESS_API_URL` to `.env.example` to document the override option:

```env
# Override the harness API base URL (default for Docker Compose: http://backend:3000)
# HARNESS_API_URL=http://backend:3000
```

- [ ] Commit: `feat: inject CI tools description into planning agent context`

---

## Task 5 — Integration test

- [ ] Create `backend/src/agents/__tests__/ciTools.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildCiToolsDescription } from "../ciTools";

describe("buildCiToolsDescription", () => {
  it("includes the correct API URL in tool descriptions", () => {
    const desc = buildCiToolsDescription("https://harness.corp.example.com");
    expect(desc).toContain("https://harness.corp.example.com/api/pull-requests/{pullRequestId}/build-status");
    expect(desc).toContain("https://harness.corp.example.com/api/pull-requests/{pullRequestId}/build-logs/{buildId}");
  });

  it("includes polling workflow guidance", () => {
    const desc = buildCiToolsDescription("http://localhost:3000");
    expect(desc).toContain("state == \"pending\"");
    expect(desc).toContain("state == \"failure\"");
    expect(desc).toContain("state == \"success\"");
  });

  it("does not hardcode a specific URL", () => {
    const desc1 = buildCiToolsDescription("http://localhost:3000");
    const desc2 = buildCiToolsDescription("https://prod.example.com");
    expect(desc1).not.toContain("prod.example.com");
    expect(desc2).not.toContain("localhost:3000");
  });
});
```

- [ ] Run: `cd backend && bun run test src/agents/__tests__/ciTools.test.ts`

---

## Verification checklist

- [ ] `buildCiToolsDescription()` exports correctly from `backend/src/agents/ciTools.ts`
- [ ] `buildMasterAgentContext()` includes the CI tools section when `HARNESS_API_URL` is set
- [ ] `buildMasterAgentContext()` falls back to `http://localhost:3000` when `HARNESS_API_URL` is unset
- [ ] `planning-agent/system-prompt.md` documents both `get_build_status` and `get_build_logs`
- [ ] Docker Compose sets `HARNESS_API_URL=http://backend:3000` for the planning agent service
- [ ] All 3 unit tests pass
- [ ] `bunx tsc --noEmit` passes with no errors
- [ ] Manual test: start harness locally, open a project, confirm CI tool descriptions appear in the planning agent's first message in the WebSocket log
