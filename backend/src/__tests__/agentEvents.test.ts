import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { initDb } from "../store/db.js";
import { appendEvent, getEvents, clearEvents } from "../store/agentEvents.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-events-test-"));
  await initDb(tmpDir);
  clearEvents("session-1");
  clearEvents("session-2");
  clearEvents("master-proj-1");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("agentEvents store", () => {
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

  it("stores planning agent tool_call events under master- prefix", () => {
    appendEvent("master-proj-1", {
      type: "tool_call",
      payload: { toolName: "dispatch_tasks", args: { tasks: [] } },
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const events = getEvents("master-proj-1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_call");
    expect(events[0].payload.toolName).toBe("dispatch_tasks");
  });
});
