import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized — call initDb() first.");
  return db;
}

export function initDb(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(path.join(dataDir, "harness.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      clone_url     TEXT NOT NULL,
      provider      TEXT NOT NULL,
      provider_config TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL,
      type          TEXT NOT NULL,
      repository_id TEXT,
      task_id       TEXT,
      container_id  TEXT,
      status        TEXT NOT NULL DEFAULT 'starting',
      session_path  TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
  `);
}
