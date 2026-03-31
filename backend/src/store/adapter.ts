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
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  pragma(statement: string): void;
  execAsync(sql: string): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<DbRow[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
}
