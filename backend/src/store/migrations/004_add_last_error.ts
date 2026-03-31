import type { DbAdapter } from "../adapter.js";

export const migration = {
  name: "004_add_last_error",
  async up(db: DbAdapter): Promise<void> {
    try { await db.execAsync("ALTER TABLE projects ADD COLUMN last_error TEXT"); }
    catch (e: unknown) { if (!(e instanceof Error) || !e.message.includes("duplicate column")) throw e; }
    await db.execAsync("UPDATE projects SET status = 'failed' WHERE status = 'awaiting_approval'");
  },
};
