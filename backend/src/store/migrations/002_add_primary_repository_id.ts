import type { DbAdapter } from "../adapter.js";

export const migration = {
  name: "002_add_primary_repository_id",
  async up(db: DbAdapter): Promise<void> {
    try { await db.execAsync("ALTER TABLE projects ADD COLUMN primary_repository_id TEXT"); }
    catch (e: unknown) { if (!(e instanceof Error) || !e.message.includes("duplicate column")) throw e; }
    await db.execAsync(`UPDATE projects SET primary_repository_id = json_extract(repository_ids, '$[0]') WHERE primary_repository_id IS NULL AND json_array_length(repository_ids) > 0`);
  },
};
