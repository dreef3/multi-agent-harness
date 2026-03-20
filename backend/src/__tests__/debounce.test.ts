import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DebounceEngine } from "../debounce/engine.js";
import { defaultDebounceConfig } from "../debounce/strategies.js";

describe("DebounceEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("uses default config when none provided", () => {
      const engine = new DebounceEngine();
      expect(engine.getPendingCount()).toBe(0);
    });

    it("accepts custom delayMs", () => {
      const engine = new DebounceEngine({ delayMs: 5000 });
      expect(engine.getPendingCount()).toBe(0);
    });
  });

  describe("notify", () => {
    it("creates a timer that fires after delay", async () => {
      const engine = new DebounceEngine({ delayMs: 1000 });
      const callback = vi.fn();

      engine.notify("pr-123", callback);
      expect(engine.hasPending("pr-123")).toBe(true);
      expect(callback).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);

      expect(callback).toHaveBeenCalledWith("pr-123");
      expect(engine.hasPending("pr-123")).toBe(false);
    });

    it("resets timer on subsequent notify calls", async () => {
      const engine = new DebounceEngine({ delayMs: 1000 });
      const callback = vi.fn();

      engine.notify("pr-123", callback);
      vi.advanceTimersByTime(500);
      expect(callback).not.toHaveBeenCalled();

      // Reset the timer
      engine.notify("pr-123", callback);
      vi.advanceTimersByTime(500);
      expect(callback).not.toHaveBeenCalled();

      // Now it should fire after full delay
      vi.advanceTimersByTime(500);
      expect(callback).toHaveBeenCalledWith("pr-123");
    });

    it("handles multiple PRs independently", async () => {
      const engine = new DebounceEngine({ delayMs: 1000 });
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      engine.notify("pr-123", callback1);
      engine.notify("pr-456", callback2);

      expect(engine.getPendingCount()).toBe(2);

      vi.advanceTimersByTime(1000);

      expect(callback1).toHaveBeenCalledWith("pr-123");
      expect(callback2).toHaveBeenCalledWith("pr-456");
      expect(engine.getPendingCount()).toBe(0);
    });

    it("supports async callbacks", async () => {
      const engine = new DebounceEngine({ delayMs: 1000 });
      const callback = vi.fn().mockResolvedValue(undefined);

      engine.notify("pr-123", callback);
      vi.advanceTimersByTime(1000);

      expect(callback).toHaveBeenCalledWith("pr-123");
    });
  });

  describe("triggerNow", () => {
    it("immediately fires the callback", () => {
      const engine = new DebounceEngine({ delayMs: 1000 });
      const callback = vi.fn();

      engine.notify("pr-123", callback);
      expect(callback).not.toHaveBeenCalled();

      engine.triggerNow("pr-123");

      expect(callback).toHaveBeenCalledWith("pr-123");
      expect(engine.hasPending("pr-123")).toBe(false);
    });

    it("does nothing if no pending timer", () => {
      const engine = new DebounceEngine({ delayMs: 1000 });
      const callback = vi.fn();

      engine.triggerNow("pr-123");
      expect(callback).not.toHaveBeenCalled();
    });

    it("cancels the pending timer", () => {
      const engine = new DebounceEngine({ delayMs: 1000 });
      const callback = vi.fn();

      engine.notify("pr-123", callback);
      engine.triggerNow("pr-123");

      // Timer should not fire again
      vi.advanceTimersByTime(2000);
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe("cancel", () => {
    it("cancels the pending timer without firing", () => {
      const engine = new DebounceEngine({ delayMs: 1000 });
      const callback = vi.fn();

      engine.notify("pr-123", callback);
      expect(engine.hasPending("pr-123")).toBe(true);

      engine.cancel("pr-123");

      expect(engine.hasPending("pr-123")).toBe(false);
      vi.advanceTimersByTime(2000);
      expect(callback).not.toHaveBeenCalled();
    });

    it("does nothing if no pending timer", () => {
      const engine = new DebounceEngine({ delayMs: 1000 });
      engine.cancel("pr-123"); // Should not throw
      expect(engine.getPendingCount()).toBe(0);
    });
  });

  describe("hasPending", () => {
    it("returns true for pending PR", () => {
      const engine = new DebounceEngine({ delayMs: 1000 });
      engine.notify("pr-123", vi.fn());
      expect(engine.hasPending("pr-123")).toBe(true);
    });

    it("returns false for non-pending PR", () => {
      const engine = new DebounceEngine({ delayMs: 1000 });
      expect(engine.hasPending("pr-123")).toBe(false);
    });

    it("returns false after timer fires", () => {
      const engine = new DebounceEngine({ delayMs: 1000 });
      engine.notify("pr-123", vi.fn());
      vi.advanceTimersByTime(1000);
      expect(engine.hasPending("pr-123")).toBe(false);
    });
  });

  describe("getPendingCount", () => {
    it("returns 0 initially", () => {
      const engine = new DebounceEngine();
      expect(engine.getPendingCount()).toBe(0);
    });

    it("returns correct count with multiple timers", () => {
      const engine = new DebounceEngine({ delayMs: 1000 });
      engine.notify("pr-1", vi.fn());
      engine.notify("pr-2", vi.fn());
      engine.notify("pr-3", vi.fn());
      expect(engine.getPendingCount()).toBe(3);
    });

    it("decrements as timers fire", () => {
      const engine = new DebounceEngine({ delayMs: 1000 });
      engine.notify("pr-1", vi.fn());
      engine.notify("pr-2", vi.fn());

      vi.advanceTimersByTime(1000);
      expect(engine.getPendingCount()).toBe(0);
    });
  });

  describe("dispose", () => {
    it("clears all pending timers", () => {
      const engine = new DebounceEngine({ delayMs: 1000 });
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      engine.notify("pr-1", callback1);
      engine.notify("pr-2", callback2);
      expect(engine.getPendingCount()).toBe(2);

      engine.dispose();

      expect(engine.getPendingCount()).toBe(0);
      vi.advanceTimersByTime(2000);
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();
    });

    it("is safe to call multiple times", () => {
      const engine = new DebounceEngine({ delayMs: 1000 });
      engine.notify("pr-1", vi.fn());

      engine.dispose();
      engine.dispose(); // Should not throw
      expect(engine.getPendingCount()).toBe(0);
    });
  });
});

describe("defaultDebounceConfig", () => {
  it("has timer strategy", () => {
    expect(defaultDebounceConfig.strategy).toBe("timer");
  });

  it("has 10 minute default delay", () => {
    expect(defaultDebounceConfig.delayMs).toBe(600000);
  });
});
