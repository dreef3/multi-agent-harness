# Auth Schema Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `users` and `audit_log` tables to the SQLite schema and extend existing tables with user-attribution columns.

**Architecture:** Schema changes are applied non-destructively in the existing `migrate()` function using `CREATE TABLE IF NOT EXISTS` and the `addColumnIfMissing` helper already present in `db.ts`. Two new store modules (`users.ts`, `auditLog.ts`) expose typed CRUD helpers over these tables.

**Tech Stack:** `better-sqlite3`, TypeScript, existing `backend/src/store/db.ts` migration pattern.

---

## Tasks

- [ ] **Task 1 — Add `users` table to `migrate()` in `backend/src/store/db.ts`**

  Open `backend/src/store/db.ts` and locate the `migrate()` function. After the last existing `CREATE TABLE IF NOT EXISTS` statement, add:

  ```sql
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,      -- OIDC 'sub' claim
    email        TEXT NOT NULL,
    display_name TEXT NOT NULL,
    roles        TEXT NOT NULL DEFAULT '[]',  -- JSON array of role strings
    last_seen    TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  ```

- [ ] **Task 2 — Add `audit_log` table to `migrate()`**

  Immediately after the `users` table DDL, add:

  ```sql
  CREATE TABLE IF NOT EXISTS audit_log (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    user_email    TEXT NOT NULL,
    action        TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id   TEXT NOT NULL,
    details       TEXT,
    ip_address    TEXT,
    timestamp     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id);
  CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
  ```

- [ ] **Task 3 — Add attribution columns to existing tables**

  Still inside `migrate()`, after the new table DDL, add two `addColumnIfMissing` calls:

  ```typescript
  addColumnIfMissing("projects", "created_by", "TEXT");
  addColumnIfMissing("agent_sessions", "triggered_by", "TEXT");
  ```

- [ ] **Task 4 — Create `backend/src/store/users.ts`**

  Create the file with the following content:

  ```typescript
  import { getDb } from "./db.js";

  export interface User {
    id: string;        // OIDC sub
    email: string;
    displayName: string;
    roles: string[];   // stored as JSON in DB
    lastSeen: string;  // ISO-8601
    createdAt: string; // ISO-8601
  }

  export function upsertUser(user: User): void {
    getDb()
      .prepare(
        `INSERT INTO users (id, email, display_name, roles, last_seen, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           email        = excluded.email,
           display_name = excluded.display_name,
           roles        = excluded.roles,
           last_seen    = excluded.last_seen`
      )
      .run(
        user.id,
        user.email,
        user.displayName,
        JSON.stringify(user.roles),
        user.lastSeen,
        user.createdAt
      );
  }

  export function getUser(id: string): User | null {
    const row = getDb()
      .prepare(`SELECT * FROM users WHERE id = ?`)
      .get(id) as Record<string, string> | null;
    if (!row) return null;
    return rowToUser(row);
  }

  export function listUsers(): User[] {
    return (
      getDb()
        .prepare(`SELECT * FROM users ORDER BY last_seen DESC`)
        .all() as Record<string, string>[]
    ).map(rowToUser);
  }

  function rowToUser(row: Record<string, string>): User {
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      roles: JSON.parse(row.roles ?? "[]"),
      lastSeen: row.last_seen,
      createdAt: row.created_at,
    };
  }
  ```

- [ ] **Task 5 — Create `backend/src/store/auditLog.ts`**

  Create the file with the following content:

  ```typescript
  import { getDb } from "./db.js";
  import { randomUUID } from "crypto";

  export interface AuditEntry {
    userId: string;
    userEmail: string;
    action: string;        // e.g. "project.post", "repository.delete"
    resourceType: string;  // e.g. "project", "repository"
    resourceId: string;
    details?: string;      // truncated JSON of request body
    ipAddress?: string;
  }

  export function writeAuditEntry(entry: AuditEntry): void {
    getDb()
      .prepare(
        `INSERT INTO audit_log
           (id, user_id, user_email, action, resource_type, resource_id, details, ip_address, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        entry.userId,
        entry.userEmail,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        entry.details ?? null,
        entry.ipAddress ?? null,
        new Date().toISOString()
      );
  }

  export function getAuditLog(options: {
    userId?: string;
    resourceType?: string;
    resourceId?: string;
    limit?: number;
  } = {}): AuditEntry[] {
    let query = `SELECT * FROM audit_log WHERE 1=1`;
    const params: (string | number)[] = [];

    if (options.userId) {
      query += ` AND user_id = ?`;
      params.push(options.userId);
    }
    if (options.resourceType) {
      query += ` AND resource_type = ?`;
      params.push(options.resourceType);
    }
    if (options.resourceId) {
      query += ` AND resource_id = ?`;
      params.push(options.resourceId);
    }

    query += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(options.limit ?? 100);

    return (getDb().prepare(query).all(...params) as Record<string, string>[]).map(row => ({
      userId: row.user_id,
      userEmail: row.user_email,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      details: row.details ?? undefined,
      ipAddress: row.ip_address ?? undefined,
    }));
  }
  ```

- [ ] **Task 6 — Verify TypeScript compiles**

  ```bash
  cd backend && bun run tsc --noEmit
  ```

  Fix any type errors before proceeding.

- [ ] **Task 7 — Smoke-test migration**

  ```bash
  cd backend && bun run dev &
  # Wait for "Server started" then:
  sqlite3 data/harness.db ".tables"
  # Expected output includes: users  audit_log
  sqlite3 data/harness.db "PRAGMA table_info(users);"
  sqlite3 data/harness.db "PRAGMA table_info(audit_log);"
  kill %1
  ```

---

## Verification Checklist

- [ ] `users` table present with all 6 columns
- [ ] `audit_log` table present with all 9 columns + 3 indexes
- [ ] `projects.created_by` column exists (nullable TEXT)
- [ ] `agent_sessions.triggered_by` column exists (nullable TEXT)
- [ ] `upsertUser` performs insert-or-update (run twice with same `id`, second call updates `last_seen`)
- [ ] `getUser` returns `null` for unknown id
- [ ] `listUsers` returns array ordered by `last_seen DESC`
- [ ] `writeAuditEntry` inserts a row with auto-generated UUID and ISO timestamp
- [ ] TypeScript strict-mode compile passes (`tsc --noEmit`)
