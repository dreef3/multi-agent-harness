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
  planning_agent_json: string | null;
  implementation_agent_json: string | null;
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
    planningAgent: row.planning_agent_json ? JSON.parse(row.planning_agent_json) : undefined,
    implementationAgent: row.implementation_agent_json ? JSON.parse(row.implementation_agent_json) : undefined,
  };
}

export async function insertProject(project: Project): Promise<void> {
  await db().execute(`
    INSERT INTO projects
      (id, name, status, source_type, source_json, repository_ids, plan_json,
       master_session_path, primary_repository_id, planning_branch, planning_pr_json,
       last_error, created_at, updated_at, planning_agent_json, implementation_agent_json)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    project.id, project.name, project.status,
    project.source.type, JSON.stringify(project.source),
    JSON.stringify(project.repositoryIds),
    project.plan ? JSON.stringify(project.plan) : null,
    project.masterSessionPath,
    project.primaryRepositoryId ?? null,
    project.planningBranch ?? null,
    project.planningPr ? JSON.stringify(project.planningPr) : null,
    project.lastError ?? null,
    project.createdAt, project.updatedAt,
    project.planningAgent ? JSON.stringify(project.planningAgent) : null,
    project.implementationAgent ? JSON.stringify(project.implementationAgent) : null,
  ]);
}

export async function getProject(id: string): Promise<Project | null> {
  const rows = await db().query<ProjectRow>("SELECT * FROM projects WHERE id = ?", [id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function listProjects(): Promise<Project[]> {
  const rows = await db().query<ProjectRow>("SELECT * FROM projects ORDER BY created_at DESC");
  return rows.map(fromRow);
}

export async function listProjectsAwaitingLgtm(): Promise<Project[]> {
  const rows = await db().query<ProjectRow>(
    "SELECT * FROM projects WHERE status IN ('awaiting_spec_approval', 'awaiting_plan_approval')"
  );
  return rows.map(fromRow);
}

export async function listExecutingProjects(): Promise<Project[]> {
  const rows = await db().query<ProjectRow>(
    "SELECT * FROM projects WHERE status = 'executing'"
  );
  return rows.map(fromRow);
}

export async function updateTaskInPlan(
  projectId: string,
  taskId: string,
  updates: Partial<import("../models/types.js").PlanTask>
): Promise<void> {
  await db().transactionAsync(async (tx) => {
    const rows = await tx.query<{ plan_json: string | null }>(
      "SELECT plan_json FROM projects WHERE id = ?", [projectId]
    );
    const row = rows[0];
    if (!row?.plan_json) return;
    const plan = JSON.parse(row.plan_json) as import("../models/types.js").Plan;
    const task = plan.tasks.find(t => t.id === taskId);
    if (task) Object.assign(task, updates);
    await tx.execute(
      "UPDATE projects SET plan_json = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(plan), new Date().toISOString(), projectId]
    );
  });
}

export async function deleteProject(id: string): Promise<void> {
  const adapter = db();
  await adapter.execute("DELETE FROM messages WHERE project_id = ?", [id]);
  await adapter.execute("DELETE FROM agent_sessions WHERE project_id = ?", [id]);
  await adapter.execute("DELETE FROM pull_requests WHERE project_id = ?", [id]);
  await adapter.execute("DELETE FROM projects WHERE id = ?", [id]);
}

export async function updateProject(id: string, updates: Partial<Omit<Project, "id">>): Promise<void> {
  const existing = await getProject(id);
  if (!existing) throw new Error(`Project not found: ${id}`);
  const merged = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  await db().execute(`
    UPDATE projects
    SET name=?, status=?, source_type=?, source_json=?,
        repository_ids=?, plan_json=?,
        master_session_path=?,
        primary_repository_id=?,
        planning_branch=?,
        planning_pr_json=?,
        last_error=?,
        updated_at=?,
        planning_agent_json=?,
        implementation_agent_json=?
    WHERE id=?
  `, [
    merged.name, merged.status,
    merged.source.type, JSON.stringify(merged.source),
    JSON.stringify(merged.repositoryIds),
    merged.plan ? JSON.stringify(merged.plan) : null,
    merged.masterSessionPath,
    merged.primaryRepositoryId ?? null,
    merged.planningBranch ?? null,
    merged.planningPr ? JSON.stringify(merged.planningPr) : null,
    merged.lastError ?? null,
    merged.updatedAt,
    merged.planningAgent ? JSON.stringify(merged.planningAgent) : null,
    merged.implementationAgent ? JSON.stringify(merged.implementationAgent) : null,
    merged.id,
  ]);
}
