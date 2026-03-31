# Database Adapter Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define a `DbAdapter` interface and refactor the existing SQLite code into a `SqliteAdapter` class, enabling future database backends without changing any observable behavior.

**Architecture:** The adapter wraps `better-sqlite3`'s `Database` instance behind a `DbAdapter` interface. All store files (`projects.ts`, `agents.ts`, etc.) switch from importing `getDb()` to importing `getAdapter()`. This is a pure refactoring — no new behavior, no schema changes, all tests must pass unchanged.

**Tech Stack:** TypeScript, `better-sqlite3` (sync), Bun test runner.

---

## Prerequisites

- [ ] Read `backend/src/store/db.ts` to understand current schema and `getDb()` usage
- [ ] Run `bun run test` from `backend/` to confirm baseline passing state — record output

## Step 1 — Create `backend/src/store/adapter.ts`

- [ ] Create the file with the following content:

```typescript
// backend/src/store/adapter.ts

export interface DbRow {
  [key: string]: unknown;
}

export interface PreparedStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): DbRow | null;
  all(...params: unknown[]): DbRow[];
}

export interface DbAdapter {
  /**
   * Prepare a SQL statement for repeated execution.
   * Returns a PreparedStatement compatible with the synchronous better-sqlite3 API.
   * NOTE: For async adapters (PostgreSQL), use exec() or dedicated async query helpers instead.
   */
  prepare(sql: string): PreparedStatement;

  /**
   * Execute raw SQL (DDL statements, multi-statement blocks).
   * This is fire-and-forget for SQLite; for PostgreSQL it will be async internally.
   */
  exec(sql: string): void;

  /**
   * Run a series of statements atomically in a transaction.
   * The callback is executed synchronously for SQLite.
   */
  transaction<T>(fn: () => T): T;

  /**
   * SQLite PRAGMA-style configuration. No-op for non-SQLite adapters.
   */
  pragma(statement: string): void;
}
```

## Step 2 — Create `backend/src/store/sqliteAdapter.ts`

- [ ] Create the file wrapping `better-sqlite3`'s `Database` instance:

```typescript
// backend/src/store/sqliteAdapter.ts

import type BetterSqlite3 from "better-sqlite3";
import type { DbAdapter, DbRow, PreparedStatement } from "./adapter.js";

export function createSqliteAdapter(db: BetterSqlite3.Database): DbAdapter {
  return {
    prepare(sql: string): PreparedStatement {
      const stmt = db.prepare(sql);
      return {
        run(...params: unknown[]) {
          const result = stmt.run(...params);
          return {
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid,
          };
        },
        get(...params: unknown[]): DbRow | null {
          return (stmt.get(...params) as DbRow) ?? null;
        },
        all(...params: unknown[]): DbRow[] {
          return stmt.all(...params) as DbRow[];
        },
      };
    },

    exec(sql: string): void {
      db.exec(sql);
    },

    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },

    pragma(statement: string): void {
      db.pragma(statement);
    },
  };
}
```

## Step 3 — Refactor `backend/src/store/db.ts`

- [ ] Read the current `db.ts` carefully, noting:
  - Where `Database` type is used
  - Where `db.prepare()` is called directly
  - Where `db.exec()` is called
  - Where `db.pragma()` is called
  - Where `db.transaction()` is called

- [ ] Add `getAdapter()` export and internal `_adapter` variable alongside the existing `_db` variable:

```typescript
// At the top of db.ts, add:
import { createSqliteAdapter } from "./sqliteAdapter.js";
import type { DbAdapter } from "./adapter.js";

let _adapter: DbAdapter | null = null;

export function getAdapter(): DbAdapter {
  if (!_adapter) throw new Error("Database not initialized. Call initDb() first.");
  return _adapter;
}
```

- [ ] In the existing `initDb()` function, after `_db` is created, add:
```typescript
_adapter = createSqliteAdapter(_db);
```

- [ ] **Do NOT remove `getDb()` yet** — keep it for backward compatibility during this transition step.

- [ ] Update the internal `migrate()` function to accept and use `DbAdapter` instead of `Database.Database` directly:
  - Replace `db.exec(...)` → `adapter.exec(...)`
  - Replace `db.prepare(...)` → `adapter.prepare(...)`
  - Replace `db.pragma(...)` → `adapter.pragma(...)`
  - Replace `db.transaction(...)` → `adapter.transaction(...)`

## Step 4 — Refactor store files to use `getAdapter()`

For each of the following files, replace `getDb()` with `getAdapter()` and update the type annotation from `Database.Database` to `DbAdapter`:

- [ ] `backend/src/store/projects.ts`
  - Change `import { getDb } from "./db.js"` → `import { getAdapter } from "./db.js"`
  - Replace all `getDb()` calls with `getAdapter()`
  - If the file has a local `db` variable typed as `Database.Database`, retype as `DbAdapter`
  - Note: `.prepare(sql).run(...)` returns `{ changes, lastInsertRowid }` — the `DbRow` interface uses `unknown` values, so add type assertions where concrete types are needed (e.g., `row.id as string`)

- [ ] `backend/src/store/agents.ts` — same pattern

- [ ] `backend/src/store/repositories.ts` — same pattern

- [ ] `backend/src/store/pullRequests.ts` — same pattern

- [ ] Any other store files found by searching:
  ```bash
  grep -rl "getDb()" backend/src/store/
  ```

**Type assertion pattern** — when a store function returns a typed object, cast from `DbRow`:
```typescript
// Before:
const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow;

// After:
const row = getAdapter().prepare("SELECT * FROM projects WHERE id = ?").get(id) as DbRow;
// Then cast to typed interface in the return:
return row ? (row as unknown as ProjectRow) : null;
```

Or define a helper at the top of each store file:
```typescript
const db = () => getAdapter();
```
This minimizes per-line churn.

## Step 5 — Remove `better-sqlite3` type imports from store files

- [ ] Each store file that previously imported `import type Database from "better-sqlite3"` — remove that import (it's no longer needed after switching to `DbAdapter`).

- [ ] Confirm `backend/src/store/adapter.ts` and `backend/src/store/sqliteAdapter.ts` are the only files importing `better-sqlite3`.

## Step 6 — Update TypeScript path aliases (if any)

- [ ] Check `backend/tsconfig.json` for path aliases — no changes needed unless `store/*` paths are explicitly mapped.

## Step 7 — Verify

- [ ] Run TypeScript compiler: `cd backend && bun run typecheck` (or `bunx tsc --noEmit`)
  - Fix any type errors. Common issues:
    - `DbRow` values are `unknown` — use `as string`, `as number` where needed
    - `lastInsertRowid` is `number | bigint` — use `Number()` if `number` is expected

- [ ] Run tests: `cd backend && bun run test`
  - All tests must pass. Zero regressions permitted.
  - If a test fails, it's a type-cast issue in the store layer — fix before proceeding.

- [ ] Smoke test manually: `cd backend && bun run dev` — create a project via the API and verify data persists.

## Step 8 — Clean up (optional, can defer to Phase 2 merge)

- [ ] Remove the `getDb()` export from `db.ts` if no remaining callers outside tests
- [ ] Update any test files that directly import `getDb()` to use `getAdapter()`

## File Summary

| File | Action |
|------|--------|
| `backend/src/store/adapter.ts` | CREATE — interface definitions |
| `backend/src/store/sqliteAdapter.ts` | CREATE — wraps better-sqlite3 |
| `backend/src/store/db.ts` | MODIFY — add `getAdapter()`, update `migrate()` |
| `backend/src/store/projects.ts` | MODIFY — use `getAdapter()` |
| `backend/src/store/agents.ts` | MODIFY — use `getAdapter()` |
| `backend/src/store/repositories.ts` | MODIFY — use `getAdapter()` |
| `backend/src/store/pullRequests.ts` | MODIFY — use `getAdapter()` |

## Acceptance Criteria

- `bun run test` passes with zero failures
- `bun run typecheck` passes with zero errors
- `getAdapter()` is exported from `db.ts` and returns a `DbAdapter`
- No store file imports directly from `better-sqlite3` (only `sqliteAdapter.ts` does)
- `getDb()` may still exist for backward compat but is deprecated
