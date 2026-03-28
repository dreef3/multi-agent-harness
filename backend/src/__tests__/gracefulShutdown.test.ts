import { describe, it, expect } from "vitest";
import { createServer } from "http";
import express from "express";
import { DebounceEngine } from "../debounce/engine.js";
import { createShutdownHandler } from "../orchestrator/shutdownHandler.js";

function makeTestServer() {
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
  debounceEngine.notify("pr-1", async () => {});
  debounceEngine.notify("pr-2", async () => {});

  return { server, debounceEngine, stopPolling, getIsRunning: () => isRunning };
}

describe("graceful shutdown", () => {
  it("closes the HTTP server on shutdown()", async () => {
    const { server, debounceEngine, stopPolling } = makeTestServer();
    const shutdown = createShutdownHandler({ server, stopPolling, debounceEngine, drainTimeoutMs: 5_000 });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    expect(server.listening).toBe(true);

    await shutdown("SIGTERM");

    expect(server.listening).toBe(false);
  });

  it("cancels all pending debounce timers on shutdown()", async () => {
    const { server, debounceEngine, stopPolling } = makeTestServer();
    const shutdown = createShutdownHandler({ server, stopPolling, debounceEngine, drainTimeoutMs: 5_000 });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    expect(debounceEngine.getPendingCount()).toBe(2);

    await shutdown("SIGINT");

    expect(debounceEngine.getPendingCount()).toBe(0);
  });

  it("stopPolling() is called and becomes idempotent after shutdown", async () => {
    const { server, debounceEngine, stopPolling, getIsRunning } = makeTestServer();
    const shutdown = createShutdownHandler({ server, stopPolling, debounceEngine, drainTimeoutMs: 5_000 });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    expect(getIsRunning()).toBe(true);

    await shutdown("SIGTERM");

    expect(getIsRunning()).toBe(false);
    // Calling again does not throw (idempotency)
    expect(() => stopPolling()).not.toThrow();
  });
});
