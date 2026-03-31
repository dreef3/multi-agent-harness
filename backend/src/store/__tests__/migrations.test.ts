import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { createSqliteAdapter } from "../sqliteAdapter.js";
import { runMigrations } from "../db.js";

describe("runMigrations", () => {
  it("applies all migrations to a fresh database", async () => {
    const rawDb = new Database(":memory:");
    const adapter = createSqliteAdapter(rawDb);
    await runMigrations(adapter);

    const rows = await adapter.query("SELECT name FROM schema_migrations ORDER BY name");
    const names = rows.map(r => r.name as string);
    expect(names).toContain("001_initial_schema");
    expect(names).toContain("002_add_primary_repository_id");
    expect(names).toContain("003_add_planning_columns");
    expect(names).toContain("004_add_last_error");
    expect(names).toContain("005_add_auth_tables");
    expect(names.length).toBe(5);
  });

  it("is idempotent — running twice does not error", async () => {
    const rawDb = new Database(":memory:");
    const adapter = createSqliteAdapter(rawDb);
    await runMigrations(adapter);
    await runMigrations(adapter); // second run should be no-op
    const rows = await adapter.query("SELECT name FROM schema_migrations");
    expect(rows.length).toBe(5);
  });

  it("skips already-applied migrations", async () => {
    const rawDb = new Database(":memory:");
    const adapter = createSqliteAdapter(rawDb);
    // Apply all migrations first
    await runMigrations(adapter);
    // Track how many rows are there
    const before = await adapter.query("SELECT name FROM schema_migrations");
    // Run again — no new rows should be added
    await runMigrations(adapter);
    const after = await adapter.query("SELECT name FROM schema_migrations");
    expect(after.length).toBe(before.length);
  });
});
