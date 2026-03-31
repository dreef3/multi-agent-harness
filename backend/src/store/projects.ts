import { getAdapter } from "./db.js";
import type { Project, Plan } from "../models/types.js";

const db = () => getAdapter();

interface ProjectRow {
  id: string; name: string; status: string; source_type: string;
  source_json: string; repository_ids: string; plan_json: string | null;
  master_session_path: string; created_at: string; updated_at: string;
  primary_repository_id: string | null;
  planning_branch: string | null;
  planning_pr_json: string | null;
  last_error: string | null;
}

function fromRow(row: ProjectRow): Project {
  const source = JSON.parse(row.source_json) as Project["source"];
  return {
    id: row.id, name: row.name, status: row.status as Project["status"],
    source, repositoryIds: JSON.parse(row.repository_ids) as string[],
    primaryRepositoryId: row.primary_repository_id ?? undefined,
    planningBranch: row.planning_branch ?? undefined,
    planningPr: row.planning_pr_json ? JSON.parse(row.planning_pr_json) : undefined,
    plan: row.plan_json ? (JSON.parse(row.plan_json) as Plan) : undefined,
    lastError: row.last_error ?? undefined,
    masterSessionPath: row.master_session_path,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function insertProject(project: Project): void {
  db().prepare(`
    INSERT INTO projects
      (id, name, status, source_type, source_json, repository_ids, plan_json,
       master_session_path, primary_repository_id, planning_branch, planning_pr_json,
       last_error, created_at, updated_at)
    VALUES
      (@id, @name, @status, @sourceType, @sourceJson, @repositoryIds, @planJson,
       @masterSessionPath, @primaryRepositoryId, @planningBranch, @planningPrJson,
       @lastError, @createdAt, @updatedAt)
  `).run({
    id: project.id, name: project.name, status: project.status,
    sourceType: project.source.type, sourceJson: JSON.stringify(project.source),
    repositoryIds: JSON.stringify(project.repositoryIds),
    planJson: project.plan ? JSON.stringify(project.plan) : null,
    masterSessionPath: project.masterSessionPath,
    primaryRepositoryId: project.primaryRepositoryId ?? null,
    planningBranch: project.planningBranch ?? null,
    planningPrJson: project.planningPr ? JSON.stringify(project.planningPr) : null,
    lastError: project.lastError ?? null,
    createdAt: project.createdAt, updatedAt: project.updatedAt,
  });
}

export function getProject(id: string): Project | null {
  const row = db().prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | null;
  return row ? fromRow(row) : null;
}

export function listProjects(): Project[] {
  return (db().prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as unknown as ProjectRow[]).map(fromRow);
}

export function listProjectsAwaitingLgtm(): Project[] {
  return (db().prepare(
    "SELECT * FROM projects WHERE status IN ('awaiting_spec_approval', 'awaiting_plan_approval')"
  ).all() as unknown as ProjectRow[]).map(fromRow);
}

export function listExecutingProjects(): Project[] {
  return (db().prepare(
    "SELECT * FROM projects WHERE status = 'executing'"
  ).all() as unknown as ProjectRow[]).map(fromRow);
}

export function updateTaskInPlan(
  projectId: string,
  taskId: string,
  updates: Partial<import("../models/types.js").PlanTask>
): void {
  const adapter = db();
  adapter.transaction(() => {
    const row = adapter.prepare("SELECT plan_json FROM projects WHERE id = ?").get(projectId) as { plan_json: string | null } | null;
    if (!row?.plan_json) return;
    const plan = JSON.parse(row.plan_json) as import("../models/types.js").Plan;
    const task = plan.tasks.find(t => t.id === taskId);
    if (task) Object.assign(task, updates);
    adapter.prepare("UPDATE projects SET plan_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(plan), new Date().toISOString(), projectId);
  });
}

export function deleteProject(id: string): void {
  const adapter = db();
  adapter.prepare("DELETE FROM messages WHERE project_id = ?").run(id);
  adapter.prepare("DELETE FROM agent_sessions WHERE project_id = ?").run(id);
  adapter.prepare("DELETE FROM pull_requests WHERE project_id = ?").run(id);
  adapter.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

export function updateProject(id: string, updates: Partial<Omit<Project, "id">>): void {
  const existing = getProject(id);
  if (!existing) throw new Error(`Project not found: ${id}`);
  const merged = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  db().prepare(`
    UPDATE projects
    SET name=@name, status=@status, source_type=@sourceType, source_json=@sourceJson,
        repository_ids=@repositoryIds, plan_json=@planJson,
        master_session_path=@masterSessionPath,
        primary_repository_id=@primaryRepositoryId,
        planning_branch=@planningBranch,
        planning_pr_json=@planningPrJson,
        last_error=@lastError,
        updated_at=@updatedAt
    WHERE id=@id
  `).run({
    id: merged.id, name: merged.name, status: merged.status,
    sourceType: merged.source.type, sourceJson: JSON.stringify(merged.source),
    repositoryIds: JSON.stringify(merged.repositoryIds),
    planJson: merged.plan ? JSON.stringify(merged.plan) : null,
    masterSessionPath: merged.masterSessionPath,
    primaryRepositoryId: merged.primaryRepositoryId ?? null,
    planningBranch: merged.planningBranch ?? null,
    planningPrJson: merged.planningPr ? JSON.stringify(merged.planningPr) : null,
    lastError: merged.lastError ?? null,
    updatedAt: merged.updatedAt,
  });
}
