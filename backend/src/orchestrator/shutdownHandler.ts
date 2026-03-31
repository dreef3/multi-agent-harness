import type { Server } from "http";

export interface ShutdownDeps {
  server: Server;
  stopPolling: () => void;
  debounceEngine: { shutdown(): void };
  drainTimeoutMs?: number;
}

/**
 * Creates a graceful shutdown handler that:
 * 1. Stops the polling interval
 * 2. Cancels all pending debounce timers
 * 3. Closes the HTTP server (stops accepting new connections)
 * 4. Forces process.exit(0) after drainTimeoutMs (default 15s) if not done
 *
 * Returns a promise that resolves when the server is fully closed.
 */
export function createShutdownHandler({
  server,
  stopPolling,
  debounceEngine,
  drainTimeoutMs = 15_000,
}: ShutdownDeps): (signal: string) => Promise<void> {
  return function shutdown(signal: string): Promise<void> {
    console.log(`[shutdown] ${signal} received — shutting down gracefully`);

    // 1. Stop polling so no new work is enqueued
    stopPolling();

    // 2. Cancel all pending debounce timers
    debounceEngine.shutdown();

    // 3. Close the HTTP server; resolve when done or force-exit after timeout
    return new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) console.error("[shutdown] HTTP server close error:", err);
        else console.log("[shutdown] HTTP server closed");
        resolve();
      });

      // Force exit if in-flight requests don't drain in time
      setTimeout(() => {
        console.log("[shutdown] Timeout reached, forcing exit");
        process.exit(0);
      }, drainTimeoutMs).unref();
    });
  };
}
