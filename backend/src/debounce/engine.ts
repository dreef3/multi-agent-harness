import type { DebounceConfig } from "./strategies.js";

export type OnFireCallback = (prId: string) => void | Promise<void>;

interface DebounceState {
  timeout: ReturnType<typeof setTimeout>;
  callback: OnFireCallback;
  createdAt: number;
}

// Maximum lifetime for a debounce timer (24 hours)
const MAX_TIMER_LIFETIME_MS = 24 * 60 * 60 * 1000;

export class DebounceEngine {
  private timers = new Map<string, DebounceState>();
  private config: DebounceConfig;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<DebounceConfig>) {
    this.config = {
      strategy: "timer",
      delayMs: 10 * 60 * 1000, // 10 minutes default
      ...config,
    };

    // Start cleanup interval for stale timers
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleTimers();
    }, 60 * 60 * 1000); // Check every hour
  }

  /**
   * Notify the debounce engine of activity on a PR.
   * Resets the timer if one exists, or creates a new one.
   * The callback will be invoked after the delay if no further notifications occur.
   */
  notify(prId: string, onFire: OnFireCallback): void {
    // Cancel any existing timer for this PR
    this.cancel(prId);

    // Create new timer
    const timeout = setTimeout(() => {
      this.timers.delete(prId);
      void onFire(prId);
    }, this.config.delayMs);

    this.timers.set(prId, { timeout, callback: onFire, createdAt: Date.now() });
  }

  /**
   * Clean up timers that have exceeded the maximum lifetime.
   * This prevents memory leaks from stale timers.
   */
  private cleanupStaleTimers(): void {
    const now = Date.now();
    for (const [prId, state] of this.timers) {
      if (now - state.createdAt > MAX_TIMER_LIFETIME_MS) {
        clearTimeout(state.timeout);
        this.timers.delete(prId);
        console.log(`[debounce] Cleaned up stale timer for PR ${prId}`);
      }
    }
  }

  /**
   * Trigger immediate execution for a PR.
   * Cancels the pending timer and invokes the callback immediately.
   */
  triggerNow(prId: string): void {
    const state = this.timers.get(prId);
    if (state) {
      clearTimeout(state.timeout);
      this.timers.delete(prId);
      void state.callback(prId);
    }
  }

  /**
   * Cancel the pending timer for a PR.
   */
  cancel(prId: string): void {
    const state = this.timers.get(prId);
    if (state) {
      clearTimeout(state.timeout);
      this.timers.delete(prId);
    }
  }

  /**
   * Check if a PR has a pending debounce timer.
   */
  hasPending(prId: string): boolean {
    return this.timers.has(prId);
  }

  /**
   * Get the number of pending debounce timers.
   */
  getPendingCount(): number {
    return this.timers.size;
  }

  /**
   * Shut down the engine: cancel all pending timers and the cleanup interval.
   * Alias for dispose(); prefer this name in shutdown contexts.
   */
  shutdown(): void {
    this.dispose();
  }

  /**
   * Dispose of all timers and clean up resources.
   */
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
}
