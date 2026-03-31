# Agent Log Persistence & Execution Screen Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three related issues: sub-agent fallback file polluting repo root, agent events lost on backend restart, and Execution screen showing nothing for the Planning Agent.

**Architecture:** Fix A patches a one-liner path in the sub-agent runner. Fix B swaps the in-memory agentEvents store for SQLite (same interface, durable), persists planning agent events in the WS broadcaster, adds a replay endpoint, and wires up the Execution screen. Fix C adds a `commitSessionLog` method to `PlanningAgentManager` that reads the planning agent session from the shared volume and commits it to the primary GitHub repo.

**Tech Stack:** Node.js/TypeScript (backend), React/TypeScript (frontend), better-sqlite3, vitest, GitHub API via existing `GitHubConnector`

**Spec:** `docs/superpowers/specs/2026-03-23-agent-log-persistence-design.md`

---

## File Map

| Action | File | What changes |
|--------|------|-------------|
| Modify | `sub-agent/runner.mjs` | Redirect fallback `task-output.md` from root to `.harness/logs/sub-agents/${TASK_ID}/` |
| Modify | `backend/src/store/db.ts` | Add `agent_events` table + index to `migrate()` |
| Modify | `backend/src/store/agentEvents.ts` | Replace in-memory Map with SQLite via `getDb()` |
| Modify | `backend/src/__tests__/agentEvents.test.ts` | Add `initDb` setup so tests work with SQLite backend |
| Modify | `backend/src/api/websocket.ts` | Call `appendEvent("master-${projectId}", ...)` in project broadcaster |
| Modify | `backend/src/api/projects.ts` | Add `GET /:id/master-events` endpoint |
| Modify | `backend/src/__tests__/projects.test.ts` | Test the new endpoint |
| Modify | `frontend/src/pages/Execution.tsx` | Fetch & replay master events on mount |
| Modify | `backend/src/orchestrator/planningAgentManager.ts` | Add `commitSessionLog()`, call from `stopContainer` and `conversation_complete` |
| Modify | `backend/src/__tests__/planningAgentManager.test.ts` | Tests for `commitSessionLog` |

---

## Task 1: Fix A — move sub-agent fallback file out of repo root

**Files:**
- Modify: `sub-agent/runner.mjs:240-245`

The fallback `task-output.md` is written to the repo root when the AI makes no file changes.
Move it to `.harness/logs/sub-agents/${TASK_ID}/task-output.md` — same directory the session log
is already written to a few lines later.

- [ ] **Step 1: Locate the write in runner.mjs**

Search for the current hardcoded path:

```bash
grep -n "task-output.md" sub-agent/runner.mjs
```

Expected output: two lines — the `writeFileSync` call and the comment above it.

- [ ] **Step 2: Apply the path fix**

In `sub-agent/runner.mjs`, replace the block that writes the fallback file:

```js
// BEFORE (around line 241):
writeFileSync(
  "task-output.md",
  `# Task Output\n\nTask: ${TASK_DESCRIPTION}\n\nNote: ${note}\nCompleted at: ${new Date().toISOString()}\n`
);

// AFTER:
const fallbackLogDir = `.harness/logs/sub-agents/${TASK_ID}`;
mkdirSync(fallbackLogDir, { recursive: true });
writeFileSync(
  `${fallbackLogDir}/task-output.md`,
  `# Task Output\n\nTask: ${TASK_DESCRIPTION}\n\nNote: ${note}\nCompleted at: ${new Date().toISOString()}\n`
);
```

`mkdirSync` is already imported at the top of the file.

- [ ] **Step 3: Verify no root-level path remains**

```bash
grep -n "task-output.md" sub-agent/runner.mjs
```

Expected: only the new path containing `.harness/logs/sub-agents/` appears.

- [ ] **Step 4: Commit**

```bash
git add sub-agent/runner.mjs
git commit -m "fix(sub-agent): move fallback task-output.md to .harness/logs/sub-agents/<taskId>/"
```

---

## Task 2: Fix B — add agent_events table to SQLite schema

**Files:**
- Modify: `backend/src/store/db.ts`

The `agent_events` table is needed before swapping the in-memory store. Adding it to the
idempotent `migrate()` function means it is created on first startup and safe to re-run.

- [ ] **Step 1: Write a failing test**

In `backend/src/__tests__/store.test.ts`, add a new `describe` block at the bottom:

```ts
describe("agent_events table", () => {
  it("table exists after migration", () => {
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_events'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("agent_events");
  });

  it("index exists after migration", () => {
    const indexes = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_events_session'")
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd backend && npx vitest run src/__tests__/store.test.ts
```

Expected: FAIL — `agent_events` table does not exist yet.

- [ ] **Step 3: Add table to migration in db.ts**

Inside the `migrate()` function in `backend/src/store/db.ts`, append to the existing `database.exec(...)` string (before the closing backtick):

```sql
CREATE TABLE IF NOT EXISTS agent_events (
  session_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  timestamp   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_events_session
  ON agent_events (session_id);
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
cd backend && npx vitest run src/__tests__/store.test.ts
```

Expected: PASS — all store tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/store/db.ts backend/src/__tests__/store.test.ts
git commit -m "feat(backend): add agent_events table to SQLite schema"
```

---

## Task 3: Fix B — swap agentEvents store from in-memory Map to SQLite

**Files:**
- Modify: `backend/src/store/agentEvents.ts`
- Modify: `backend/src/__tests__/agentEvents.test.ts`

The public interface (`appendEvent`, `getEvents`, `clearEvents`) stays identical.
Callers (`agents.ts`, `websocket.ts`) need no changes.

- [ ] **Step 1: Update agentEvents.test.ts to initialise the DB**

The current test file has no DB setup. After the storage change it needs one.
Add the following imports and `beforeEach`/`afterEach` at the top of
`backend/src/__tests__/agentEvents.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { initDb } from "../store/db.js";
import { appendEvent, getEvents, clearEvents } from "../store/agentEvents.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-events-test-"));
  initDb(tmpDir);
  clearEvents("session-1");
  clearEvents("session-2");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

The four existing `it(...)` blocks remain unchanged.

- [ ] **Step 2: Run the tests to confirm they still fail (still in-memory)**

```bash
cd backend && npx vitest run src/__tests__/agentEvents.test.ts
```

Expected: PASS — they still pass because storage is still in-memory. This is the baseline.

- [ ] **Step 3: Replace agentEvents.ts with SQLite implementation**

Replace the entire contents of `backend/src/store/agentEvents.ts`:

```ts
import { getDb } from "./db.js";

export interface AgentEvent {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export function appendEvent(sessionId: string, event: AgentEvent): void {
  getDb()
    .prepare(
      "INSERT INTO agent_events (session_id, type, payload, timestamp) VALUES (?, ?, ?, ?)"
    )
    .run(sessionId, event.type, JSON.stringify(event.payload), event.timestamp);
}

export function getEvents(sessionId: string): AgentEvent[] {
  const rows = getDb()
    .prepare(
      "SELECT type, payload, timestamp FROM agent_events WHERE session_id = ? ORDER BY rowid"
    )
    .all(sessionId) as Array<{ type: string; payload: string; timestamp: string }>;
  return rows.map((r) => ({
    type: r.type,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    timestamp: r.timestamp,
  }));
}

export function clearEvents(sessionId: string): void {
  getDb()
    .prepare("DELETE FROM agent_events WHERE session_id = ?")
    .run(sessionId);
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
cd backend && npx vitest run src/__tests__/agentEvents.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Run the full backend test suite**

```bash
cd backend && npx vitest run
```

Expected: all tests pass. If any tests unrelated to this change fail, investigate before proceeding.

- [ ] **Step 6: Commit**

```bash
git add backend/src/store/agentEvents.ts backend/src/__tests__/agentEvents.test.ts
git commit -m "feat(backend): persist agent events in SQLite instead of in-memory Map"
```

---

## Task 4: Fix B — persist planning agent events in WebSocket broadcaster

**Files:**
- Modify: `backend/src/api/websocket.ts`

The project-wide broadcaster registered once per project in `setupWebSocket` currently
only broadcasts planning agent events over WS. Add `appendEvent` calls so tool calls,
tool results, thinking, and completed messages are stored durably.

`delta` events (partial streaming tokens) are intentionally NOT persisted — they are
high-frequency and the assembled message is already saved by `appendMessage`.

- [ ] **Step 1: Add appendEvent import to websocket.ts**

At the top of `backend/src/api/websocket.ts`, add to the existing imports:

```ts
import { appendEvent } from "../store/agentEvents.js";
```

- [ ] **Step 2: Write a failing test**

In `backend/src/__tests__/` there is no dedicated websocket test. Add a test to
`backend/src/__tests__/agentEvents.test.ts` that verifies the broadcaster contract
by testing `appendEvent` directly with the event shapes the broadcaster will emit:

```ts
it("stores planning agent tool_call events under master- prefix", () => {
  appendEvent("master-proj-1", {
    type: "tool_call",
    payload: { toolName: "dispatch_tasks", args: { tasks: [] } },
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  const events = getEvents("master-proj-1");
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("tool_call");
  expect(events[0].payload.toolName).toBe("dispatch_tasks");
});
```

Also add `clearEvents("master-proj-1")` to the `beforeEach` cleanup.

- [ ] **Step 3: Run the new test**

```bash
cd backend && npx vitest run src/__tests__/agentEvents.test.ts
```

Expected: PASS (the test already passes because it only exercises `appendEvent` directly).
This confirms the storage layer works for the `master-` prefix pattern.

- [ ] **Step 4: Update the broadcaster in websocket.ts**

Find the project-wide broadcaster block (starts with `if (!projectBroadcasters.has(projectId))`).
Update the `switch` cases to also call `appendEvent`:

```ts
// Replace the switch inside the project broadcaster with:
switch (event.type) {
  case "delta":
    messageBuffer += event.text;
    break;
  case "message_complete":
    if (messageBuffer) {
      appendMessage(projectId, "assistant", messageBuffer);
      appendEvent(`master-${projectId}`, {
        type: "text",
        payload: { text: messageBuffer },
        timestamp: new Date().toISOString(),
      });
      messageBuffer = "";
    }
    broadcastToProject(projectId, { type: "message_complete" });
    break;
  case "tool_call":
    appendEvent(`master-${projectId}`, {
      type: "tool_call",
      payload: { toolName: event.toolName, args: event.args ?? {} },
      timestamp: new Date().toISOString(),
    });
    broadcastToProject(projectId, {
      type: "tool_call",
      toolName: event.toolName,
      args: event.args ?? {},
      agentType: "master",
    });
    break;
  case "tool_result":
    appendEvent(`master-${projectId}`, {
      type: "tool_result",
      payload: {
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      },
      timestamp: new Date().toISOString(),
    });
    broadcastToProject(projectId, {
      type: "tool_result",
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
      agentType: "master",
    });
    break;
  case "thinking":
    appendEvent(`master-${projectId}`, {
      type: "thinking",
      payload: { text: event.text },
      timestamp: new Date().toISOString(),
    });
    broadcastToProject(projectId, {
      type: "thinking",
      text: event.text,
      agentType: "master",
    });
    break;
  case "conversation_complete":
    broadcastToProject(projectId, { type: "conversation_complete" });
    break;
}
```

- [ ] **Step 5: Build to check for TypeScript errors**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Run full backend tests**

```bash
cd backend && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/api/websocket.ts backend/src/__tests__/agentEvents.test.ts
git commit -m "feat(backend): persist planning agent events to SQLite in WS broadcaster"
```

---

## Task 5: Fix B — add GET /api/projects/:id/master-events endpoint

**Files:**
- Modify: `backend/src/api/projects.ts`
- Modify: `backend/src/__tests__/projects.test.ts`

- [ ] **Step 1: Write a failing test**

In `backend/src/__tests__/projects.test.ts`, add a new `describe` block after the existing ones:

```ts
describe("GET /projects/:id/master-events", () => {
  it("returns 404 for unknown project", async () => {
    const res = await request(app).get("/projects/nonexistent/master-events");
    expect(res.status).toBe(404);
  });

  it("returns empty array when no events recorded", async () => {
    const project = createTestProject();
    const res = await request(app).get(`/projects/${project.id}/master-events`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns stored planning agent events", async () => {
    const project = createTestProject();
    appendEvent(`master-${project.id}`, {
      type: "tool_call",
      payload: { toolName: "dispatch_tasks" },
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const res = await request(app).get(`/projects/${project.id}/master-events`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].type).toBe("tool_call");
    expect(res.body[0].payload.toolName).toBe("dispatch_tasks");
  });
});
```

Also add to the imports in `projects.test.ts`:

```ts
import { appendEvent } from "../store/agentEvents.js";
```

No cleanup needed in `beforeEach` — the existing pattern calls `initDb(tmpDir)` with a fresh temp directory each test, giving a clean database every time.

- [ ] **Step 2: Run the failing tests**

```bash
cd backend && npx vitest run src/__tests__/projects.test.ts
```

Expected: FAIL — route not found (404 returned for the valid project).

- [ ] **Step 3: Add the endpoint to projects.ts**

Add to the imports at the top of `backend/src/api/projects.ts`:

```ts
import { getEvents } from "../store/agentEvents.js";
```

Add the following route inside `createProjectsRouter()`, alongside other `GET /:id/...` routes:

```ts
router.get("/:id/master-events", (req: Request, res: Response) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json(getEvents(`master-${req.params.id}`));
});
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
cd backend && npx vitest run src/__tests__/projects.test.ts
```

Expected: all tests PASS including the 3 new ones.

- [ ] **Step 5: Run full backend tests**

```bash
cd backend && npx vitest run
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/api/projects.ts backend/src/__tests__/projects.test.ts
git commit -m "feat(backend): add GET /projects/:id/master-events endpoint"
```

---

## Task 6: Fix B — replay planning agent events in Execution screen

**Files:**
- Modify: `frontend/src/pages/Execution.tsx`

On mount, fetch `/api/projects/${id}/master-events` and populate the Planning Agent's
event list — the same replay approach used for sub-agents.

- [ ] **Step 1: Locate the existing sub-agent replay useEffect**

The current sub-agent replay is in the first `useEffect` in `Execution.tsx`
(the one that calls `api.projects.agents(id)`). The master events fetch will be
a separate `useEffect` added directly below it.

- [ ] **Step 2: Add the master events replay useEffect**

In `frontend/src/pages/Execution.tsx`, directly after the sub-agent replay `useEffect`
(after its closing `}, [id]);`), add:

```tsx
// Replay planning agent events on mount
useEffect(() => {
  if (!id) return;
  const controller = new AbortController();
  const { signal } = controller;

  fetch(`/api/projects/${id}/master-events`, { signal })
    .then((r) => {
      if (!r.ok) return null;
      return r.json() as Promise<
        Array<{ type: string; payload: Record<string, unknown>; timestamp: string }>
      >;
    })
    .then((evts) => {
      if (!evts || signal.aborted || evts.length === 0) return;
      const mapped: ActivityEvent[] = evts.map((e, i) => ({
        id: `master-replay-${i}`,
        agentId: "master",
        type: e.type,
        toolName: e.payload.toolName as string | undefined,
        args: e.payload.args as Record<string, unknown> | undefined,
        result: e.payload.result,
        isError: e.payload.isError as boolean | undefined,
        text: (e.payload.text ?? e.payload.delta) as string | undefined,
        timestamp: e.timestamp,
      }));
      setEvents((prev) => {
        const m = new Map(prev);
        m.set("master", mapped);
        return m;
      });
    })
    .catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("[Execution] Error fetching master events:", err);
    });

  return () => controller.abort();
}, [id]);
```

- [ ] **Step 3: Check TypeScript**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run frontend tests**

```bash
cd frontend && npx vitest run
```

Expected: all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Execution.tsx
git commit -m "feat(frontend): replay planning agent events in Execution screen on mount"
```

---

## Task 7: Fix C — commit planning agent session log to git on stop/complete

**Files:**
- Modify: `backend/src/orchestrator/planningAgentManager.ts`
- Modify: `backend/src/__tests__/planningAgentManager.test.ts`

`PlanningAgentManager` gets a new private async method `commitSessionLog(projectId)` that:
1. Reads `/pi-agent/sessions/planning-${projectId}.jsonl` (the backend has `harness-pi-auth` mounted at `/pi-agent`)
2. Looks up the project's primary GitHub repository
3. Calls `GitHubConnector.commitFile()` to write `.harness/logs/planning-agent/${projectId}.jsonl` to `defaultBranch`

It is called (best-effort, fire-and-forget) from `conversation_complete` and (awaited) from `stopContainer`.

- [ ] **Step 1: Write failing tests**

Add a new `describe` block to `backend/src/__tests__/planningAgentManager.test.ts`.
The test suite already uses `vi.resetModules()` and dynamic imports — follow the same pattern:

```ts
// ── commitSessionLog tests ────────────────────────────────────────────────────

describe("PlanningAgentManager - commitSessionLog", () => {
  beforeEach(() => {
    vi.resetModules();
    netState.lastSocket = null;
  });

  it("commits session log to GitHub on stopContainer", async () => {
    // Mock fs/promises to return a fake session file
    vi.mock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue("line1\nline2\n"),
    }));

    // Mock store lookups
    vi.mock("../store/projects.js", () => ({
      getProject: vi.fn().mockReturnValue({
        id: "proj-1",
        primaryRepositoryId: "repo-1",
      }),
    }));
    vi.mock("../store/repositories.js", () => ({
      getRepository: vi.fn().mockReturnValue({
        id: "repo-1",
        name: "my-repo",
        provider: "github",
        cloneUrl: "https://github.com/org/my-repo.git",
        defaultBranch: "main",
        providerConfig: { owner: "org", repo: "my-repo" },
      }),
    }));

    const mockCommitFile = vi.fn().mockResolvedValue(undefined);
    vi.mock("../connectors/github.js", () => ({
      GitHubConnector: vi.fn().mockImplementation(() => ({
        commitFile: mockCommitFile,
      })),
    }));

    const { docker, mockContainer } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-1", []);
    await mgr.stopContainer("proj-1");

    expect(mockCommitFile).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "github" }),
      "main",
      ".harness/logs/planning-agent/proj-1.jsonl",
      "line1\nline2\n",
      "chore: save planning agent session log [proj-1]"
    );
    expect(mockContainer.stop).toHaveBeenCalled();
  });

  it("skips commit when session file does not exist (ENOENT)", async () => {
    const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
    vi.mock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(enoent),
    }));
    vi.mock("../store/projects.js", () => ({
      getProject: vi.fn().mockReturnValue({ id: "proj-1", primaryRepositoryId: "repo-1" }),
    }));
    vi.mock("../store/repositories.js", () => ({
      getRepository: vi.fn().mockReturnValue({
        id: "repo-1", provider: "github", defaultBranch: "main",
        providerConfig: { owner: "org", repo: "r" },
      }),
    }));
    const mockCommitFile = vi.fn();
    vi.mock("../connectors/github.js", () => ({
      GitHubConnector: vi.fn().mockImplementation(() => ({ commitFile: mockCommitFile })),
    }));

    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-1", []);
    await mgr.stopContainer("proj-1");

    expect(mockCommitFile).not.toHaveBeenCalled();
  });

  it("skips commit when primary repo is not GitHub", async () => {
    vi.mock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue("content"),
    }));
    vi.mock("../store/projects.js", () => ({
      getProject: vi.fn().mockReturnValue({ id: "proj-1", primaryRepositoryId: "repo-1" }),
    }));
    vi.mock("../store/repositories.js", () => ({
      getRepository: vi.fn().mockReturnValue({
        id: "repo-1", provider: "bitbucket-server", defaultBranch: "main",
        providerConfig: {},
      }),
    }));
    const mockCommitFile = vi.fn();
    vi.mock("../connectors/github.js", () => ({
      GitHubConnector: vi.fn().mockImplementation(() => ({ commitFile: mockCommitFile })),
    }));

    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-1", []);
    await mgr.stopContainer("proj-1");

    expect(mockCommitFile).not.toHaveBeenCalled();
  });

  it("does not throw when commitFile fails — logs warning only", async () => {
    vi.mock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue("content"),
    }));
    vi.mock("../store/projects.js", () => ({
      getProject: vi.fn().mockReturnValue({ id: "proj-1", primaryRepositoryId: "repo-1" }),
    }));
    vi.mock("../store/repositories.js", () => ({
      getRepository: vi.fn().mockReturnValue({
        id: "repo-1", provider: "github", defaultBranch: "main",
        providerConfig: { owner: "org", repo: "r" },
      }),
    }));
    vi.mock("../connectors/github.js", () => ({
      GitHubConnector: vi.fn().mockImplementation(() => ({
        commitFile: vi.fn().mockRejectedValue(new Error("API rate limit")),
      })),
    }));

    const { docker } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-1", []);
    // Should not throw
    await expect(mgr.stopContainer("proj-1")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the failing tests**

```bash
cd backend && npx vitest run src/__tests__/planningAgentManager.test.ts
```

Expected: 4 new tests FAIL (method does not exist yet).

- [ ] **Step 3: Add imports to planningAgentManager.ts**

At the top of `backend/src/orchestrator/planningAgentManager.ts`, add:

```ts
import { readFile } from "node:fs/promises";
import { GitHubConnector } from "../connectors/github.js";
import { getProject } from "../store/projects.js";
import { getRepository } from "../store/repositories.js";
```

- [ ] **Step 4: Add the commitSessionLog method**

Inside the `PlanningAgentManager` class, add before the closing `}`:

```ts
private async commitSessionLog(projectId: string): Promise<void> {
  const sessionPath = `/pi-agent/sessions/planning-${projectId}.jsonl`;
  let content: string;
  try {
    content = await readFile(sessionPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn(`[PlanningAgentManager] could not read session log for ${projectId}:`, err);
    return;
  }

  const project = getProject(projectId);
  if (!project?.primaryRepositoryId) {
    console.warn(`[PlanningAgentManager] no primary repository for ${projectId}, skipping session log commit`);
    return;
  }

  const repo = getRepository(project.primaryRepositoryId);
  if (!repo || repo.provider !== "github") {
    console.warn(`[PlanningAgentManager] primary repo for ${projectId} is not GitHub, skipping`);
    return;
  }

  try {
    const connector = new GitHubConnector();
    await connector.commitFile(
      repo,
      repo.defaultBranch,
      `.harness/logs/planning-agent/${projectId}.jsonl`,
      content,
      `chore: save planning agent session log [${projectId}]`
    );
    console.log(`[PlanningAgentManager] session log committed for ${projectId}`);
  } catch (err) {
    console.warn(`[PlanningAgentManager] failed to commit session log for ${projectId}:`, err);
  }
}
```

- [ ] **Step 5: Call commitSessionLog from stopContainer**

In the `stopContainer` method, add the call before stopping the Docker container:

```ts
async stopContainer(projectId: string): Promise<void> {
  const state = this.projects.get(projectId);
  if (!state) return;
  this.projects.delete(projectId);
  state.tcpSocket.destroy();
  // Best-effort: save session log to git before stopping
  await this.commitSessionLog(projectId);
  try {
    await this.docker.getContainer(state.containerId).stop({ t: 10 });
    console.log(`[PlanningAgentManager] stopped container ${state.containerId}`);
  } catch (err) {
    console.warn(`[PlanningAgentManager] stop failed (may already be stopped):`, err);
  }
}
```

- [ ] **Step 6: Call commitSessionLog from conversation_complete handler**

In `handleRpcLine`, in the `agent_end` branch (which emits `conversation_complete`), add a fire-and-forget call:

```ts
if (type === "agent_end") {
  state.isStreaming = false;
  state.promptPending = false;
  this.emit(state, { type: "conversation_complete" });
  // Fire-and-forget: save session snapshot after each complete agent response
  void this.commitSessionLog(projectId);
  return;
}
```

- [ ] **Step 7: Run the tests**

```bash
cd backend && npx vitest run src/__tests__/planningAgentManager.test.ts
```

Expected: all tests PASS including the 4 new ones.

- [ ] **Step 8: Run full backend tests**

```bash
cd backend && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 9: Build check**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add backend/src/orchestrator/planningAgentManager.ts \
        backend/src/__tests__/planningAgentManager.test.ts
git commit -m "feat(backend): commit planning agent session log to git on stop/complete"
```

---

## Final Verification

- [ ] **Run all tests one last time**

```bash
cd /home/ae/multi-agent-harness/backend && npx vitest run
cd /home/ae/multi-agent-harness/frontend && npx vitest run
```

Expected: all suites green.

- [ ] **Check no task-output.md at root**

```bash
grep -r "writeFileSync.*task-output.md" sub-agent/runner.mjs
```

Expected: no match (path now uses `.harness/logs/...`).
