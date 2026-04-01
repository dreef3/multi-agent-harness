import type { DbAdapter } from "../adapter.js";
import { migration as m001 } from "./001_initial_schema.js";
import { migration as m002 } from "./002_add_primary_repository_id.js";
import { migration as m003 } from "./003_add_planning_columns.js";
import { migration as m004 } from "./004_add_last_error.js";
import { migration as m005 } from "./005_add_auth_tables.js";
import { migration as m006 } from "./006_add_attribution_columns.js";

export interface Migration {
  name: string;
  up(db: DbAdapter): Promise<void>;
}

export const migrations: Migration[] = [m001, m002, m003, m004, m005, m006];
