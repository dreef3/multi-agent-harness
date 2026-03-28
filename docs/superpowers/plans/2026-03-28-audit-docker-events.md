# Docker Events-Based Container Completion Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 5-second polling loop in `waitForCompletion` with Docker's `die` event stream, reducing latency from up to 5 seconds to near-instant and eliminating unnecessary Docker API calls.

**Architecture:** The existing `watchContainerExit` function in `containerManager.ts` already wraps `docker.getEvents()` for the `die` event — `waitForCompletion` just needs to call it instead of polling `getContainerStatus`. A session-status poll is kept at 2-second cadence as a fallback for bridge-based completion signals. Both paths share a single `settle()` guard to prevent double-resolution.

**Tech Stack:** Express + TypeScript, Dockerode `getEvents()` stream (Node.js EventEmitter), better-sqlite3, Bun/Vitest test runner.

---

## Context

**File:** `backend/src/orchestrator/taskDispatcher.ts` lines 254–303
**File:** `backend/src/orchestrator/containerManager.ts` lines 134–139

The current `waitForCompletion` polls every 5 seconds, logging elapsed time on every tick. For a container that exits after 3 seconds, the caller waits up to 5 seconds before detecting it. The `watchContainerExit` function is already defined and tested but is not used by `waitForCompletion`.

`getSessionStatus` in `taskDispatcher.ts` is currently `async` (uses a dynamic `import()`), but after the dead-code cleanup plan (Plan 1 / `2026-03-28-phase0-dead-code-cleanup.md`) it becomes synchronous. The poll closure inside the new implementation must call it accordingly — read the current state of that method before implementing.

---

## Steps

- [ ] **Step 1 — Read current state of `getSessionStatus`**

  Read `backend/src/orchestrator/taskDispatcher.ts` lines 306–313 to confirm whether `getSessionStatus` is currently sync or async, since the implementation depends on this.

  ```typescript
  // Current (async, uses dynamic import):
  private async getSessionStatus(sessionId: string): Promise<AgentSession["status"] | null> {
    const { getAgentSession } = await import("../store/agents.js");
    const session = getAgentSession(sessionId);
    return session?.status ?? null;
  }
  ```

  If the dead-code plan has already been applied, `getSessionStatus` will be synchronous. Adjust the interval callback accordingly (no `await` needed).

- [ ] **Step 2 — Add error handling to `watchContainerExit`**

  Read `backend/src/orchestrator/containerManager.ts` lines 134–139. The current implementation does not handle stream errors or premature stream end.

  Replace the current `watchContainerExit` implementation with:

  ```typescript
  export async function watchContainerExit(
    docker: Dockerode,
    containerId: string,
    onExit: (exitCode: number) => void,
    onError?: (err: Error) => void
  ): Promise<void> {
    const events = await docker.getEvents({
      filters: JSON.stringify({ container: [containerId], event: ["die"] }),
    });
    const emitter = events as NodeJS.EventEmitter;
    emitter.on("data", (data: Buffer) => {
      const event = JSON.parse(data.toString()) as {
        Actor?: { Attributes?: { exitCode?: string } };
      };
      onExit(parseInt(event.Actor?.Attributes?.exitCode ?? "1", 10));
    });
    emitter.on("error", (err: Error) => {
      console.error(`[containerManager] watchContainerExit stream error for ${containerId}:`, err);
      onError?.(err);
    });
    emitter.on("end", () => {
      console.log(`[containerManager] watchContainerExit stream ended for ${containerId}`);
    });
  }
  ```

  The `onError` callback allows callers to decide whether to treat a stream error as a failure.

- [ ] **Step 3 — Rewrite `waitForCompletion` to use events**

  Replace the body of `waitForCompletion` in `backend/src/orchestrator/taskDispatcher.ts` (lines 254–304) with the event-driven implementation below.

  If `getSessionStatus` is still async (dynamic import not yet cleaned up), use `await` in the interval. If it has been made synchronous, remove the `async`/`await` from the `setInterval` callback.

  ```typescript
  private async waitForCompletion(
    docker: Dockerode,
    sessionId: string,
    containerId: string,
    timeoutMs = config.subAgentTimeoutMs
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        clearInterval(sessionPoll);
        resolve(result);
      };

      // Hard timeout fallback
      const timeoutHandle = setTimeout(() => {
        console.warn(
          `[taskDispatcher] waitForCompletion: timeout after ${timeoutMs}ms for container ${containerId}`
        );
        settle(false);
      }, timeoutMs);

      // Docker "die" event fires immediately when the container process exits
      void watchContainerExit(
        docker,
        containerId,
        (exitCode) => {
          console.log(
            `[taskDispatcher] Container ${containerId} exited with code ${exitCode}`
          );
          settle(exitCode === 0);
        },
        (_err) => {
          // Stream error — fall back to session poll and timeout; do not settle here
          console.warn(
            `[taskDispatcher] Docker events stream error for ${containerId}, relying on session poll`
          );
        }
      );

      // Session-status poll at 2-second cadence
      // Handles bridge-based completion (sub-agent calls /api/sessions/:id/status)
      // and acts as fallback if Docker events are unavailable (e.g., remote Docker socket)
      const sessionPoll = setInterval(async () => {
        const status = await this.getSessionStatus(sessionId);
        if (status === "completed") { settle(true); }
        else if (status === "failed")  { settle(false); }
      }, 2000);
    });
  }
  ```

  Also add the `watchContainerExit` import at the top of the file if it is not already imported:

  ```typescript
  import { watchContainerExit, ... } from "./containerManager.js";
  ```

  Check the existing import statement — `getContainerStatus` is imported from `containerManager.js`; add `watchContainerExit` to the same import.

- [ ] **Step 4 — Remove the now-unused `elapsedSec` logging**

  The old implementation logged `elapsedSec` on every poll tick. The new implementation logs only on exit or timeout. Confirm no other references to `elapsedSec` remain in the file after the rewrite.

- [ ] **Step 5 — Add `watchContainerExit` tests**

  Open `backend/src/__tests__/containerManager.test.ts`. Add these tests inside a new `describe("watchContainerExit", ...)` block after the existing `containerManager` describe:

  ```typescript
  import { EventEmitter } from "events";
  import { watchContainerExit } from "../orchestrator/containerManager.js";

  describe("watchContainerExit", () => {
    it("calls onExit with parsed exit code when die event fires", async () => {
      const emitter = new EventEmitter();
      const mockDocker = {
        getEvents: vi.fn().mockResolvedValue(emitter),
      };

      const onExit = vi.fn();
      await watchContainerExit(mockDocker as never, "container-abc", onExit);

      // Simulate Docker "die" event
      emitter.emit(
        "data",
        Buffer.from(
          JSON.stringify({ Actor: { Attributes: { exitCode: "0" } } })
        )
      );

      expect(onExit).toHaveBeenCalledWith(0);
    });

    it("defaults exitCode to 1 when Attributes are missing", async () => {
      const emitter = new EventEmitter();
      const mockDocker = { getEvents: vi.fn().mockResolvedValue(emitter) };
      const onExit = vi.fn();
      await watchContainerExit(mockDocker as never, "container-abc", onExit);

      emitter.emit("data", Buffer.from(JSON.stringify({})));
      expect(onExit).toHaveBeenCalledWith(1);
    });

    it("calls onError when the stream emits an error", async () => {
      const emitter = new EventEmitter();
      const mockDocker = { getEvents: vi.fn().mockResolvedValue(emitter) };
      const onError = vi.fn();
      await watchContainerExit(mockDocker as never, "container-abc", vi.fn(), onError);

      emitter.emit("error", new Error("stream closed unexpectedly"));
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });

    it("waitForCompletion resolves true immediately when container exits 0", async () => {
      // Import the class via dynamic import to pick up mocked containerManager
      vi.mock("../orchestrator/containerManager.js", async (importOriginal) => {
        const original = await importOriginal<typeof import("../orchestrator/containerManager.js")>();
        return {
          ...original,
          watchContainerExit: vi.fn().mockImplementation(
            (_docker, _id, onExit) => { onExit(0); return Promise.resolve(); }
          ),
          getContainerStatus: vi.fn().mockResolvedValue("running"),
        };
      });

      vi.mock("../store/agents.js", () => ({
        getAgentSession: vi.fn().mockReturnValue(null),
      }));

      const { TaskDispatcher } = await import("../orchestrator/taskDispatcher.js");
      const dispatcher = new TaskDispatcher();

      const start = Date.now();
      // @ts-expect-error — private method
      const result = await dispatcher.waitForCompletion({} as never, "sess-1", "container-abc", 30_000);
      const elapsed = Date.now() - start;

      expect(result).toBe(true);
      // Should resolve in well under 1 second, not after the 5-second poll interval
      expect(elapsed).toBeLessThan(1000);
    });
  });
  ```

  Note: The `waitForCompletion` integration test uses `vi.mock` with module factory. Because Vitest hoists `vi.mock` calls, this test should be in a separate `describe` block at the bottom of the file to avoid interfering with other tests that also mock `containerManager`.

- [ ] **Step 6 — Run tests**

  ```bash
  cd /home/ae/multi-agent-harness/backend && bun test --reporter=verbose 2>&1 | tail -40
  ```

  All existing `containerManager` tests must continue to pass. The new tests must pass as well.

- [ ] **Step 7 — Manual smoke test (optional, requires running Docker)**

  Start the harness stack (`docker compose up -d backend`) and trigger a task dispatch. Observe backend logs — you should see:
  ```
  [taskDispatcher] Container <id> exited with code 0
  ```
  within 1–2 seconds of the container stopping, rather than up to 5 seconds later.

---

## Notes

- `CapDrop: ["ALL"]` (Plan 14) does not affect `docker.getEvents()` — that is a Docker daemon API call from the host, not a capability inside the container.
- The `watchContainerExit` stream connects to the Docker daemon with a `filters` parameter scoped to a single container ID. If the container has already exited before `watchContainerExit` is called, Docker will not replay past events — the timeout handles that case.
- For remote Docker setups (TCP socket), events work the same way. For Docker Desktop on macOS in CI, events require the daemon to be fully running; CI environments should be fine.
- The `void` prefix on `watchContainerExit(...)` silences the floating promise lint warning; the function's promise only resolves after the event listener is registered, not after the event fires.
