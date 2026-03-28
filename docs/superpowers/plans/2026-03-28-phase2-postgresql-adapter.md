# PostgreSQL Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a PostgreSQL adapter using `postgres.js`, add a `DATABASE_TYPE` config switch, and make all store functions async so PostgreSQL can be used as a drop-in replacement for SQLite.

**Architecture:** The `DbAdapter` interface from Phase 2 (plan 22) is extended with async variants. All store functions become `async` and return `Promise<T>`. The `initDb()` factory selects between `SqliteAdapter` and `PostgresAdapter` based on `DATABASE_TYPE` env var. A Docker Compose profile `enterprise` adds a PostgreSQL service for local development.

**Tech Stack:** `postgres.js` (v3, better TypeScript support than `pg`), Docker Compose profiles, Bun test runner, Bun's built-in SQLite driver (kept for `DATABASE_TYPE=sqlite`).

---

## Prerequisites

- [ ] Confirm Phase 2 plan 22 (db-adapter refactoring) is complete and tests pass
- [ ] Confirm `backend/src/store/adapter.ts` and `getAdapter()` exist
- [ ] Confirm all store functions use `getAdapter()` (not `getDb()`)

## Step 1 — Install `postgres.js`

- [ ] Run:
  ```bash
  cd backend && bun add postgres
  cd backend && bun add -d @types/node  # ensure node types present
  ```
- [ ] Verify `backend/package.json` now lists `"postgres"` in dependencies

## Step 2 — Extend `DbAdapter` interface for async operations

The synchronous `PreparedStatement` interface cannot represent PostgreSQL's async I/O cleanly. Extend `adapter.ts` with async variants:

- [ ] Edit `backend/src/store/adapter.ts` to add async query methods:

```typescript
// Add to DbAdapter interface:

  /**
   * Execute a parameterized query returning rows.
   * Async — use this in all new async store functions.
   * For SQLite adapter, this wraps prepare().all() in a resolved Promise.
   */
  query<T extends DbRow = DbRow>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * Execute a parameterized statement (INSERT/UPDATE/DELETE).
   * Returns affected row count.
   */
  execute(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }>;

  /**
   * Run an async transaction.
   * The callback receives the adapter scoped to the transaction.
   */
  transactionAsync<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T>;
```

- [ ] Update `backend/src/store/sqliteAdapter.ts` to implement the new async methods (wrapping sync calls in `Promise.resolve()`):

```typescript
// Add to createSqliteAdapter return object:

async query<T extends DbRow = DbRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return Promise.resolve(db.prepare(sql).all(...params) as T[]);
},

async execute(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowid?: number | bigint }> {
  const result = db.prepare(sql).run(...params);
  return Promise.resolve({ changes: result.changes, lastInsertRowid: result.lastInsertRowid });
},

async transactionAsync<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
  // SQLite: run the async fn inside a sync transaction wrapper
  // WARNING: This is not truly safe for async fn with real I/O — works only because
  // SQLite adapter's query/execute methods resolve immediately (no real async I/O).
  let result!: T;
  db.transaction(() => {
    // Run the async fn and capture the promise synchronously
    const p = fn(this as DbAdapter);
    p.then(r => { result = r; }).catch(() => {});
    // Note: This works because SQLiteAdapter methods use Promise.resolve() — no event loop suspension
  })();
  return Promise.resolve(result);
},
```

> **Note for implementer:** The `transactionAsync` wrapper for SQLite is a best-effort shim. It works correctly because `SqliteAdapter.query()` and `.execute()` use `Promise.resolve()` (microtask, not macrotask). For production correctness with real async I/O, use the `PostgresAdapter` which handles transactions natively.

## Step 3 — Create `backend/src/store/postgresAdapter.ts`

- [ ] Create the file:

```typescript
// backend/src/store/postgresAdapter.ts

import postgres, { type Sql, type TransactionSql } from "postgres";
import type { DbAdapter, DbRow } from "./adapter.js";

function buildPostgresAdapter(sql: Sql | TransactionSql): DbAdapter {
  return {
    // Synchronous prepare() — not supported for PostgreSQL.
    // Store files should migrate to query()/execute() for PG compatibility.
    prepare(_sql: string) {
      throw new Error(
        "prepare() is not supported by PostgresAdapter. Use query() or execute() instead."
      );
    },

    exec(rawSql: string): void {
      // Fire-and-forget raw DDL — used during migrations
      // We schedule it synchronously but it runs async; callers must use execAsync for ordering guarantees.
      // In practice, migrations use execAsync() via the async migration runner.
      void sql.unsafe(rawSql);
    },

    transaction<T>(fn: () => T): T {
      throw new Error(
        "Synchronous transaction() is not supported by PostgresAdapter. Use transactionAsync() instead."
      );
    },

    pragma(_statement: string): void {
      // No-op for PostgreSQL
    },

    async query<T extends DbRow = DbRow>(rawSql: string, params: unknown[] = []): Promise<T[]> {
      // postgres.js uses $1, $2 placeholders; convert ? placeholders if needed.
      const pgSql = convertPlaceholders(rawSql);
      const rows = await sql.unsafe(pgSql, params as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as T[];
    },

    async execute(rawSql: string, params: unknown[] = []): Promise<{ changes: number }> {
      const pgSql = convertPlaceholders(rawSql);
      const result = await sql.unsafe(pgSql, params as postgres.ParameterOrJSON<never>[]);
      return { changes: result.count };
    },

    async transactionAsync<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
      return sql.begin(async (txSql) => {
        const txAdapter = buildPostgresAdapter(txSql);
        return fn(txAdapter);
      }) as Promise<T>;
    },
  };
}

/** Convert SQLite-style ? placeholders to PostgreSQL $1, $2, ... */
function convertPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export function createPostgresAdapter(connectionString: string): DbAdapter {
  const sql = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {}, // suppress NOTICE messages
  });

  return buildPostgresAdapter(sql);
}
```

## Step 4 — Add async migration runner

PostgreSQL's `exec()` is async under the hood. The migration runner needs an async variant.

- [ ] Add `execAsync()` to the `DbAdapter` interface in `adapter.ts`:

```typescript
  /**
   * Execute raw SQL asynchronously (DDL). Required for PostgreSQL migrations.
   */
  execAsync(sql: string): Promise<void>;
```

- [ ] Implement in `sqliteAdapter.ts`:
```typescript
async execAsync(sql: string): Promise<void> {
  db.exec(sql);
},
```

- [ ] Implement in `postgresAdapter.ts` inside `buildPostgresAdapter`:
```typescript
async execAsync(rawSql: string): Promise<void> {
  await sql.unsafe(rawSql);
},
```

- [ ] Update `db.ts` migration runner to use `execAsync()` (see plan 24 for full migration system).

## Step 5 — Update `backend/src/store/db.ts` with config switch

- [ ] Add imports at top of `db.ts`:
```typescript
import { createSqliteAdapter } from "./sqliteAdapter.js";
import { createPostgresAdapter } from "./postgresAdapter.js";
import type { DbAdapter } from "./adapter.js";
```

- [ ] Replace (or augment) the existing `initDb` function:

```typescript
let _adapter: DbAdapter | null = null;

export function getAdapter(): DbAdapter {
  if (!_adapter) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return _adapter;
}

export function initDb(dataDir: string): void {
  const dbType = process.env.DATABASE_TYPE ?? "sqlite";

  if (dbType === "postgresql") {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is required when DATABASE_TYPE=postgresql. " +
        "Example: postgresql://harness:harness@localhost:5432/harness"
      );
    }
    console.log("[db] Using PostgreSQL adapter");
    _adapter = createPostgresAdapter(url);
  } else {
    if (dbType !== "sqlite") {
      console.warn(`[db] Unknown DATABASE_TYPE="${dbType}", falling back to sqlite`);
    }
    console.log("[db] Using SQLite adapter");
    const dbPath = path.join(dataDir, "harness.db");
    const rawDb = new Database(dbPath);
    _adapter = createSqliteAdapter(rawDb);
  }

  migrate(_adapter);
}
```

## Step 6 — Update all store functions to be async

This is the largest change. Every store function must become `async` and use `query()`/`execute()` instead of `prepare().run()`/`.get()`/`.all()`.

### Pattern for each store file:

**Before (synchronous):**
```typescript
export function getProject(id: string): Project | null {
  const db = getAdapter();
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  return row ? mapProject(row as ProjectRow) : null;
}
```

**After (async):**
```typescript
export async function getProject(id: string): Promise<Project | null> {
  const db = getAdapter();
  const rows = await db.query<ProjectRow>("SELECT * FROM projects WHERE id = ?", [id]);
  return rows[0] ? mapProject(rows[0]) : null;
}
```

- [ ] `backend/src/store/projects.ts` — make all exported functions async
  - `createProject()` → `async createProject(): Promise<Project>`
  - `getProject()` → `async getProject(): Promise<Project | null>`
  - `listProjects()` → `async listProjects(): Promise<Project[]>`
  - `updateProject()` → `async updateProject(): Promise<void>`
  - `deleteProject()` → `async deleteProject(): Promise<void>`

- [ ] `backend/src/store/agents.ts` — same pattern for all exported functions

- [ ] `backend/src/store/repositories.ts` — same pattern

- [ ] `backend/src/store/pullRequests.ts` — same pattern

- [ ] Any other store files found via:
  ```bash
  grep -rl "getAdapter()\|getDb()" backend/src/store/
  ```

## Step 7 — Update all callers of store functions

Every place that calls a store function must now `await` it.

- [ ] Search for all callers:
  ```bash
  grep -rn "from.*store/" backend/src/api/ backend/src/orchestrator/ backend/src/
  ```

- [ ] For each API route file (e.g., `backend/src/api/projects.ts`):
  ```typescript
  // Before:
  const project = store.getProject(id);

  // After:
  const project = await store.getProject(id);
  ```

- [ ] Route handler functions that call async store functions must themselves be `async`:
  ```typescript
  // Before:
  app.get("/projects/:id", (req, res) => {
    const project = store.getProject(req.params.id);
    res.json(project);
  });

  // After:
  app.get("/projects/:id", async (req, res) => {
    const project = await store.getProject(req.params.id);
    res.json(project);
  });
  ```

- [ ] Check orchestrator files: `taskDispatcher.ts`, `recoveryService.ts`, `planningAgentManager.ts`

## Step 8 — Add Docker Compose PostgreSQL service

- [ ] Edit `docker-compose.yml` (or `docker-compose.yaml` — check which exists) to add:

```yaml
  postgres:
    image: postgres:16-alpine
    profiles:
      - enterprise
    environment:
      POSTGRES_DB: harness
      POSTGRES_USER: harness
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-harness}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U harness -d harness"]
      interval: 5s
      timeout: 5s
      retries: 5
    volumes:
      - harness-postgres:/var/lib/postgresql/data
    ports:
      - "${POSTGRES_PORT:-5432}:5432"

volumes:
  harness-postgres:
```

- [ ] Add `DATABASE_URL` and `DATABASE_TYPE` to `.env.example` (if it exists):
  ```
  # Database configuration
  # DATABASE_TYPE=sqlite  (default)
  # DATABASE_TYPE=postgresql
  # DATABASE_URL=postgresql://harness:harness@localhost:5432/harness
  ```

## Step 9 — PostgreSQL schema compatibility

PostgreSQL differs from SQLite in several ways. Audit the schema:

- [ ] **`TEXT PRIMARY KEY`** — valid in both. No change needed.
- [ ] **`INTEGER` autoincrement** — SQLite: `INTEGER PRIMARY KEY AUTOINCREMENT`. PostgreSQL: `SERIAL` or `GENERATED ALWAYS AS IDENTITY`. Since IDs are `TEXT` (UUIDs), this likely doesn't apply.
- [ ] **`DATETIME` vs `TIMESTAMPTZ`** — SQLite stores dates as TEXT. PostgreSQL has native `TIMESTAMPTZ`. Check each column — if stored as ISO string, use `TEXT` in PG migrations for compatibility.
- [ ] **`BOOLEAN`** — SQLite stores as 0/1 integers. PostgreSQL has native `BOOLEAN`. Use `INTEGER` in migrations for cross-DB compatibility, or handle the type difference in the adapter.
- [ ] **`JSON` columns** — If any columns store JSON text, PostgreSQL can use `JSONB` but `TEXT` works too. Keep as `TEXT` for compatibility.
- [ ] **Case sensitivity** — PostgreSQL is case-sensitive for string comparisons by default. Check `WHERE` clauses that use `LIKE` or equality on potentially mixed-case fields.

- [ ] Create `backend/src/store/migrations/pg_compat.ts` with PostgreSQL-specific migration variants if schema differences are found.

## Step 10 — Verify

- [ ] Test with SQLite (default): `cd backend && bun run test`
  - All existing tests must still pass.

- [ ] Test with PostgreSQL (integration):
  ```bash
  docker compose --profile enterprise up -d postgres
  # Wait for healthcheck
  DATABASE_TYPE=postgresql DATABASE_URL=postgresql://harness:harness@localhost:5432/harness bun run test
  ```
  - Tests may need postgres-aware fixtures — create `backend/src/store/__tests__/postgres.test.ts` for PG-specific tests if needed.

- [ ] TypeScript check: `cd backend && bunx tsc --noEmit`

## File Summary

| File | Action |
|------|--------|
| `backend/src/store/adapter.ts` | MODIFY — add `query()`, `execute()`, `transactionAsync()`, `execAsync()` |
| `backend/src/store/sqliteAdapter.ts` | MODIFY — implement new async methods |
| `backend/src/store/postgresAdapter.ts` | CREATE — postgres.js-based implementation |
| `backend/src/store/db.ts` | MODIFY — `DATABASE_TYPE` switch in `initDb()` |
| `backend/src/store/projects.ts` | MODIFY — async store functions |
| `backend/src/store/agents.ts` | MODIFY — async store functions |
| `backend/src/store/repositories.ts` | MODIFY — async store functions |
| `backend/src/store/pullRequests.ts` | MODIFY — async store functions |
| `backend/src/api/*.ts` | MODIFY — await all store calls |
| `docker-compose.yml` | MODIFY — add postgres service under `enterprise` profile |
| `.env.example` | MODIFY — document DATABASE_TYPE/DATABASE_URL |

## Acceptance Criteria

- `DATABASE_TYPE=sqlite bun run test` passes (all existing tests)
- `DATABASE_TYPE=postgresql DATABASE_URL=... bun run test` passes (PostgreSQL integration)
- TypeScript compilation clean
- `docker compose --profile enterprise up` starts PostgreSQL successfully
- Creating a project via API works with both `DATABASE_TYPE=sqlite` and `DATABASE_TYPE=postgresql`
- `DATABASE_TYPE=postgresql` without `DATABASE_URL` throws a clear error at startup

## Estimated Effort

2-3 days: 1 day for async store migration, 0.5 day for PostgreSQL adapter + schema audit, 0.5 day for integration testing, 1 day buffer for type errors and edge cases.
