import { getAdapter } from "./db.js";
import type { Repository } from "../models/types.js";

const db = () => getAdapter();

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

export async function insertRepository(repo: Repository): Promise<void> {
  await db().execute(
    `INSERT INTO repositories (id, name, clone_url, provider, provider_config, default_branch, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [repo.id, repo.name, repo.cloneUrl, repo.provider, JSON.stringify(repo.providerConfig),
     repo.defaultBranch, repo.createdAt, repo.updatedAt]
  );
}

export async function getRepository(id: string): Promise<Repository | null> {
  const rows = await db().query<RepositoryRow>("SELECT * FROM repositories WHERE id = ?", [id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function listRepositories(): Promise<Repository[]> {
  const rows = await db().query<RepositoryRow>("SELECT * FROM repositories ORDER BY created_at DESC");
  return rows.map(fromRow);
}

export async function updateRepository(id: string, updates: Partial<Omit<Repository, "id">>): Promise<void> {
  const existing = await getRepository(id);
  if (!existing) throw new Error(`Repository not found: ${id}`);
  const merged = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  await db().execute(
    `UPDATE repositories SET name=?, clone_url=?, provider=?,
     provider_config=?, default_branch=?, updated_at=? WHERE id=?`,
    [merged.name, merged.cloneUrl, merged.provider, JSON.stringify(merged.providerConfig),
     merged.defaultBranch, merged.updatedAt, merged.id]
  );
}

export async function deleteRepository(id: string): Promise<void> {
  await db().execute("DELETE FROM repositories WHERE id = ?", [id]);
}
