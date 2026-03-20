import { getDb } from "./db.js";
import type { Project, Plan } from "../models/types.js";

interface ProjectRow {
  id: string; name: string; status: string; source_type: string;
  source_json: string; repository_ids: string; plan_json: string | null;
  master_session_path: string; created_at: string; updated_at: string;
}

function fromRow(row: ProjectRow): Project {
  const source = JSON.parse(row.source_json) as Project["source"];
  return {
    id: row.id, name: row.name, status: row.status as Project["status"],
    source, repositoryIds: JSON.parse(row.repository_ids) as string[],
    plan: row.plan_json ? (JSON.parse(row.plan_json) as Plan) : undefined,
    masterSessionPath: row.master_session_path,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function insertProject(project: Project): void {
  getDb().prepare(`INSERT INTO projects (id, name, status, source_type, source_json, repository_ids, plan_json, master_session_path, created_at, updated_at) VALUES (@id, @name, @status, @sourceType, @sourceJson, @repositoryIds, @planJson, @masterSessionPath, @createdAt, @updatedAt)`).run({
    id: project.id, name: project.name, status: project.status,
    sourceType: project.source.type, sourceJson: JSON.stringify(project.source),
    repositoryIds: JSON.stringify(project.repositoryIds), planJson: project.plan ? JSON.stringify(project.plan) : null,
    masterSessionPath: project.masterSessionPath, createdAt: project.createdAt, updatedAt: project.updatedAt,
  });
}

export function getProject(id: string): Project | null {
  const row = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  return row ? fromRow(row) : null;
}

export function listProjects(): Project[] {
  return (getDb().prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as ProjectRow[]).map(fromRow);
}

export function updateProject(id: string, updates: Partial<Omit<Project, "id">>): void {
  const existing = getProject(id);
  if (!existing) throw new Error(`Project not found: ${id}`);
  const merged = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  getDb().prepare(`UPDATE projects SET name=@name, status=@status, source_type=@sourceType, source_json=@sourceJson, repository_ids=@repositoryIds, plan_json=@planJson, master_session_path=@masterSessionPath, updated_at=@updatedAt WHERE id=@id`).run({
    id: merged.id, name: merged.name, status: merged.status,
    sourceType: merged.source.type, sourceJson: JSON.stringify(merged.source),
    repositoryIds: JSON.stringify(merged.repositoryIds), planJson: merged.plan ? JSON.stringify(merged.plan) : null,
    masterSessionPath: merged.masterSessionPath, updatedAt: merged.updatedAt,
  });
}
