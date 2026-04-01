import type { DbAdapter } from "../adapter.js";

export const migration = {
  name: "006_add_attribution_columns",
  async up(db: DbAdapter): Promise<void> {
    for (const stmt of [
      "ALTER TABLE projects ADD COLUMN created_by TEXT",
      "ALTER TABLE agent_sessions ADD COLUMN triggered_by TEXT",
    ]) {
      try { await db.execAsync(stmt); }
      catch (e: unknown) {
        const msg = e instanceof Error ? e.message.toLowerCase() : "";
        if (!msg.includes("duplicate column") && !msg.includes("already exists")) throw e;
      }
    }
  },
};
