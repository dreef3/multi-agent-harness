// backend/src/store/sqliteAdapter.ts

import type BetterSqlite3 from "better-sqlite3";
import type { DbAdapter, DbRow, PreparedStatement } from "./adapter.js";

export function createSqliteAdapter(db: BetterSqlite3.Database): DbAdapter {
  const adapter: DbAdapter = {
    prepare(sql: string): PreparedStatement {
      const stmt = db.prepare(sql);
      return {
        run(...params: unknown[]) {
          const result = stmt.run(...params);
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        },
        get(...params: unknown[]): DbRow | null {
          return (stmt.get(...params) as DbRow) ?? null;
        },
        all(...params: unknown[]): DbRow[] {
          return stmt.all(...params) as DbRow[];
        },
      };
    },
    exec(sql: string): void { db.exec(sql); },
    transaction<T>(fn: () => T): T { return db.transaction(fn)(); },
    pragma(statement: string): void { db.pragma(statement); },
    // Async interface — sync wrappers for now (SQLite is synchronous).
    // The PostgreSQL adapter uses true async I/O.
    execAsync: async (sql: string) => { db.exec(sql); },
    query: async <T = DbRow>(sql: string, params: unknown[] = []): Promise<T[]> => {
      return db.prepare(sql).all(...params) as T[];
    },
    execute: async (sql: string, params: unknown[] = []): Promise<void> => {
      db.prepare(sql).run(...params);
    },
    // SQLite sync transaction shim — works because SqliteAdapter methods
    // resolve immediately (no real async I/O). PostgresAdapter uses native async.
    async transactionAsync<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
      let result!: T;
      let error: unknown;
      db.transaction(() => {
        fn(adapter).then(r => { result = r; }).catch(e => { error = e; });
      })();
      if (error) throw error;
      return result;
    },
  };
  return adapter;
}
