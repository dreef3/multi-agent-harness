# Versioned Schema Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ad-hoc `CREATE TABLE IF NOT EXISTS` + `addColumnIfMissing` migration system in `db.ts` with a numbered, immutable, append-only migration system tracked in the existing `schema_migrations` table.

**Architecture:** Each migration is a TypeScript module exporting a `{ name, up }` object. An `index.ts` in `backend/src/store/migrations/` exports an ordered array of all migrations. A `runMigrations(adapter)` function in `db.ts` iterates migrations, checks `schema_migrations` for already-applied entries, and runs `up()` for new ones. Migration 001 captures the full existing schema using `CREATE TABLE IF NOT EXISTS` for idempotency on existing databases.

**Tech Stack:** TypeScript, `better-sqlite3` (via `DbAdapter`), `postgres.js` (for PostgreSQL compatibility in `up()` functions that use `execAsync()`).

---

## Prerequisites

- [ ] Read `backend/src/store/db.ts` fully — capture the complete current schema (all `CREATE TABLE` statements, all `addColumnIfMissing` calls)
- [ ] Confirm `schema_migrations` table structure: check if it has `name TEXT PRIMARY KEY, applied_at TEXT` or different columns
- [ ] Confirm `DbAdapter` interface exists (plan 22) with `exec()`, `execAsync()`, `prepare()`, `query()`

## Step 1 — Audit existing schema

- [ ] Read `db.ts` and extract every schema element into a list:
  - All `CREATE TABLE IF NOT EXISTS` blocks
  - All `CREATE INDEX IF NOT EXISTS` statements
  - All `addColumnIfMissing()` calls (these represent incremental column additions = separate migrations)
  - All `INSERT OR IGNORE` seed data

- [ ] Map each `addColumnIfMissing` call to the migration it belongs to (by reading git history if needed):
  ```bash
  cd /home/ae/multi-agent-harness && git log --oneline backend/src/store/db.ts | head -20
  ```

## Step 2 — Create migrations directory

- [ ] Create directory: `backend/src/store/migrations/`

- [ ] Plan migration numbering based on the audit:

| Migration | Contents |
|-----------|----------|
| `001_initial_schema` | All base tables from original schema |
| `002_add_primary_repository_id` | `ALTER TABLE projects ADD COLUMN primary_repository_id TEXT` |
| `003_add_planning_pr` | `ALTER TABLE sessions ADD COLUMN planning_pr_number INTEGER` (verify actual column) |
| `004_add_last_error` | `ALTER TABLE sessions ADD COLUMN last_error TEXT` (verify actual column) |
| `005_add_auth_tables` | `users`, `sessions` auth table, `audit_log` (Phase 1) |
| `006_add_task_queue` | `task_queue` table (Phase 0 SQLite queue) |

> **Note:** Verify exact column names and tables from the `db.ts` audit in Step 1. The above is a template — actual migration content must match the real schema.

## Step 3 — Create `001_initial_schema.ts`

- [ ] Create `backend/src/store/migrations/001_initial_schema.ts`:

```typescript
// backend/src/store/migrations/001_initial_schema.ts
import type { DbAdapter } from "../adapter.js";

export const migration = {
  name: "001_initial_schema",
  async up(db: DbAdapter): Promise<void> {
    // Use CREATE TABLE IF NOT EXISTS for idempotency on existing databases
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        name TEXT NOT NULL,
        local_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        repository_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (repository_id) REFERENCES repositories(id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        container_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS pull_requests (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT,
        number INTEGER,
        title TEXT,
        url TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
    `);
    // Add any CREATE INDEX IF NOT EXISTS from the original schema here
  },
};
```

> **IMPORTANT:** The table definitions above are illustrative. Replace them with the EXACT schema from your `db.ts` audit in Step 1. Do not guess column names.

## Step 4 — Create incremental migration files

For each incremental migration identified in the audit:

- [ ] `backend/src/store/migrations/002_add_primary_repository_id.ts`:

```typescript
import type { DbAdapter } from "../adapter.js";

export const migration = {
  name: "002_add_primary_repository_id",
  async up(db: DbAdapter): Promise<void> {
    // SQLite and PostgreSQL both support ALTER TABLE ADD COLUMN IF NOT EXISTS
    // but SQLite does NOT support IF NOT EXISTS on ALTER TABLE.
    // Use a try/catch for SQLite compatibility:
    try {
      await db.execAsync(
        "ALTER TABLE projects ADD COLUMN primary_repository_id TEXT REFERENCES repositories(id)"
      );
    } catch (e: unknown) {
      // Column already exists (SQLite throws on duplicate column add)
      if (!(e instanceof Error) || !e.message.includes("duplicate column")) throw e;
    }
  },
};
```

> **Pattern note:** SQLite does not support `ALTER TABLE ADD COLUMN IF NOT EXISTS`. Use try/catch on the error message `"duplicate column"` for SQLite, or check for PostgreSQL's `column already exists` error. This is the correct cross-DB approach.

- [ ] Create remaining migration files (`003_`, `004_`, `005_`, `006_`) following the same pattern. Verify exact column names from the audit.

## Step 5 — Create `index.ts`

- [ ] Create `backend/src/store/migrations/index.ts`:

```typescript
// backend/src/store/migrations/index.ts
import type { DbAdapter } from "../adapter.js";

import { migration as m001 } from "./001_initial_schema.js";
import { migration as m002 } from "./002_add_primary_repository_id.js";
import { migration as m003 } from "./003_add_planning_pr.js";
import { migration as m004 } from "./004_add_last_error.js";
import { migration as m005 } from "./005_add_auth_tables.js";
import { migration as m006 } from "./006_add_task_queue.js";

export interface Migration {
  name: string;
  up(db: DbAdapter): Promise<void>;
}

export const migrations: Migration[] = [
  m001,
  m002,
  m003,
  m004,
  m005,
  m006,
];
```

## Step 6 — Replace `migrate()` in `db.ts` with `runMigrations()`

- [ ] Read the current `migrate()` function in `db.ts`

- [ ] Replace it with the new async migration runner:

```typescript
// backend/src/store/db.ts

import { migrations } from "./migrations/index.js";
import type { DbAdapter } from "./adapter.js";

async function runMigrations(db: DbAdapter): Promise<void> {
  // Ensure schema_migrations table exists before any other migrations run.
  // This is the bootstrap migration — always safe to run.
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  for (const migration of migrations) {
    const existing = await db.query(
      "SELECT name FROM schema_migrations WHERE name = ?",
      [migration.name]
    );

    if (existing.length === 0) {
      console.log(`[db] Applying migration: ${migration.name}`);
      await migration.up(db);
      await db.execute(
        "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
        [migration.name, new Date().toISOString()]
      );
      console.log(`[db] Migration applied: ${migration.name}`);
    }
  }
}
```

- [ ] Update `initDb()` to call `runMigrations()` instead of the old `migrate()`:

```typescript
export async function initDb(dataDir: string): Promise<void> {
  // ... adapter creation (from plan 23) ...
  await runMigrations(_adapter);
}
```

> **Note:** `initDb()` becomes async. Update the call site (likely `backend/src/index.ts`) to `await initDb(dataDir)`.

- [ ] Find and update the call site:
  ```bash
  grep -rn "initDb(" backend/src/
  ```
  - Likely in `backend/src/index.ts` — wrap in `async` startup or top-level await.

## Step 7 — Remove old migration code from `db.ts`

- [ ] Delete the old `migrate()` function (the one with `CREATE TABLE IF NOT EXISTS` inline SQL)
- [ ] Delete all `addColumnIfMissing()` helper function calls and the function itself
- [ ] Confirm `db.ts` no longer contains any `CREATE TABLE` statements (those now live in migration files)
- [ ] The only schema-related code remaining in `db.ts` should be:
  - `initDb()` (selects adapter, calls `runMigrations()`)
  - `runMigrations()` (the loop above)
  - Imports

## Step 8 — Handle existing databases safely

The key invariant: Migration 001 uses `CREATE TABLE IF NOT EXISTS` everywhere. This means:

- New database: Tables created by migration 001, subsequent migrations applied.
- Existing database (pre-migration-system): Tables already exist, migration 001 is a no-op for each `CREATE TABLE IF NOT EXISTS`. BUT migration 001 itself is NOT in `schema_migrations`, so it WILL run — it just won't error because of `IF NOT EXISTS`.
- Existing database with some `addColumnIfMissing` columns already applied: Migrations 002-006 use try/catch on duplicate column errors. Safe.

- [ ] Verify this logic with a manual test:
  1. Start with an existing `harness.db` that has some data
  2. Run the new code
  3. Confirm `schema_migrations` table now has entries for all migrations
  4. Confirm data is intact
  5. Restart server and confirm no errors (all migrations already applied)

## Step 9 — Write migration tests

- [ ] Create `backend/src/store/__tests__/migrations.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import Database from "better-sqlite3";
import { createSqliteAdapter } from "../sqliteAdapter.js";
import { runMigrations } from "../db.js"; // export runMigrations for testing

describe("migrations", () => {
  it("applies all migrations to a fresh database", async () => {
    const rawDb = new Database(":memory:");
    const adapter = createSqliteAdapter(rawDb);
    await runMigrations(adapter);

    // Verify schema_migrations has all expected entries
    const rows = await adapter.query("SELECT name FROM schema_migrations ORDER BY name");
    const names = rows.map(r => r.name as string);
    expect(names).toContain("001_initial_schema");
    expect(names).toContain("002_add_primary_repository_id");
    // ... etc
  });

  it("is idempotent — running twice does not error", async () => {
    const rawDb = new Database(":memory:");
    const adapter = createSqliteAdapter(rawDb);
    await runMigrations(adapter);
    await runMigrations(adapter); // second run — should be no-op

    const rows = await adapter.query("SELECT name FROM schema_migrations");
    // Same count as before
    expect(rows.length).toBe(6); // adjust to actual migration count
  });

  it("skips already-applied migrations", async () => {
    const rawDb = new Database(":memory:");
    const adapter = createSqliteAdapter(rawDb);

    // Pre-insert migration 001 as already applied
    await adapter.execAsync(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    await adapter.execute(
      "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
      ["001_initial_schema", new Date().toISOString()]
    );

    // Running migrations should not apply 001 again (which would fail since tables don't exist yet)
    // BUT it WILL apply 002+ which depend on tables from 001...
    // So this test verifies the skip logic, not that 002 succeeds without 001.
    const consoleSpy: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => consoleSpy.push(msg);

    // 001 skipped, 002 attempted (will fail since table doesn't exist — that's expected)
    try { await runMigrations(adapter); } catch { /* expected */ }

    console.log = originalLog;
    expect(consoleSpy.some(m => m.includes("001_initial_schema"))).toBe(false);
  });
});
```

## Step 10 — Verify

- [ ] TypeScript check: `cd backend && bunx tsc --noEmit`
- [ ] Unit tests: `cd backend && bun run test`
- [ ] Manual smoke test with new database (delete `harness.db`, restart server, verify clean startup)
- [ ] Manual smoke test with existing database (keep `harness.db`, restart server, verify migrations applied and data intact)

## File Summary

| File | Action |
|------|--------|
| `backend/src/store/migrations/` | CREATE directory |
| `backend/src/store/migrations/001_initial_schema.ts` | CREATE |
| `backend/src/store/migrations/002_add_primary_repository_id.ts` | CREATE |
| `backend/src/store/migrations/003_add_planning_pr.ts` | CREATE |
| `backend/src/store/migrations/004_add_last_error.ts` | CREATE |
| `backend/src/store/migrations/005_add_auth_tables.ts` | CREATE |
| `backend/src/store/migrations/006_add_task_queue.ts` | CREATE |
| `backend/src/store/migrations/index.ts` | CREATE |
| `backend/src/store/db.ts` | MODIFY — replace `migrate()` with `runMigrations()`, make `initDb()` async |
| `backend/src/index.ts` | MODIFY — await `initDb()` |
| `backend/src/store/__tests__/migrations.test.ts` | CREATE |

## Acceptance Criteria

- All existing tests pass (`bun run test`)
- New database starts cleanly with all 6 migrations applied
- Existing database starts cleanly, all 6 migrations recorded, data intact
- `schema_migrations` table populated correctly after startup
- No `addColumnIfMissing` function remaining in `db.ts`
- No inline `CREATE TABLE` SQL remaining in `db.ts` (except the bootstrap in `runMigrations`)
- Migration files are numbered, named, and immutable (never edit an applied migration)
