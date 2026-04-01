import type { DbAdapter } from "../adapter.js";

const isDuplicateColumn = (e: unknown): boolean => {
  if (!(e instanceof Error)) return false;
  const msg = e.message.toLowerCase();
  return msg.includes("duplicate column") || msg.includes("already exists");
};

export const migration = {
  name: "002_add_primary_repository_id",
  async up(db: DbAdapter): Promise<void> {
    try { await db.execAsync("ALTER TABLE projects ADD COLUMN primary_repository_id TEXT"); }
    catch (e: unknown) { if (!isDuplicateColumn(e)) throw e; }
    await db.execAsync(`UPDATE projects SET primary_repository_id = json_extract(repository_ids, '$[0]') WHERE primary_repository_id IS NULL AND json_array_length(repository_ids) > 0`);
  },
};
