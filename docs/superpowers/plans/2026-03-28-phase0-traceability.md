# Traceability — Guard Hooks + TraceBuilder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block agent access to `.harness/` at the tool layer, remove ad-hoc log commits from both runners, and build a `TraceBuilder` module that writes structured `trace.json` files to the planning branch.

**Architecture:** A `BashSpawnHook`-based path guard is added to both `sub-agent/tools.mjs` and `planning-agent/tools.mjs` blocking any command that targets `.harness/`. The legacy session-log commit blocks in both runners are removed. A new `backend/src/orchestrator/traceBuilder.ts` module maintains an in-memory `Trace` object per project and can persist it to `.harness/trace.json` via the VCS connector's `commitFile()`.

**Tech Stack:** Node ESM (Bun runtime), TypeScript (Express backend), better-sqlite3, Docker containers, pi-coding-agent SDK (`BashSpawnHook` pattern already established in `tools.mjs`).

---

## Part A — Guard hooks in agent runners (`.harness/` protection)

### Background

Both runners already use the `createGuardHook` / `createPlanningAgentGuardHook` pattern defined in their respective `tools.mjs` files. The guard hook receives `context.command` (a shell command string) and can rewrite it to an error-printing command to block execution. This is the `BashSpawnHook` API: a function `(context: { command: string }) => { command: string }`.

The current guards only check for destructive `git`/`gh` invocations. We need to extend them to also block any shell command that references `.harness/` paths.

### Step A1 — Add `.harness/` path guard to `sub-agent/tools.mjs`

- [ ] Read `sub-agent/tools.mjs` (already read — reference lines 28–94).
- [ ] In `sub-agent/tools.mjs`, add a helper function `hasHarnessPath(tokens)` immediately before `export function createGuardHook(...)`:

```javascript
/**
 * Returns true if any token in the command targets the .harness/ directory.
 * Matches: .harness/..., /.harness/..., or a token that IS ".harness" exactly.
 */
function hasHarnessPath(tokens) {
  return tokens.some(t => /(?:^|\/)\.harness(?:\/|$)/.test(t));
}
```

- [ ] Inside `createGuardHook`, modify the `return function guardHook(context)` body. After the `hasEmbeddedTokenUrl` check and before the `for` loop over `patterns`, add:

```javascript
      if (hasHarnessPath(tokens)) {
        const msg = "[GUARD] Access to .harness/ is prohibited. This directory is managed exclusively by the harness backend.";
        const safe = msg.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        return {
          ...context,
          command: `printf '${safe}\\n' >&2; exit 1`,
        };
      }
```

The final shape of the guard function body in `createGuardHook` becomes:

```javascript
  return function guardHook(context) {
    try {
      const tokens = context.command.trimStart().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return context;

      if (hasEmbeddedTokenUrl(tokens)) {
        return {
          ...context,
          command: `printf 'Blocked: git push with an embedded credential URL is not allowed.\\n' >&2; exit 1`,
        };
      }

      if (hasHarnessPath(tokens)) {
        const msg = "[GUARD] Access to .harness/ is prohibited. This directory is managed exclusively by the harness backend.";
        const safe = msg.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        return {
          ...context,
          command: `printf '${safe}\\n' >&2; exit 1`,
        };
      }

      for (const [pattern, message] of patterns) {
        if (tokens.length < pattern.length) continue;
        if (pattern.every((tok, i) => tokens[i] === tok)) {
          const safe = message.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
          return {
            ...context,
            command: `printf 'Blocked: ${safe}\\n' >&2; exit 1`,
          };
        }
      }
    } catch (err) {
      console.warn("[guard] hook error, allowing command through:", err?.message ?? err);
    }
    if (isRtkAvailable) {
      return { ...context, command: "rtk " + context.command };
    }
    return context;
  };
```

### Step A2 — Add `.harness/` path guard to `planning-agent/tools.mjs`

- [ ] Read `planning-agent/tools.mjs` (lines 56–end).
- [ ] The planning agent uses `makeGuardHook(patterns)` internally. Apply the same `hasHarnessPath` helper and guard block inside `makeGuardHook` in `planning-agent/tools.mjs`, in the same position (after `hasEmbeddedTokenUrl`, before the `for` loop).

```javascript
function hasHarnessPath(tokens) {
  return tokens.some(t => /(?:^|\/)\.harness(?:\/|$)/.test(t));
}
```

Add inside `makeGuardHook`'s returned function, after the `hasEmbeddedTokenUrl` block:

```javascript
      if (hasHarnessPath(tokens)) {
        const msg = "[GUARD] Access to .harness/ is prohibited. This directory is managed exclusively by the harness backend.";
        const safe = msg.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        return {
          ...context,
          command: `printf '${safe}\\n' >&2; exit 1`,
        };
      }
```

### Step A3 — Add unit tests for `.harness/` guard

- [ ] In `sub-agent/tools.test.mjs`, add test cases for the new guard:

```javascript
import { createGuardHook } from "./tools.mjs";

// Existing tests above...

describe("createGuardHook — .harness/ path guard", () => {
  const hook = createGuardHook();

  test("blocks direct .harness/ path in command", () => {
    const result = hook({ command: "cat .harness/trace.json" });
    expect(result.command).toContain("exit 1");
    expect(result.command).toContain("GUARD");
  });

  test("blocks absolute path containing .harness/", () => {
    const result = hook({ command: "ls /workspace/repo/.harness/logs/" });
    expect(result.command).toContain("exit 1");
  });

  test("blocks write to .harness/", () => {
    const result = hook({ command: "echo foo > .harness/trace.json" });
    expect(result.command).toContain("exit 1");
  });

  test("does not block unrelated commands", () => {
    const result = hook({ command: "ls /workspace/repo/src/" });
    // Should not be blocked (may have rtk prefix)
    expect(result.command).not.toContain("exit 1");
  });
});
```

- [ ] Run `cd sub-agent && bun test tools.test.mjs` and confirm all tests pass.
- [ ] Add equivalent tests to `planning-agent/tools.test.mjs`.
- [ ] Run `cd planning-agent && bun test tools.test.mjs` and confirm all tests pass.

---

## Part B — Remove `.harness/logs/` commit logic from runners

### Step B1 — Remove session-log commit block from `sub-agent/runner.mjs`

Current code at lines 268–290:

```javascript
// ── Commit session log ────────────────────────────────────────────────────────
try {
  const sessionJsonl = join(sessionDir, "session.jsonl");
  const logDir = `.harness/logs/sub-agents/${TASK_ID}`;
  const logDest = `${logDir}/session.jsonl`;

  if (fsExistsSync(sessionJsonl)) {
    mkdirSync(logDir, { recursive: true });
    copyFileSync(sessionJsonl, logDest);
    git("add", logDest);
    const logDiff = execSync("git diff --cached --stat").toString().trim();
    if (logDiff) {
      git("commit", "-m", `chore: add agent log for task ${TASK_ID}`);
      execFileSync("git", ["push", "origin", `HEAD:${BRANCH_NAME}`], { stdio: "inherit" });
      console.log("[sub-agent] Session log committed for task:", TASK_ID);
    }
  } else {
    console.warn("[sub-agent] No session.jsonl found at:", sessionJsonl);
  }
} catch (logErr) {
  // Best-effort — do not change exit code
  console.warn("[sub-agent] Failed to commit session log:", logErr.message);
}
```

- [ ] Replace the entire block (lines 268–290) with:

```javascript
// Legacy log commits removed — structured tracing handled by backend TraceBuilder.
```

- [ ] Also update the no-changes fallback block at lines 247–254. Currently it writes a fallback log to `.harness/logs/sub-agents/${TASK_ID}/task-output.md`. Replace that inner block:

**Current (lines 247–254):**
```javascript
    const note = aiSucceeded
      ? "AI agent completed but made no file changes."
      : "AI agent unavailable; placeholder created.";
    const fallbackLogDir = `.harness/logs/sub-agents/${TASK_ID}`;
    mkdirSync(fallbackLogDir, { recursive: true });
    writeFileSync(
      `${fallbackLogDir}/task-output.md`,
      `# Task Output\n\nTask: ${TASK_DESCRIPTION}\n\nNote: ${note}\nCompleted at: ${new Date().toISOString()}\n`
    );
    git("add", "-A");
```

**Replacement:**
```javascript
    // Legacy log commits removed — structured tracing handled by backend TraceBuilder.
    // No file changes and no fallback log needed; exitCode remains aiSucceeded ? 0 : 1.
    console.log("[sub-agent] No file changes to commit.");
```

- [ ] Remove the now-unused import `copyFileSync` from the `node:fs` import line if it is only used in the removed block. Check whether `copyFileSync` is referenced elsewhere before removing it.

  The current import line (line 16):
  ```javascript
  import { writeFileSync, appendFileSync, mkdirSync, copyFileSync, existsSync as fsExistsSync } from "node:fs";
  ```

  After removal of the log commit block, `copyFileSync` is unused. Remove it:
  ```javascript
  import { writeFileSync, appendFileSync, mkdirSync, existsSync as fsExistsSync } from "node:fs";
  ```

  Also verify whether `writeFileSync` and `mkdirSync` are still used after the fallback log removal. If not, remove those too. (They are used in the fallback block only — remove both if confirmed.)

  Final import after both removals (assuming no other usage):
  ```javascript
  import { appendFileSync, existsSync as fsExistsSync } from "node:fs";
  ```

  Run a grep for each import to verify before removing.

### Step B2 — Remove `.harness/logs/` commit from `planning-agent/runner.mjs`

- [ ] Search `planning-agent/runner.mjs` for any reference to `.harness/logs/`. Currently the planning agent runner does not appear to have such a block (confirmed from reading lines 1–361), but verify with grep:

```bash
grep -n "harness/logs" /home/ae/multi-agent-harness/planning-agent/runner.mjs
```

If any matches are found, remove the corresponding block and replace with:
```javascript
// Legacy log commits removed — structured tracing handled by backend TraceBuilder.
```

---

## Part C — TraceBuilder module

### Step C1 — Create `backend/src/orchestrator/traceBuilder.ts`

- [ ] Create the file at `/home/ae/multi-agent-harness/backend/src/orchestrator/traceBuilder.ts` with the following content:

```typescript
import { randomUUID } from "crypto";

export interface TraceRequirement {
  id: string;
  summary: string;
  section?: string;
}

export interface TraceToolCall {
  tool: string;
  file?: string;
  timestamp: string;
}

export interface TraceAttempt {
  attemptNumber: number;
  startedAt: string;
  completedAt?: string;
  toolCalls: TraceToolCall[];
  commits: Array<{ sha: string; message: string }>;
  ci?: {
    state: "pending" | "success" | "failure" | "error";
    checks: Array<{ name: string; state: string; url?: string }>;
  };
}

export interface TraceTask {
  id: string;
  requirementIds: string[];
  description: string;
  status: "pending" | "executing" | "completed" | "failed";
  attempts: TraceAttempt[];
}

export interface TracePullRequest {
  taskIds: string[];
  url: string;
  branch: string;
  state: "open" | "merged" | "declined";
}

export interface Trace {
  version: "1.0";
  project: {
    id: string;
    name: string;
    status: string;
    specApprovedAt?: string;
    specApprovedBy?: string;
    planApprovedAt?: string;
    planApprovedBy?: string;
  };
  requirements: TraceRequirement[];
  tasks: TraceTask[];
  planningPr?: { url: string; number: number };
  pullRequests: TracePullRequest[];
  createdAt: string;
  updatedAt: string;
}

export class TraceBuilder {
  private trace: Trace;

  constructor(projectId: string, projectName: string) {
    this.trace = {
      version: "1.0",
      project: { id: projectId, name: projectName, status: "brainstorming" },
      requirements: [],
      tasks: [],
      pullRequests: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  setProjectStatus(status: string): this {
    this.trace.project.status = status;
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  setSpecApproved(approvedAt: string, approvedBy?: string): this {
    this.trace.project.specApprovedAt = approvedAt;
    this.trace.project.specApprovedBy = approvedBy;
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  setPlanApproved(approvedAt: string, approvedBy?: string): this {
    this.trace.project.planApprovedAt = approvedAt;
    this.trace.project.planApprovedBy = approvedBy;
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  setRequirements(reqs: TraceRequirement[]): this {
    this.trace.requirements = reqs;
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  upsertTask(taskId: string, description: string, requirementIds: string[] = []): this {
    const existing = this.trace.tasks.find(t => t.id === taskId);
    if (!existing) {
      this.trace.tasks.push({
        id: taskId,
        description,
        requirementIds,
        status: "pending",
        attempts: [],
      });
    }
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  setTaskStatus(taskId: string, status: TraceTask["status"]): this {
    const task = this.trace.tasks.find(t => t.id === taskId);
    if (task) task.status = status;
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  recordTaskAttempt(taskId: string, attemptNumber: number): this {
    const task = this.trace.tasks.find(t => t.id === taskId);
    if (!task) return this;
    const existing = task.attempts.find(a => a.attemptNumber === attemptNumber);
    if (!existing) {
      task.attempts.push({
        attemptNumber,
        startedAt: new Date().toISOString(),
        toolCalls: [],
        commits: [],
      });
    }
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  recordTaskComplete(taskId: string): this {
    const task = this.trace.tasks.find(t => t.id === taskId);
    if (task) {
      task.status = "completed";
      const lastAttempt = task.attempts[task.attempts.length - 1];
      if (lastAttempt && !lastAttempt.completedAt) {
        lastAttempt.completedAt = new Date().toISOString();
      }
    }
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  recordTaskFailed(taskId: string): this {
    const task = this.trace.tasks.find(t => t.id === taskId);
    if (task) {
      task.status = "failed";
      const lastAttempt = task.attempts[task.attempts.length - 1];
      if (lastAttempt && !lastAttempt.completedAt) {
        lastAttempt.completedAt = new Date().toISOString();
      }
    }
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  setPlanningPr(url: string, number: number): this {
    this.trace.planningPr = { url, number };
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  recordCiResult(
    taskId: string,
    attemptNumber: number,
    ci: TraceAttempt["ci"]
  ): this {
    const task = this.trace.tasks.find(t => t.id === taskId);
    if (!task) return this;
    const attempt = task.attempts.find(a => a.attemptNumber === attemptNumber);
    if (attempt) attempt.ci = ci;
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  upsertPullRequest(pr: TracePullRequest): this {
    const existing = this.trace.pullRequests.find(p => p.url === pr.url);
    if (existing) {
      Object.assign(existing, pr);
    } else {
      this.trace.pullRequests.push(pr);
    }
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  toJSON(): Trace {
    return structuredClone(this.trace);
  }
}

// ── In-memory registry — one TraceBuilder per project ───────────────────────

const traceRegistry = new Map<string, TraceBuilder>();

export function getOrCreateTrace(projectId: string, projectName: string): TraceBuilder {
  if (!traceRegistry.has(projectId)) {
    traceRegistry.set(projectId, new TraceBuilder(projectId, projectName));
  }
  return traceRegistry.get(projectId)!;
}

export function getTrace(projectId: string): TraceBuilder | undefined {
  return traceRegistry.get(projectId);
}

export function clearTrace(projectId: string): void {
  traceRegistry.delete(projectId);
}
```

### Step C2 — Wire TraceBuilder into `recoveryService.ts`

- [ ] In `backend/src/orchestrator/recoveryService.ts`, add the import at the top:

```typescript
import { getOrCreateTrace } from "./traceBuilder.js";
```

- [ ] In `dispatchWithRetry`, after `updateTaskInPlan(project.id, task.id, { status: "executing", retryCount: localRetryCount })` (line ~219), add:

```typescript
          getOrCreateTrace(project.id, project.name).recordTaskAttempt(task.id, localRetryCount + 1);
```

- [ ] After `updateTaskInPlan(project.id, task.id, { status: "completed" })` (line ~248), add:

```typescript
            getOrCreateTrace(project.id, project.name).recordTaskComplete(task.id);
```

- [ ] After `updateTaskInPlan(project.id, task.id, { status: "failed", retryCount: localRetryCount })` (the per-attempt failure, line ~258), add:

```typescript
          getOrCreateTrace(project.id, project.name).recordTaskFailed(task.id);
```

- [ ] After `updateTaskInPlan(project.id, task.id, { status: "failed", ... errorMessage: ... })` (the permanently-failed case, line ~265), add:

```typescript
        getOrCreateTrace(project.id, project.name).recordTaskFailed(task.id);
```

### Step C3 — Wire TraceBuilder into `polling.ts` for lifecycle events

- [ ] Read `backend/src/polling.ts` to find where LGTM approval is detected for spec and plan.
- [ ] Add the import:

```typescript
import { getOrCreateTrace } from "./orchestrator/traceBuilder.js";
```

- [ ] At the point where spec LGTM is detected and `updateProject(projectId, { status: "awaiting_plan_approval" })` is called, add:

```typescript
getOrCreateTrace(project.id, project.name).setSpecApproved(new Date().toISOString());
```

- [ ] At the point where plan LGTM is detected and `updateProject(projectId, { status: "executing" })` is called, add:

```typescript
getOrCreateTrace(project.id, project.name).setPlanApproved(new Date().toISOString());
```

### Step C4 — Persist `trace.json` to `.harness/trace.json` on planning branch

- [ ] Read `backend/src/connectors/types.ts` to understand the `commitFile()` API signature.
- [ ] Create a helper function `persistTrace` in `traceBuilder.ts`:

```typescript
/**
 * Persist the current trace as .harness/trace.json on the project's planning branch.
 * Call this after significant lifecycle transitions (spec approved, plan approved,
 * task completed, task failed).
 *
 * @param projectId  - project ID (used to look up connector + planning branch)
 * @param projectName - project name (used to create trace if not yet existing)
 */
export async function persistTrace(
  projectId: string,
  projectName: string,
  planningBranch: string,
  connector: import("../connectors/types.js").VcsConnector,
): Promise<void> {
  const builder = getOrCreateTrace(projectId, projectName);
  const traceJson = JSON.stringify(builder.toJSON(), null, 2);
  try {
    await connector.commitFile({
      branch: planningBranch,
      path: ".harness/trace.json",
      content: traceJson,
      message: "chore: update harness trace",
    });
  } catch (err) {
    // Non-fatal — trace persistence should never block the main workflow
    console.warn(`[traceBuilder] Failed to persist trace.json for project ${projectId}:`, err);
  }
}
```

- [ ] Read `backend/src/connectors/types.ts` to get the exact `commitFile` signature. Adjust the call above to match.
- [ ] Call `persistTrace(...)` from the key lifecycle points identified in Step C3, passing the project's `planningBranch` and the connector instance retrieved via `getConnector(project.primaryRepositoryId)`.

### Step C5 — Add tests for TraceBuilder

- [ ] Create `backend/src/orchestrator/traceBuilder.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "vitest";
import { TraceBuilder, getOrCreateTrace, getTrace, clearTrace } from "./traceBuilder.js";

describe("TraceBuilder", () => {
  let tb: TraceBuilder;

  beforeEach(() => {
    tb = new TraceBuilder("proj-1", "Test Project");
  });

  test("initialises with correct version and project fields", () => {
    const t = tb.toJSON();
    expect(t.version).toBe("1.0");
    expect(t.project.id).toBe("proj-1");
    expect(t.project.name).toBe("Test Project");
    expect(t.project.status).toBe("brainstorming");
  });

  test("setProjectStatus updates status and updatedAt", () => {
    const before = tb.toJSON().updatedAt;
    tb.setProjectStatus("executing");
    const t = tb.toJSON();
    expect(t.project.status).toBe("executing");
    expect(t.updatedAt).not.toBe(before);
  });

  test("setSpecApproved sets specApprovedAt", () => {
    const ts = new Date().toISOString();
    tb.setSpecApproved(ts, "alice");
    const t = tb.toJSON();
    expect(t.project.specApprovedAt).toBe(ts);
    expect(t.project.specApprovedBy).toBe("alice");
  });

  test("upsertTask adds new task", () => {
    tb.upsertTask("task-1", "Implement feature X", ["req-1"]);
    const t = tb.toJSON();
    expect(t.tasks).toHaveLength(1);
    expect(t.tasks[0].id).toBe("task-1");
    expect(t.tasks[0].status).toBe("pending");
  });

  test("upsertTask does not duplicate", () => {
    tb.upsertTask("task-1", "Implement feature X");
    tb.upsertTask("task-1", "Implement feature X");
    expect(tb.toJSON().tasks).toHaveLength(1);
  });

  test("recordTaskAttempt adds attempt entry", () => {
    tb.upsertTask("task-1", "Desc");
    tb.recordTaskAttempt("task-1", 1);
    const task = tb.toJSON().tasks[0];
    expect(task.attempts).toHaveLength(1);
    expect(task.attempts[0].attemptNumber).toBe(1);
  });

  test("recordTaskComplete marks task completed and sets completedAt", () => {
    tb.upsertTask("task-1", "Desc");
    tb.recordTaskAttempt("task-1", 1);
    tb.recordTaskComplete("task-1");
    const task = tb.toJSON().tasks[0];
    expect(task.status).toBe("completed");
    expect(task.attempts[0].completedAt).toBeDefined();
  });

  test("upsertPullRequest updates existing by url", () => {
    tb.upsertPullRequest({ taskIds: ["t1"], url: "https://gh/pr/1", branch: "feat/x", state: "open" });
    tb.upsertPullRequest({ taskIds: ["t1"], url: "https://gh/pr/1", branch: "feat/x", state: "merged" });
    const t = tb.toJSON();
    expect(t.pullRequests).toHaveLength(1);
    expect(t.pullRequests[0].state).toBe("merged");
  });

  test("toJSON returns a deep clone", () => {
    tb.upsertTask("task-1", "Desc");
    const a = tb.toJSON();
    const b = tb.toJSON();
    expect(a).not.toBe(b);
    a.tasks[0].status = "failed";
    expect(tb.toJSON().tasks[0].status).toBe("pending");
  });
});

describe("getOrCreateTrace registry", () => {
  beforeEach(() => {
    clearTrace("proj-reg");
  });

  test("creates new TraceBuilder on first call", () => {
    const tb = getOrCreateTrace("proj-reg", "Reg Project");
    expect(tb).toBeInstanceOf(TraceBuilder);
  });

  test("returns same instance on second call", () => {
    const a = getOrCreateTrace("proj-reg", "Reg Project");
    const b = getOrCreateTrace("proj-reg", "Reg Project");
    expect(a).toBe(b);
  });

  test("getTrace returns undefined for unknown project", () => {
    expect(getTrace("nonexistent-proj-xyz")).toBeUndefined();
  });
});
```

- [ ] Run `cd backend && bun test src/orchestrator/traceBuilder.test.ts` and confirm all tests pass.

### Step C6 — TypeScript compile check

- [ ] Run `cd backend && bun run build` (or `npx tsc --noEmit`) to verify there are no TypeScript errors in the new file or the modified files.

---

## Summary of files changed

| File | Change |
|---|---|
| `sub-agent/tools.mjs` | Add `hasHarnessPath` + guard block in `createGuardHook` |
| `sub-agent/tools.test.mjs` | New test cases for `.harness/` guard |
| `sub-agent/runner.mjs` | Remove `.harness/logs/` commit blocks, update imports |
| `planning-agent/tools.mjs` | Add `hasHarnessPath` + guard block in `makeGuardHook` |
| `planning-agent/tools.test.mjs` | New test cases for `.harness/` guard |
| `planning-agent/runner.mjs` | Remove `.harness/logs/` commit block if present |
| `backend/src/orchestrator/traceBuilder.ts` | New file — `TraceBuilder` class + registry |
| `backend/src/orchestrator/traceBuilder.test.ts` | New file — unit tests |
| `backend/src/orchestrator/recoveryService.ts` | Wire trace events on task start/complete/fail |
| `backend/src/polling.ts` | Wire trace events on spec/plan LGTM |
