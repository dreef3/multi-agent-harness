import postgres from "postgres";
import type { DbAdapter, DbRow } from "./adapter.js";

function convertPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function buildPostgresAdapter(sql: postgres.Sql | postgres.TransactionSql<Record<string, never>>): DbAdapter {
  return {
    prepare(_sql: string) {
      throw new Error("prepare() not supported by PostgresAdapter. Use query() or execute().");
    },
    exec(_rawSql: string): void {
      throw new Error("exec() not supported by PostgresAdapter. Use execAsync().");
    },
    transaction<T>(_fn: () => T): T {
      throw new Error("transaction() not supported by PostgresAdapter. Use transactionAsync().");
    },
    pragma(_statement: string): void {
      // no-op for PostgreSQL
    },
    async execAsync(rawSql: string): Promise<void> {
      await sql.unsafe(rawSql);
    },
    async query<T = DbRow>(rawSql: string, params: unknown[] = []): Promise<T[]> {
      const pgSql = convertPlaceholders(rawSql);
      const rows = await sql.unsafe(pgSql, params as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as T[];
    },
    async execute(rawSql: string, params: unknown[] = []): Promise<void> {
      const pgSql = convertPlaceholders(rawSql);
      await sql.unsafe(pgSql, params as postgres.ParameterOrJSON<never>[]);
    },
    async transactionAsync<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
      // sql.begin is only available on the root Sql instance, not TransactionSql.
      // When called inside a transaction context, we reuse the current transaction.
      if ("begin" in sql) {
        return (sql as postgres.Sql).begin(async (txSql) => fn(buildPostgresAdapter(txSql))) as Promise<T>;
      }
      // Already inside a transaction — reuse current context
      return fn(buildPostgresAdapter(sql));
    },
  };
}

export function createPostgresAdapter(connectionString: string): DbAdapter {
  const sql = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
  return buildPostgresAdapter(sql);
}
