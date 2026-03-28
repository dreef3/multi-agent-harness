import { describe, test, expect, beforeEach, vi } from "vitest";
import { TraceBuilder, getOrCreateTrace, getTrace, clearTrace } from "./traceBuilder.js";

describe("TraceBuilder", () => {
  let tb: TraceBuilder;

  beforeEach(() => {
    tb = new TraceBuilder("proj-1", "Test Project");
  });

  test("initialises with correct version and project fields", () => {
    const t = tb.toJSON();
    expect(t.version).toBe("1.0");
    expect(t.project.id).toBe("proj-1");
    expect(t.project.name).toBe("Test Project");
    expect(t.project.status).toBe("brainstorming");
    expect(t.requirements).toHaveLength(0);
    expect(t.tasks).toHaveLength(0);
    expect(t.pullRequests).toHaveLength(0);
  });

  test("setProjectStatus updates status and updatedAt", () => {
    vi.useFakeTimers();
    const before = tb.toJSON().updatedAt;
    vi.advanceTimersByTime(1);
    tb.setProjectStatus("executing");
    const t = tb.toJSON();
    expect(t.project.status).toBe("executing");
    expect(t.updatedAt).not.toBe(before);
    vi.useRealTimers();
  });

  test("setSpecApproved sets specApprovedAt and specApprovedBy", () => {
    const ts = new Date().toISOString();
    tb.setSpecApproved(ts, "alice");
    const t = tb.toJSON();
    expect(t.project.specApprovedAt).toBe(ts);
    expect(t.project.specApprovedBy).toBe("alice");
  });

  test("setPlanApproved sets planApprovedAt", () => {
    const ts = new Date().toISOString();
    tb.setPlanApproved(ts);
    expect(tb.toJSON().project.planApprovedAt).toBe(ts);
  });

  test("setRequirements stores requirements", () => {
    tb.setRequirements([{ id: "r-1", summary: "Feature A" }]);
    expect(tb.toJSON().requirements).toHaveLength(1);
    expect(tb.toJSON().requirements[0].id).toBe("r-1");
  });

  test("upsertTask adds new task with pending status", () => {
    tb.upsertTask("task-1", "Implement feature X", ["req-1"]);
    const t = tb.toJSON();
    expect(t.tasks).toHaveLength(1);
    expect(t.tasks[0].id).toBe("task-1");
    expect(t.tasks[0].status).toBe("pending");
    expect(t.tasks[0].requirementIds).toEqual(["req-1"]);
  });

  test("upsertTask does not duplicate on second call", () => {
    tb.upsertTask("task-1", "Implement feature X");
    tb.upsertTask("task-1", "Implement feature X");
    expect(tb.toJSON().tasks).toHaveLength(1);
  });

  test("setTaskStatus updates existing task status", () => {
    tb.upsertTask("task-1", "Desc");
    tb.setTaskStatus("task-1", "executing");
    expect(tb.toJSON().tasks[0].status).toBe("executing");
  });

  test("setTaskStatus is a no-op for unknown task", () => {
    tb.setTaskStatus("unknown", "executing");
    expect(tb.toJSON().tasks).toHaveLength(0);
  });

  test("recordTaskAttempt adds attempt entry", () => {
    tb.upsertTask("task-1", "Desc");
    tb.recordTaskAttempt("task-1", 1);
    const task = tb.toJSON().tasks[0];
    expect(task.attempts).toHaveLength(1);
    expect(task.attempts[0].attemptNumber).toBe(1);
    expect(task.attempts[0].startedAt).toBeDefined();
  });

  test("recordTaskAttempt does not duplicate", () => {
    tb.upsertTask("task-1", "Desc");
    tb.recordTaskAttempt("task-1", 1);
    tb.recordTaskAttempt("task-1", 1);
    expect(tb.toJSON().tasks[0].attempts).toHaveLength(1);
  });

  test("recordTaskComplete marks task completed and sets completedAt", () => {
    tb.upsertTask("task-1", "Desc");
    tb.recordTaskAttempt("task-1", 1);
    tb.recordTaskComplete("task-1");
    const task = tb.toJSON().tasks[0];
    expect(task.status).toBe("completed");
    expect(task.attempts[0].completedAt).toBeDefined();
  });

  test("recordTaskFailed marks task failed and sets completedAt", () => {
    tb.upsertTask("task-1", "Desc");
    tb.recordTaskAttempt("task-1", 1);
    tb.recordTaskFailed("task-1");
    const task = tb.toJSON().tasks[0];
    expect(task.status).toBe("failed");
    expect(task.attempts[0].completedAt).toBeDefined();
  });

  test("setPlanningPr stores url and number", () => {
    tb.setPlanningPr("https://github.com/org/repo/pull/42", 42);
    const t = tb.toJSON();
    expect(t.planningPr?.url).toBe("https://github.com/org/repo/pull/42");
    expect(t.planningPr?.number).toBe(42);
  });

  test("recordCiResult sets ci on the matching attempt", () => {
    tb.upsertTask("task-1", "Desc");
    tb.recordTaskAttempt("task-1", 1);
    tb.recordCiResult("task-1", 1, { state: "success", checks: [{ name: "tests", state: "success" }] });
    const attempt = tb.toJSON().tasks[0].attempts[0];
    expect(attempt.ci?.state).toBe("success");
  });

  test("upsertPullRequest adds new PR", () => {
    tb.upsertPullRequest({ taskIds: ["t1"], url: "https://gh/pr/1", branch: "feat/x", state: "open" });
    expect(tb.toJSON().pullRequests).toHaveLength(1);
  });

  test("upsertPullRequest updates existing by url", () => {
    tb.upsertPullRequest({ taskIds: ["t1"], url: "https://gh/pr/1", branch: "feat/x", state: "open" });
    tb.upsertPullRequest({ taskIds: ["t1"], url: "https://gh/pr/1", branch: "feat/x", state: "merged" });
    const t = tb.toJSON();
    expect(t.pullRequests).toHaveLength(1);
    expect(t.pullRequests[0].state).toBe("merged");
  });

  test("toJSON returns a deep clone (mutations do not affect trace)", () => {
    tb.upsertTask("task-1", "Desc");
    const a = tb.toJSON();
    const b = tb.toJSON();
    expect(a).not.toBe(b);
    a.tasks[0].status = "failed";
    expect(tb.toJSON().tasks[0].status).toBe("pending");
  });

  test("method chaining works (returns this)", () => {
    const result = tb.setProjectStatus("executing").upsertTask("t", "d").setSpecApproved("ts");
    expect(result).toBe(tb);
  });
});

describe("getOrCreateTrace registry", () => {
  beforeEach(() => {
    clearTrace("proj-reg");
  });

  test("creates new TraceBuilder on first call", () => {
    const tb = getOrCreateTrace("proj-reg", "Reg Project");
    expect(tb).toBeInstanceOf(TraceBuilder);
  });

  test("returns same instance on second call", () => {
    const a = getOrCreateTrace("proj-reg", "Reg Project");
    const b = getOrCreateTrace("proj-reg", "Reg Project");
    expect(a).toBe(b);
  });

  test("getTrace returns undefined for unknown project", () => {
    expect(getTrace("nonexistent-proj-xyz")).toBeUndefined();
  });

  test("clearTrace removes the instance", () => {
    getOrCreateTrace("proj-reg", "Reg Project");
    clearTrace("proj-reg");
    expect(getTrace("proj-reg")).toBeUndefined();
  });
});
