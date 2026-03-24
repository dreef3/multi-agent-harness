import { describe, it, expect } from "vitest";

// Tests for polling.ts
// The polling module has been updated to use approval-based detection
// instead of LGTM comment detection.
// The approval detection is tested through connector tests (getApprovals method).

describe("polling module", () => {
  it("can be imported without errors", async () => {
    // This verifies the module compiles and imports correctly
    const module = await import("../polling.js");
    expect(module).toBeDefined();
    expect(typeof module.startPolling).toBe("function");
    expect(typeof module.stopPolling).toBe("function");
    expect(typeof module.getPollingStatus).toBe("function");
  });
});
