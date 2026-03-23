import { describe, it, expect, beforeEach } from "vitest";
import { appendEvent, getEvents, clearEvents } from "../store/agentEvents.js";

describe("agentEvents store", () => {
  beforeEach(() => {
    clearEvents("session-1");
    clearEvents("session-2");
  });

  it("returns empty array for unknown session", () => {
    expect(getEvents("session-1")).toEqual([]);
  });

  it("appends and retrieves events in order", () => {
    appendEvent("session-1", { type: "text", payload: { text: "hello" }, timestamp: "t1" });
    appendEvent("session-1", { type: "tool_call", payload: { toolName: "bash" }, timestamp: "t2" });
    expect(getEvents("session-1")).toHaveLength(2);
    expect(getEvents("session-1")[0].type).toBe("text");
    expect(getEvents("session-1")[1].type).toBe("tool_call");
  });

  it("isolates events between sessions", () => {
    appendEvent("session-1", { type: "text", payload: {}, timestamp: "t1" });
    appendEvent("session-2", { type: "tool_call", payload: {}, timestamp: "t2" });
    expect(getEvents("session-1")).toHaveLength(1);
    expect(getEvents("session-2")).toHaveLength(1);
  });

  it("clearEvents removes all events for session", () => {
    appendEvent("session-1", { type: "text", payload: {}, timestamp: "t1" });
    clearEvents("session-1");
    expect(getEvents("session-1")).toEqual([]);
  });
});
