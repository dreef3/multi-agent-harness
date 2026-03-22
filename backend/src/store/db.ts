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

    CREATE TABLE IF NOT EXISTS projects (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'brainstorming',
      source_type         TEXT NOT NULL,
      source_json         TEXT NOT NULL,
      repository_ids      TEXT NOT NULL DEFAULT '[]',
      plan_json           TEXT,
      master_session_path TEXT NOT NULL DEFAULT '',
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL,
      seq_id      INTEGER NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      UNIQUE(project_id, seq_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_project_seq
      ON messages (project_id, seq_id);

    CREATE TABLE IF NOT EXISTS pull_requests (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, repository_id TEXT NOT NULL,
      agent_session_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL,
      url TEXT NOT NULL, branch TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_comments (
      id TEXT PRIMARY KEY, pull_request_id TEXT NOT NULL, external_id TEXT NOT NULL,
      author TEXT NOT NULL, body TEXT NOT NULL, file_path TEXT, line_number INTEGER,
      status TEXT NOT NULL DEFAULT 'pending', received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_review_comments_pr ON review_comments (pull_request_id, status);

    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  // Run idempotent ALTER TABLE migrations
  const addColumnIfMissing = (table: string, column: string, def: string) => {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    }
  };

  addColumnIfMissing("projects", "primary_repository_id", "TEXT");
  addColumnIfMissing("projects", "planning_branch", "TEXT");
  addColumnIfMissing("projects", "planning_pr_json", "TEXT");

  // Backfill primary_repository_id from first repositoryId
  database.exec(`
    UPDATE projects
    SET primary_repository_id = json_extract(repository_ids, '$[0]')
    WHERE primary_repository_id IS NULL
      AND json_array_length(repository_ids) > 0
  `);

  // Move any stale awaiting_approval projects to failed
  database.exec(`
    UPDATE projects SET status = 'failed' WHERE status = 'awaiting_approval'
  `);
}
