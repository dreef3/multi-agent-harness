import type { DbAdapter } from "../adapter.js";

export const migration = {
  name: "005_add_auth_tables",
  async up(db: DbAdapter): Promise<void> {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        email        TEXT NOT NULL,
        display_name TEXT NOT NULL,
        roles        TEXT NOT NULL DEFAULT '[]',
        last_seen    TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id           TEXT PRIMARY KEY,
        timestamp    TEXT NOT NULL,
        user_id      TEXT,
        action       TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id  TEXT NOT NULL,
        details      TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log (timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log (user_id);
    `);
  },
};
