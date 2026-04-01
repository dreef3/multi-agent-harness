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
  test("inserts a new queue entry with queued status", async () => {
    await enqueueTask("task-1", "proj-1", 0);
    const all = await listAllQueueEntries();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("task-1");
    expect(all[0].projectId).toBe("proj-1");
    expect(all[0].status).toBe("queued");
  });

  test("is idempotent — duplicate insert is ignored", async () => {
    await enqueueTask("task-1", "proj-1", 0);
    await enqueueTask("task-1", "proj-1", 0);
    expect(await listAllQueueEntries()).toHaveLength(1);
  });

  test("stores the provided priority", async () => {
    await enqueueTask("task-1", "proj-1", 5);
    expect((await listAllQueueEntries())[0].priority).toBe(5);
  });
});

describe("dequeueNextTask", () => {
  test("returns null when queue is empty", async () => {
    expect(await dequeueNextTask()).toBeNull();
  });

  test("returns highest priority task first", async () => {
    await enqueueTask("task-low", "proj-1", 0);
    await enqueueTask("task-high", "proj-1", 1);
    expect((await dequeueNextTask())?.id).toBe("task-high");
  });

  test("returns oldest task when priorities are equal", async () => {
    await enqueueTask("task-older", "proj-1", 0);
    await new Promise(r => setTimeout(r, 5));
    await enqueueTask("task-newer", "proj-1", 0);
    expect((await dequeueNextTask())?.id).toBe("task-older");
  });

  test("does not return dispatching tasks", async () => {
    await enqueueTask("task-1", "proj-1", 0);
    await markTaskDispatching("task-1");
    expect(await dequeueNextTask()).toBeNull();
  });

  test("returns projectId correctly", async () => {
    await enqueueTask("task-1", "proj-abc", 0);
    expect((await dequeueNextTask())?.projectId).toBe("proj-abc");
  });
});

describe("markTaskDispatching", () => {
  test("changes task status to dispatching", async () => {
    await enqueueTask("task-1", "proj-1", 0);
    await markTaskDispatching("task-1");
    expect((await listAllQueueEntries())[0].status).toBe("dispatching");
  });

  test("is safe to call on non-existent task", async () => {
    await expect(markTaskDispatching("nonexistent")).resolves.not.toThrow();
  });
});

describe("removeFromQueue", () => {
  test("deletes the entry", async () => {
    await enqueueTask("task-1", "proj-1", 0);
    await removeFromQueue("task-1");
    expect(await listAllQueueEntries()).toHaveLength(0);
  });

  test("is safe to call on non-existent entry", async () => {
    await expect(removeFromQueue("nonexistent")).resolves.not.toThrow();
  });

  test("only removes the specified task", async () => {
    await enqueueTask("task-1", "proj-1", 0);
    await enqueueTask("task-2", "proj-1", 0);
    await removeFromQueue("task-1");
    const all = await listAllQueueEntries();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("task-2");
  });
});

describe("listQueuedTasks", () => {
  test("returns empty array when queue is empty", async () => {
    expect(await listQueuedTasks()).toEqual([]);
  });

  test("only returns queued status tasks", async () => {
    await enqueueTask("task-1", "proj-1", 0);
    await enqueueTask("task-2", "proj-1", 0);
    await markTaskDispatching("task-2");
    const queued = await listQueuedTasks();
    expect(queued).toHaveLength(1);
    expect(queued[0].id).toBe("task-1");
  });

  test("returns tasks ordered by priority desc then queuedAt asc", async () => {
    await enqueueTask("low-old", "proj-1", 0);
    await new Promise(r => setTimeout(r, 5));
    await enqueueTask("low-new", "proj-1", 0);
    await enqueueTask("high", "proj-1", 1);
    const queued = await listQueuedTasks();
    expect(queued[0].id).toBe("high");
    expect(queued[1].id).toBe("low-old");
    expect(queued[2].id).toBe("low-new");
  });
});

describe("resetStaleDispatchingEntries", () => {
  test("resets dispatching entries back to queued", async () => {
    await enqueueTask("task-1", "proj-1", 0);
    await markTaskDispatching("task-1");
    await resetStaleDispatchingEntries();
    expect((await listAllQueueEntries())[0].status).toBe("queued");
  });

  test("does not affect already-queued entries", async () => {
    await enqueueTask("task-1", "proj-1", 0);
    await resetStaleDispatchingEntries();
    expect((await listAllQueueEntries())[0].status).toBe("queued");
  });

  test("is safe when queue is empty", async () => {
    await expect(resetStaleDispatchingEntries()).resolves.not.toThrow();
  });
});

describe("removeTerminalTasks", () => {
  test("removes all specified IDs", async () => {
    await enqueueTask("task-1", "proj-1", 0);
    await enqueueTask("task-2", "proj-1", 0);
    await removeTerminalTasks(["task-1", "task-2"]);
    expect(await listAllQueueEntries()).toHaveLength(0);
  });

  test("is safe with empty array", async () => {
    await expect(removeTerminalTasks([])).resolves.not.toThrow();
  });

  test("only removes specified IDs, leaves others", async () => {
    await enqueueTask("task-1", "proj-1", 0);
    await enqueueTask("task-2", "proj-1", 0);
    await removeTerminalTasks(["task-1"]);
    const all = await listAllQueueEntries();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("task-2");
  });
});
