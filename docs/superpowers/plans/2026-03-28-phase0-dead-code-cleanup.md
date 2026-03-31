# Dead Code Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove 5 dead code items and fix one dynamic import in a hot path to eliminate unnecessary overhead.

**Architecture:** Three files are affected: `taskDispatcher.ts` has an unused `activeTasks` Map field plus an unused `getActiveTaskCount()` method plus a dynamic import inside a polling loop; `debounce/strategies.ts` has an unused `DebounceStrategy` union type and an unused `defaultDebounceConfig` export; `api/websocket.ts` exports a no-op `preInitAgent()` function that is called but does nothing.

**Tech Stack:** TypeScript, Express, better-sqlite3, Bun, Vitest

---

## Task 1 — Fix dynamic import in `taskDispatcher.ts`

The `getSessionStatus()` private method is called every 5 seconds (polling interval at line 302). It does a dynamic `import()` of `../store/agents.js` on every call, but `getAgentSession` is already statically imported at line 6.

- [ ] Open `backend/src/orchestrator/taskDispatcher.ts` and confirm line 6:
  ```typescript
  import { insertAgentSession, updateAgentSession, getAgentSession } from "../store/agents.js";
  ```
  `getAgentSession` is already present in the static import.

- [ ] Replace the `getSessionStatus` method (lines 307-313) — change from:
  ```typescript
  private async getSessionStatus(sessionId: string): Promise<AgentSession["status"] | null> {
    const { getAgentSession } = await import("../store/agents.js");
    const session = getAgentSession(sessionId);
    return session?.status ?? null;
  }
  ```
  To the synchronous version:
  ```typescript
  private getSessionStatus(sessionId: string): AgentSession["status"] | null {
    const session = getAgentSession(sessionId);
    return session?.status ?? null;
  }
  ```

- [ ] Update the two `await this.getSessionStatus(...)` call sites in the polling loop (around lines 291 and 297) — change from:
  ```typescript
  const session = await this.getSessionStatus(sessionId);
  ```
  To:
  ```typescript
  const session = this.getSessionStatus(sessionId);
  ```
  Both occurrences are inside the `setInterval` callback (the `checkInterval` block). Locate them by searching for `getSessionStatus` — there are exactly two callers at lines ~291 and ~297.

- [ ] Run `cd /home/ae/multi-agent-harness/backend && bun run test` and confirm all tests pass.

---

## Task 2 — Remove `activeTasks` field and `getActiveTaskCount()` method

The `private activeTasks = new Map<string, Promise<TaskResult>>();` field (line 37) is never populated — no code does `this.activeTasks.set(...)`. The `getActiveTaskCount()` public method (lines 521-523) reads `this.activeTasks.size` and is never called from outside the class.

- [ ] Verify nothing calls `getActiveTaskCount` outside `taskDispatcher.ts`:
  ```bash
  grep -r "getActiveTaskCount" /home/ae/multi-agent-harness/backend/src
  ```
  Expected: only the definition in `taskDispatcher.ts`.

- [ ] Verify nothing assigns to `activeTasks`:
  ```bash
  grep -n "activeTasks" /home/ae/multi-agent-harness/backend/src/orchestrator/taskDispatcher.ts
  ```
  Expected: only the field declaration (line 37) and `this.activeTasks.size` inside `getActiveTaskCount`.

- [ ] Delete the field declaration at line 37:
  ```typescript
  // DELETE this line:
  private activeTasks = new Map<string, Promise<TaskResult>>();
  ```

- [ ] Delete the `getActiveTaskCount` method (lines 518-523 after previous deletion shifts lines):
  ```typescript
  // DELETE this block:
  /**
   * Get active task count.
   */
  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }
  ```

- [ ] Run `cd /home/ae/multi-agent-harness/backend && bun run test` and confirm all tests pass.

---

## Task 3 — Remove `DebounceStrategy` type and `strategy` field

The `DebounceStrategy = "timer"` union type has only one member and is never branched on. The `strategy` field on `DebounceConfig` and `defaultDebounceConfig` is unused beyond the test that checks it.

- [ ] Open `backend/src/debounce/strategies.ts`. Current full contents:
  ```typescript
  export type DebounceStrategy = "timer";

  export interface DebounceConfig {
    strategy: DebounceStrategy;
    delayMs: number; // default 600000 (10 minutes)
  }

  export const defaultDebounceConfig: DebounceConfig = {
    strategy: "timer",
    delayMs: 10 * 60 * 1000, // 10 minutes
  };
  ```

- [ ] Check all importers of `strategies.ts`:
  ```bash
  grep -r "from.*debounce/strategies" /home/ae/multi-agent-harness/backend/src
  ```
  Expected callers: `debounce/engine.ts` (imports `DebounceConfig`) and `__tests__/debounce.test.ts` (imports `defaultDebounceConfig`).

- [ ] Check if `engine.ts` uses `strategy`:
  ```bash
  grep -n "strategy" /home/ae/multi-agent-harness/backend/src/debounce/engine.ts
  ```
  In `engine.ts` line 21: `strategy: "timer"` appears inside the constructor's default config spread. This will need updating.

- [ ] Replace `backend/src/debounce/strategies.ts` with the simplified version:
  ```typescript
  export interface DebounceConfig {
    delayMs: number; // default 600000 (10 minutes)
  }
  ```
  (Remove `DebounceStrategy`, `strategy` field from interface, and the entire `defaultDebounceConfig` export.)

- [ ] Update `backend/src/debounce/engine.ts` constructor — remove the `strategy: "timer"` line from the default config spread:
  ```typescript
  // BEFORE:
  this.config = {
    strategy: "timer",
    delayMs: 10 * 60 * 1000, // 10 minutes default
    ...config,
  };

  // AFTER:
  this.config = {
    delayMs: 10 * 60 * 1000, // 10 minutes default
    ...config,
  };
  ```

- [ ] Update `backend/src/__tests__/debounce.test.ts` — remove the `defaultDebounceConfig` import and the `describe("defaultDebounceConfig", ...)` block (lines 3 and 217-225):
  ```typescript
  // DELETE this import line:
  import { defaultDebounceConfig } from "../debounce/strategies.js";

  // DELETE this entire describe block:
  describe("defaultDebounceConfig", () => {
    it("has timer strategy", () => {
      expect(defaultDebounceConfig.strategy).toBe("timer");
    });

    it("has 10 minute default delay", () => {
      expect(defaultDebounceConfig.delayMs).toBe(600000);
    });
  });
  ```

- [ ] Run `cd /home/ae/multi-agent-harness/backend && bun run test` and confirm all tests pass.

---

## Task 4 — Remove `preInitAgent` no-op function

`preInitAgent()` in `api/websocket.ts` (lines 46-50) only logs a string and does nothing. The comment inside confirms initialization is deferred to the first WS connection — the call in `projects.ts` adds no value.

- [ ] Verify `preInitAgent` is not referenced anywhere beyond its definition and the one call site:
  ```bash
  grep -rn "preInitAgent" /home/ae/multi-agent-harness/backend/src
  ```
  Expected: definition in `websocket.ts:46`, export in `websocket.ts`, import in `projects.ts:9`, call in `projects.ts:84`, mock in `__tests__/projects.test.ts:17`.

- [ ] Delete the function from `backend/src/api/websocket.ts` (lines 46-50):
  ```typescript
  // DELETE this block:
  export function preInitAgent(projectId: string): void {
    // Master agent initialization is deferred to the first WS connection
    // but we provide the hook for projects router.
    console.log(`[ws] preInitAgent(${projectId}): deferred to first WS connection`);
  }
  ```

- [ ] In `backend/src/api/projects.ts`, remove the import (line 9) and call site (line 84):
  ```typescript
  // DELETE this import line:
  import { preInitAgent } from "./websocket.js";

  // DELETE this call (inside router.post "/", after insertProject(project)):
  preInitAgent(project.id);
  ```

- [ ] Update `backend/src/__tests__/projects.test.ts` — remove the `preInitAgent` mock from the `vi.mock("../api/websocket.js", ...)` factory (line 17):
  ```typescript
  // BEFORE:
  vi.mock("../api/websocket.js", () => ({
    preInitAgent: vi.fn(),
    setupWebSocket: vi.fn(),
  }));

  // AFTER:
  vi.mock("../api/websocket.js", () => ({
    setupWebSocket: vi.fn(),
  }));
  ```

- [ ] Run `cd /home/ae/multi-agent-harness/backend && bun run test` and confirm all tests pass.

---

## Task 5 — Final verification

- [ ] Run the full backend test suite one more time to confirm all four changes together are clean:
  ```bash
  cd /home/ae/multi-agent-harness/backend && bun run test
  ```

- [ ] Run TypeScript type checking to confirm no type errors:
  ```bash
  cd /home/ae/multi-agent-harness/backend && bun run tsc --noEmit
  ```
  (If `tsc` is not in package.json scripts, run: `bunx tsc --noEmit`)

- [ ] Confirm the changed files are as expected:
  - `backend/src/orchestrator/taskDispatcher.ts` — no `activeTasks` field, no `getActiveTaskCount()`, `getSessionStatus` is sync
  - `backend/src/debounce/strategies.ts` — only `DebounceConfig` interface with `delayMs`
  - `backend/src/debounce/engine.ts` — constructor default config has no `strategy` key
  - `backend/src/api/websocket.ts` — no `preInitAgent` export
  - `backend/src/api/projects.ts` — no `preInitAgent` import or call
  - `backend/src/__tests__/projects.test.ts` — websocket mock has only `setupWebSocket`
  - `backend/src/__tests__/debounce.test.ts` — no `defaultDebounceConfig` import or tests
