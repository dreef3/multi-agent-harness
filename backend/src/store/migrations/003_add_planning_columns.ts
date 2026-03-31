import type { DbAdapter } from "../adapter.js";

export const migration = {
  name: "003_add_planning_columns",
  async up(db: DbAdapter): Promise<void> {
    for (const [col, def] of [["planning_branch", "TEXT"], ["planning_pr_json", "TEXT"]]) {
      try { await db.execAsync(`ALTER TABLE projects ADD COLUMN ${col} ${def}`); }
      catch (e: unknown) { if (!(e instanceof Error) || !e.message.includes("duplicate column")) throw e; }
    }
  },
};
