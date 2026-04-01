import { getAdapter } from "./db.js";
import type { AgentSession } from "../models/types.js";

const db = () => getAdapter();

interface AgentSessionRow {
  id: string; project_id: string; type: string; repository_id: string | null;
  task_id: string | null; container_id: string | null; status: string;
  session_path: string | null; created_at: string; updated_at: string;
}

function fromRow(row: AgentSessionRow): AgentSession {
  return {
    id: row.id, projectId: row.project_id, type: row.type as AgentSession["type"],
    repositoryId: row.repository_id ?? undefined, taskId: row.task_id ?? undefined,
    containerId: row.container_id ?? undefined, status: row.status as AgentSession["status"],
    sessionPath: row.session_path ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function insertAgentSession(session: AgentSession): Promise<void> {
  await db().execute(
    `INSERT INTO agent_sessions (id, project_id, type, repository_id, task_id, container_id, status, session_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      session.id, session.projectId, session.type,
      session.repositoryId ?? null, session.taskId ?? null,
      session.containerId ?? null, session.status,
      session.sessionPath ?? null, session.createdAt, session.updatedAt,
    ]
  );
}

export async function getAgentSession(id: string): Promise<AgentSession | null> {
  const rows = await db().query<AgentSessionRow>("SELECT * FROM agent_sessions WHERE id = ?", [id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function listAgentSessions(projectId: string): Promise<AgentSession[]> {
  const rows = await db().query<AgentSessionRow>(
    "SELECT * FROM agent_sessions WHERE project_id = ? ORDER BY created_at DESC", [projectId]
  );
  return rows.map(fromRow);
}

export async function listStaleAgentSessions(): Promise<AgentSession[]> {
  const rows = await db().query<AgentSessionRow>(
    "SELECT * FROM agent_sessions WHERE status IN ('starting', 'running') AND type = 'sub'"
  );
  return rows.map(fromRow);
}

export async function updateAgentSession(id: string, updates: Partial<Omit<AgentSession, "id" | "projectId" | "type">>): Promise<void> {
  const existing = await getAgentSession(id);
  if (!existing) throw new Error(`AgentSession not found: ${id}`);
  const merged = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  await db().execute(
    `UPDATE agent_sessions SET repository_id=?, task_id=?, container_id=?,
     status=?, session_path=?, updated_at=? WHERE id=?`,
    [
      merged.repositoryId ?? null, merged.taskId ?? null,
      merged.containerId ?? null, merged.status, merged.sessionPath ?? null,
      merged.updatedAt, merged.id,
    ]
  );
}
