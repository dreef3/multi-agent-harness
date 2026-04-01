import type { DbAdapter } from "../adapter.js";

const isDuplicateColumn = (e: unknown): boolean => {
  if (!(e instanceof Error)) return false;
  const msg = e.message.toLowerCase();
  return msg.includes("duplicate column") || msg.includes("already exists");
};

export const migration = {
  name: "004_add_last_error",
  async up(db: DbAdapter): Promise<void> {
    try { await db.execAsync("ALTER TABLE projects ADD COLUMN last_error TEXT"); }
    catch (e: unknown) { if (!isDuplicateColumn(e)) throw e; }
    await db.execAsync("UPDATE projects SET status = 'failed' WHERE status = 'awaiting_approval'");
  },
};
