import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../orchestrator/planningAgentManager.js", () => ({
  getPlanningAgentManager: vi.fn(() => ({ injectMessage: vi.fn() })),
}));
vi.mock("../api/websocket.js", () => ({
  broadcastStuckAgent: vi.fn(),
}));

import { resetHeartbeat, clearHeartbeat } from "../orchestrator/heartbeatMonitor.js";
import { getPlanningAgentManager } from "../orchestrator/planningAgentManager.js";
import { broadcastStuckAgent } from "../api/websocket.js";

describe("heartbeatMonitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires injectMessage and broadcastStuckAgent after 4 minutes", () => {
    const mockInject = vi.fn();
    (getPlanningAgentManager as ReturnType<typeof vi.fn>).mockReturnValue({ injectMessage: mockInject });

    resetHeartbeat("session-1", "proj-1", "Build auth module");
    vi.advanceTimersByTime(4 * 60 * 1000);

    expect(mockInject).toHaveBeenCalledOnce();
    expect(mockInject.mock.calls[0][0]).toBe("proj-1");
    expect(mockInject.mock.calls[0][1]).toContain("Build auth module");
    expect(broadcastStuckAgent).toHaveBeenCalledWith("proj-1", "session-1");
  });

  it("does not fire if clearHeartbeat called first", () => {
    const mockInject = vi.fn();
    (getPlanningAgentManager as ReturnType<typeof vi.fn>).mockReturnValue({ injectMessage: mockInject });

    resetHeartbeat("session-2", "proj-1", "Some task");
    clearHeartbeat("session-2");
    vi.advanceTimersByTime(4 * 60 * 1000);

    expect(mockInject).not.toHaveBeenCalled();
    expect(broadcastStuckAgent).not.toHaveBeenCalled();
  });

  it("resetting before timeout cancels the previous timer", () => {
    const mockInject = vi.fn();
    (getPlanningAgentManager as ReturnType<typeof vi.fn>).mockReturnValue({ injectMessage: mockInject });

    resetHeartbeat("session-3", "proj-1", "Task");
    vi.advanceTimersByTime(3 * 60 * 1000);
    resetHeartbeat("session-3", "proj-1", "Task"); // reset timer
    vi.advanceTimersByTime(3 * 60 * 1000); // total 6 min from first, only 3 from second

    expect(mockInject).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60 * 1000 + 100); // now 4+ min from second reset
    expect(mockInject).toHaveBeenCalledOnce();
  });
});
