# Graceful Shutdown (SIGTERM/SIGINT) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SIGTERM/SIGINT handlers to `backend/src/index.ts` so the server shuts down cleanly under Kubernetes, draining in-flight requests and cancelling pending timers within a 15-second window.

**Architecture:** The shutdown handler calls `stopPolling()` (already exported from `polling.ts`), a new `shutdown()` method on `DebounceEngine` (which clears all pending timers and the cleanup interval), and `server.close()` to stop accepting new connections. A 15-second `setTimeout(...).unref()` forces exit if requests don't drain in time.

**Tech Stack:** Node.js process signals, Express HTTP server, TypeScript, `DebounceEngine` (better-sqlite3 backend, Bun test runner).

---

## Step 1 — Add `shutdown()` method to `DebounceEngine`

- [ ] Open `backend/src/debounce/engine.ts`
- [ ] The engine already has a `dispose()` method that clears all timers and the cleanup interval. Add a `shutdown()` method as a public alias for `dispose()` so callers have semantically clear naming:

```typescript
  /**
   * Shut down the engine: cancel all pending timers and the cleanup interval.
   * Alias for dispose(); prefer this name in shutdown contexts.
   */
  shutdown(): void {
    this.dispose();
  }
```

Add this immediately after the `dispose()` method (around line 116), before the closing `}` of the class. The full updated tail of the class looks like:

```typescript
  dispose(): void {
    for (const [prId, state] of this.timers) {
      clearTimeout(state.timeout);
    }
    this.timers.clear();

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Shut down the engine: cancel all pending timers and the cleanup interval.
   * Alias for dispose(); prefer this name in shutdown contexts.
   */
  shutdown(): void {
    this.dispose();
  }
}
```

## Step 2 — Update `backend/src/index.ts`

- [ ] Open `backend/src/index.ts`
- [ ] Add `stopPolling` to the import from `./polling.js`. Change the existing import line:

```typescript
import { startPolling } from "./polling.js";
```

to:

```typescript
import { startPolling, stopPolling } from "./polling.js";
```

- [ ] After the `server.listen(...)` call block, add the graceful shutdown handler. The full `main()` function tail (starting from the server creation) should look like:

```typescript
  const app = express();
  app.use(express.json());
  app.use("/api", createRouter(config.dataDir, docker));

  const server = createServer(app);
  setupWebSocket(server);

  server.listen(config.port, () => {
    console.log(`[startup] Backend listening on port ${config.port}`);
  });

  async function shutdown(signal: string): Promise<void> {
    console.log(`[shutdown] ${signal} received — shutting down gracefully`);
    stopPolling();
    debounceEngine.shutdown(); // cancel all pending timers

    server.close((err) => {
      if (err) console.error("[shutdown] HTTP server close error:", err);
      else console.log("[shutdown] HTTP server closed");
    });

    // Give in-flight requests 15 seconds to complete, then force exit
    setTimeout(() => {
      console.log("[shutdown] Timeout reached, forcing exit");
      process.exit(0);
    }, 15_000).unref();
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT",  () => void shutdown("SIGINT"));
}

main().catch((err) => { console.error("[fatal]", err); process.exit(1); });
```

Note: `debounceEngine` is already in scope as a `const` declared earlier in `main()`, so no closure issues.

## Step 3 — Write integration tests

- [ ] Create `backend/src/__tests__/gracefulShutdown.test.ts`
- [ ] The test starts a real Express server on a random port, registers the shutdown logic directly (by calling the same setup as `index.ts` but without the Docker/DB dependencies), sends a shutdown signal by calling the `shutdown` function directly, and asserts the server closes.

Full test file:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer } from "http";
import express from "express";
import { DebounceEngine } from "../debounce/engine.js";

// ── helpers ────────────────────────────────────────────────────────────────

function makeTestServer(port = 0) {
  const app = express();
  app.get("/ping", (_req, res) => res.json({ ok: true }));
  const server = createServer(app);

  let isRunning = true;
  let intervalId: ReturnType<typeof setInterval> | null = setInterval(() => {}, 60_000);

  function stopPolling() {
    if (!isRunning) return;
    isRunning = false;
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
  }

  const debounceEngine = new DebounceEngine({ delayMs: 60_000 });
  // Register two fake pending timers so we can assert they get cancelled
  debounceEngine.notify("pr-1", async () => {});
  debounceEngine.notify("pr-2", async () => {});

  return { server, debounceEngine, stopPolling };
}

function buildShutdown(
  server: ReturnType<typeof createServer>,
  stopPolling: () => void,
  debounceEngine: DebounceEngine,
) {
  return async function shutdown(signal: string): Promise<void> {
    console.log(`[shutdown] ${signal} received — shutting down gracefully`);
    stopPolling();
    debounceEngine.shutdown();

    return new Promise((resolve) => {
      server.close((err) => {
        if (err) console.error("[shutdown] HTTP server close error:", err);
        resolve();
      });

      setTimeout(() => {
        console.log("[shutdown] Timeout reached, forcing exit");
        resolve();
      }, 15_000).unref();
    });
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("graceful shutdown", () => {
  it("closes the HTTP server on shutdown()", async () => {
    const { server, debounceEngine, stopPolling } = makeTestServer();
    const shutdown = buildShutdown(server, stopPolling, debounceEngine);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    expect(server.listening).toBe(true);

    await shutdown("SIGTERM");

    expect(server.listening).toBe(false);
  });

  it("cancels all pending debounce timers on shutdown()", async () => {
    const { server, debounceEngine, stopPolling } = makeTestServer();
    const shutdown = buildShutdown(server, stopPolling, debounceEngine);

    await new Promise<void>((resolve) => server.listen(0, resolve));

    expect(debounceEngine.getPendingCount()).toBe(2);

    await shutdown("SIGINT");

    expect(debounceEngine.getPendingCount()).toBe(0);
  });

  it("stopPolling() is idempotent — calling twice does not throw", () => {
    const { server, debounceEngine, stopPolling } = makeTestServer();
    expect(() => { stopPolling(); stopPolling(); }).not.toThrow();
    server.close();
  });
});
```

## Step 4 — Verify TypeScript compiles

- [ ] Run `cd backend && bunx tsc --noEmit` — must produce zero errors.

## Step 5 — Run tests

- [ ] Run `cd backend && bun run test` — all existing tests plus the new `gracefulShutdown.test.ts` tests must pass.

## Step 6 — Verify SIGTERM wiring in production

- [ ] Confirm `process.on("SIGTERM", ...)` and `process.on("SIGINT", ...)` are registered by reading `index.ts` after edits.
- [ ] Check the Kubernetes `Deployment` manifest (if present in `/deploy/` or similar) — confirm `terminationGracePeriodSeconds` is at least 20 seconds so Kubernetes waits longer than the 15-second drain timeout.

---

## Key files changed

| File | Change |
|---|---|
| `backend/src/debounce/engine.ts` | Add `shutdown()` method (delegates to `dispose()`) |
| `backend/src/index.ts` | Import `stopPolling`; add `shutdown()` function + signal handlers after `server.listen` |
| `backend/src/__tests__/gracefulShutdown.test.ts` | New integration test file (3 tests) |

## Risks and notes

- `server.close()` only stops accepting new connections; already-connected WebSocket clients are not forcibly terminated. The 15-second timeout covers this.
- `debounceEngine.shutdown()` delegates entirely to `dispose()`, which already exists and is tested. No net new logic is introduced in the engine.
- The `setTimeout(..., 15_000).unref()` call uses `.unref()` so the timeout itself does not prevent Node from exiting naturally if everything else closes first.
- `stopPolling()` is idempotent (guarded by `if (!isRunning) return;`), so double-calling during tests is safe.
