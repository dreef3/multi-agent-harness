import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { initDb } from "../db.js";
import { upsertUser, getUser, listUsers } from "../users.js";
import { writeAuditEntry, getAuditLog } from "../auditLog.js";

describe("users store", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-auth-"));
    await initDb(tmpDir);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("upsertUser inserts and retrieves a user", async () => {
    const user = { id: "user-1", email: "a@b.com", displayName: "Alice", roles: ["admin"], lastSeen: new Date().toISOString(), createdAt: new Date().toISOString() };
    await upsertUser(user);
    const found = await getUser("user-1");
    expect(found?.email).toBe("a@b.com");
    expect(found?.roles).toEqual(["admin"]);
  });

  it("upsertUser updates on conflict", async () => {
    const user = { id: "user-1", email: "a@b.com", displayName: "Alice", roles: [], lastSeen: "2024-01-01T00:00:00Z", createdAt: "2024-01-01T00:00:00Z" };
    await upsertUser(user);
    await upsertUser({ ...user, email: "new@b.com", lastSeen: "2024-02-01T00:00:00Z" });
    const found = await getUser("user-1");
    expect(found?.email).toBe("new@b.com");
  });

  it("getUser returns null for unknown id", async () => {
    expect(await getUser("nonexistent")).toBeNull();
  });

  it("listUsers returns users ordered by last_seen desc", async () => {
    await upsertUser({ id: "u1", email: "a@b.com", displayName: "A", roles: [], lastSeen: "2024-01-01T00:00:00Z", createdAt: "2024-01-01T00:00:00Z" });
    await upsertUser({ id: "u2", email: "b@b.com", displayName: "B", roles: [], lastSeen: "2024-02-01T00:00:00Z", createdAt: "2024-01-01T00:00:00Z" });
    const list = await listUsers();
    expect(list[0].id).toBe("u2");
  });
});

describe("auditLog store", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-audit-"));
    await initDb(tmpDir);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("writes and retrieves an audit entry", async () => {
    await writeAuditEntry({ action: "project.create", resourceType: "project", resourceId: "p1" });
    const log = await getAuditLog({ resourceType: "project" });
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("project.create");
  });

  it("filters by userId", async () => {
    await writeAuditEntry({ userId: "u1", action: "project.create", resourceType: "project", resourceId: "p1" });
    await writeAuditEntry({ action: "repo.delete", resourceType: "repository", resourceId: "r1" });
    const log = await getAuditLog({ userId: "u1" });
    expect(log).toHaveLength(1);
  });

  it("filters by resourceId", async () => {
    await writeAuditEntry({ action: "project.create", resourceType: "project", resourceId: "p1" });
    await writeAuditEntry({ action: "project.update", resourceType: "project", resourceId: "p2" });
    const log = await getAuditLog({ resourceId: "p1" });
    expect(log).toHaveLength(1);
    expect(log[0].resourceId).toBe("p1");
  });

  it("respects limit option", async () => {
    for (let i = 0; i < 5; i++) {
      await writeAuditEntry({ action: "project.view", resourceType: "project", resourceId: `p${i}` });
    }
    const log = await getAuditLog({ limit: 3 });
    expect(log).toHaveLength(3);
  });
});
