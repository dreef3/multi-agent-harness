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
    execAsync: async (sql: string) => { db.exec(sql); },
    query: async (sql: string, params: unknown[] = []): Promise<DbRow[]> => {
      return db.prepare(sql).all(...params) as DbRow[];
    },
    execute: async (sql: string, params: unknown[] = []): Promise<void> => {
      db.prepare(sql).run(...params);
    },
  };
}
