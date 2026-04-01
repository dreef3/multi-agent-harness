import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { createSqliteAdapter } from "./sqliteAdapter.js";
import { createPostgresAdapter } from "./postgresAdapter.js";
import type { DbAdapter } from "./adapter.js";
import { migrations } from "./migrations/index.js";

let db: Database.Database | null = null;
let _adapter: DbAdapter | null = null;

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized — call initDb() first.");
  return db;
}

export function getAdapter(): DbAdapter {
  if (!_adapter) throw new Error("Database not initialized. Call initDb() first.");
  return _adapter;
}

export async function runMigrations(db: DbAdapter): Promise<void> {
  // Bootstrap: ensure schema_migrations exists
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  for (const migration of migrations) {
    const rows = await db.query(
      "SELECT name FROM schema_migrations WHERE name = ?",
      [migration.name]
    );
    if (rows.length === 0) {
      console.log(`[db] Applying migration: ${migration.name}`);
      await migration.up(db);
      await db.execute(
        "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)",
        [migration.name, new Date().toISOString()]
      );
      console.log(`[db] Migration applied: ${migration.name}`);
    }
  }
}

export async function initDb(dataDir: string): Promise<void> {
  const dbType = process.env.DATABASE_TYPE;

  if (dbType === "postgresql") {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required when DATABASE_TYPE=postgresql");
    }
    _adapter = createPostgresAdapter(connectionString);
    await runMigrations(_adapter);
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
    db = new Database(path.join(dataDir, "harness.db"));
    _adapter = createSqliteAdapter(db);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    await runMigrations(_adapter);
  }
}
