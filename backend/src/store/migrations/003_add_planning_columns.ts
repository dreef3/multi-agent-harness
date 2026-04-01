import type { DbAdapter } from "../adapter.js";

const isDuplicateColumn = (e: unknown): boolean => {
  if (!(e instanceof Error)) return false;
  const msg = e.message.toLowerCase();
  return msg.includes("duplicate column") || msg.includes("already exists");
};

export const migration = {
  name: "003_add_planning_columns",
  async up(db: DbAdapter): Promise<void> {
    for (const [col, def] of [["planning_branch", "TEXT"], ["planning_pr_json", "TEXT"]]) {
      try { await db.execAsync(`ALTER TABLE projects ADD COLUMN ${col} ${def}`); }
      catch (e: unknown) { if (!isDuplicateColumn(e)) throw e; }
    }
  },
};
