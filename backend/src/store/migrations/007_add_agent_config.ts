import type { DbAdapter } from "../adapter.js";

export const migration = {
  name: "007_add_agent_config",
  async up(db: DbAdapter): Promise<void> {
    await db.execAsync(`
      ALTER TABLE projects ADD COLUMN planning_agent_json TEXT DEFAULT NULL
    `);
    await db.execAsync(`
      ALTER TABLE projects ADD COLUMN implementation_agent_json TEXT DEFAULT NULL
    `);
  },
};
