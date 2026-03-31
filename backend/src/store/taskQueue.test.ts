import { describe, test, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { initDb } from "./db.js";
import {
  enqueueTask,
  dequeueNextTask,
  markTaskDispatching,
  removeFromQueue,
  listQueuedTasks,
  listAllQueueEntries,
  resetStaleDispatchingEntries,
  removeTerminalTasks,
} from "./taskQueue.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  await initDb(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("enqueueTask", () => {
  test("inserts a new queue entry with queued status", () => {
    enqueueTask("task-1", "proj-1", 0);
    const all = listAllQueueEntries();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("task-1");
    expect(all[0].projectId).toBe("proj-1");
    expect(all[0].status).toBe("queued");
  });

  test("is idempotent — duplicate insert is ignored", () => {
    enqueueTask("task-1", "proj-1", 0);
    enqueueTask("task-1", "proj-1", 0);
    expect(listAllQueueEntries()).toHaveLength(1);
  });

  test("stores the provided priority", () => {
    enqueueTask("task-1", "proj-1", 5);
    expect(listAllQueueEntries()[0].priority).toBe(5);
  });
});

describe("dequeueNextTask", () => {
  test("returns null when queue is empty", () => {
    expect(dequeueNextTask()).toBeNull();
  });

  test("returns highest priority task first", () => {
    enqueueTask("task-low", "proj-1", 0);
    enqueueTask("task-high", "proj-1", 1);
    expect(dequeueNextTask()?.id).toBe("task-high");
  });

  test("returns oldest task when priorities are equal", async () => {
    enqueueTask("task-older", "proj-1", 0);
    await new Promise(r => setTimeout(r, 5));
    enqueueTask("task-newer", "proj-1", 0);
    expect(dequeueNextTask()?.id).toBe("task-older");
  });

  test("does not return dispatching tasks", () => {
    enqueueTask("task-1", "proj-1", 0);
    markTaskDispatching("task-1");
    expect(dequeueNextTask()).toBeNull();
  });

  test("returns projectId correctly", () => {
    enqueueTask("task-1", "proj-abc", 0);
    expect(dequeueNextTask()?.projectId).toBe("proj-abc");
  });
});

describe("markTaskDispatching", () => {
  test("changes task status to dispatching", () => {
    enqueueTask("task-1", "proj-1", 0);
    markTaskDispatching("task-1");
    expect(listAllQueueEntries()[0].status).toBe("dispatching");
  });

  test("is safe to call on non-existent task", () => {
    expect(() => markTaskDispatching("nonexistent")).not.toThrow();
  });
});

describe("removeFromQueue", () => {
  test("deletes the entry", () => {
    enqueueTask("task-1", "proj-1", 0);
    removeFromQueue("task-1");
    expect(listAllQueueEntries()).toHaveLength(0);
  });

  test("is safe to call on non-existent entry", () => {
    expect(() => removeFromQueue("nonexistent")).not.toThrow();
  });

  test("only removes the specified task", () => {
    enqueueTask("task-1", "proj-1", 0);
    enqueueTask("task-2", "proj-1", 0);
    removeFromQueue("task-1");
    const all = listAllQueueEntries();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("task-2");
  });
});

describe("listQueuedTasks", () => {
  test("returns empty array when queue is empty", () => {
    expect(listQueuedTasks()).toEqual([]);
  });

  test("only returns queued status tasks", () => {
    enqueueTask("task-1", "proj-1", 0);
    enqueueTask("task-2", "proj-1", 0);
    markTaskDispatching("task-2");
    const queued = listQueuedTasks();
    expect(queued).toHaveLength(1);
    expect(queued[0].id).toBe("task-1");
  });

  test("returns tasks ordered by priority desc then queuedAt asc", async () => {
    enqueueTask("low-old", "proj-1", 0);
    await new Promise(r => setTimeout(r, 5));
    enqueueTask("low-new", "proj-1", 0);
    enqueueTask("high", "proj-1", 1);
    const queued = listQueuedTasks();
    expect(queued[0].id).toBe("high");
    expect(queued[1].id).toBe("low-old");
    expect(queued[2].id).toBe("low-new");
  });
});

describe("resetStaleDispatchingEntries", () => {
  test("resets dispatching entries back to queued", () => {
    enqueueTask("task-1", "proj-1", 0);
    markTaskDispatching("task-1");
    resetStaleDispatchingEntries();
    expect(listAllQueueEntries()[0].status).toBe("queued");
  });

  test("does not affect already-queued entries", () => {
    enqueueTask("task-1", "proj-1", 0);
    resetStaleDispatchingEntries();
    expect(listAllQueueEntries()[0].status).toBe("queued");
  });

  test("is safe when queue is empty", () => {
    expect(() => resetStaleDispatchingEntries()).not.toThrow();
  });
});

describe("removeTerminalTasks", () => {
  test("removes all specified IDs", () => {
    enqueueTask("task-1", "proj-1", 0);
    enqueueTask("task-2", "proj-1", 0);
    removeTerminalTasks(["task-1", "task-2"]);
    expect(listAllQueueEntries()).toHaveLength(0);
  });

  test("is safe with empty array", () => {
    expect(() => removeTerminalTasks([])).not.toThrow();
  });

  test("only removes specified IDs, leaves others", () => {
    enqueueTask("task-1", "proj-1", 0);
    enqueueTask("task-2", "proj-1", 0);
    removeTerminalTasks(["task-1"]);
    const all = listAllQueueEntries();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("task-2");
  });
});
