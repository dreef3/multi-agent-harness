import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDb, getDb } from "../store/db.js";
import os from "os";
import path from "path";
import fs from "fs";

describe("db", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes and creates all required tables", () => {
    initDb(tmpDir);
    const db = getDb();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("repositories");
    expect(names).toContain("agent_sessions");
  });

  it("is idempotent — running initDb twice does not throw", () => {
    initDb(tmpDir);
    expect(() => initDb(tmpDir)).not.toThrow();
  });
});
