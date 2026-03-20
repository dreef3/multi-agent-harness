import { getDb } from "./db.js";
import type { Repository } from "../models/types.js";

interface RepositoryRow {
  id: string;
  name: string;
  clone_url: string;
  provider: string;
  provider_config: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
}

function fromRow(row: RepositoryRow): Repository {
  return {
    id: row.id,
    name: row.name,
    cloneUrl: row.clone_url,
    provider: row.provider as Repository["provider"],
    providerConfig: JSON.parse(row.provider_config) as Repository["providerConfig"],
    defaultBranch: row.default_branch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertRepository(repo: Repository): void {
  getDb()
    .prepare(
      `INSERT INTO repositories (id, name, clone_url, provider, provider_config, default_branch, created_at, updated_at)
       VALUES (@id, @name, @cloneUrl, @provider, @providerConfig, @defaultBranch, @createdAt, @updatedAt)`
    )
    .run({
      id: repo.id, name: repo.name, cloneUrl: repo.cloneUrl,
      provider: repo.provider, providerConfig: JSON.stringify(repo.providerConfig),
      defaultBranch: repo.defaultBranch, createdAt: repo.createdAt, updatedAt: repo.updatedAt,
    });
}

export function getRepository(id: string): Repository | null {
  const row = getDb().prepare("SELECT * FROM repositories WHERE id = ?").get(id) as RepositoryRow | undefined;
  return row ? fromRow(row) : null;
}

export function listRepositories(): Repository[] {
  const rows = getDb().prepare("SELECT * FROM repositories ORDER BY created_at DESC").all() as RepositoryRow[];
  return rows.map(fromRow);
}

export function updateRepository(id: string, updates: Partial<Omit<Repository, "id">>): void {
  const existing = getRepository(id);
  if (!existing) throw new Error(`Repository not found: ${id}`);
  const merged = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  getDb()
    .prepare(`UPDATE repositories SET name=@name, clone_url=@cloneUrl, provider=@provider,
             provider_config=@providerConfig, default_branch=@defaultBranch, updated_at=@updatedAt WHERE id=@id`)
    .run({
      id: merged.id, name: merged.name, cloneUrl: merged.cloneUrl,
      provider: merged.provider, providerConfig: JSON.stringify(merged.providerConfig),
      defaultBranch: merged.defaultBranch, updatedAt: merged.updatedAt,
    });
}

export function deleteRepository(id: string): void {
  getDb().prepare("DELETE FROM repositories WHERE id = ?").run(id);
}
