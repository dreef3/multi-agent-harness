import type { DbAdapter } from "../adapter.js";

export const migration = {
  name: "001_initial_schema",
  async up(db: DbAdapter): Promise<void> {
    await db.execAsync(`
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

      CREATE TABLE IF NOT EXISTS agent_events (
        session_id  TEXT NOT NULL,
        type        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        timestamp   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_events_session
        ON agent_events (session_id);

      CREATE TABLE IF NOT EXISTS task_queue (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        queued_at   TEXT NOT NULL,
        priority    INTEGER NOT NULL DEFAULT 0,
        status      TEXT NOT NULL DEFAULT 'queued'
      );

      CREATE INDEX IF NOT EXISTS idx_task_queue_status
        ON task_queue (status, priority DESC, queued_at ASC);
    `);
  },
};
