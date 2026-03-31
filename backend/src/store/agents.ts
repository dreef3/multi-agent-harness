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

export function insertAgentSession(session: AgentSession): void {
  db()
    .prepare(`INSERT INTO agent_sessions (id, project_id, type, repository_id, task_id, container_id, status, session_path, created_at, updated_at)
     VALUES (@id, @projectId, @type, @repositoryId, @taskId, @containerId, @status, @sessionPath, @createdAt, @updatedAt)`)
    .run({
      id: session.id, projectId: session.projectId, type: session.type,
      repositoryId: session.repositoryId ?? null, taskId: session.taskId ?? null,
      containerId: session.containerId ?? null, status: session.status,
      sessionPath: session.sessionPath ?? null, createdAt: session.createdAt, updatedAt: session.updatedAt,
    });
}

export function getAgentSession(id: string): AgentSession | null {
  const row = db().prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id) as AgentSessionRow | null;
  return row ? fromRow(row) : null;
}

export function listAgentSessions(projectId: string): AgentSession[] {
  const rows = db().prepare("SELECT * FROM agent_sessions WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as unknown as AgentSessionRow[];
  return rows.map(fromRow);
}

export function listStaleAgentSessions(): AgentSession[] {
  const rows = db()
    .prepare("SELECT * FROM agent_sessions WHERE status IN ('starting', 'running') AND type = 'sub'")
    .all() as unknown as AgentSessionRow[];
  return rows.map(fromRow);
}

export function updateAgentSession(id: string, updates: Partial<Omit<AgentSession, "id" | "projectId" | "type">>): void {
  const existing = getAgentSession(id);
  if (!existing) throw new Error(`AgentSession not found: ${id}`);
  const merged = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  db()
    .prepare(`UPDATE agent_sessions SET repository_id=@repositoryId, task_id=@taskId, container_id=@containerId,
             status=@status, session_path=@sessionPath, updated_at=@updatedAt WHERE id=@id`)
    .run({
      id: merged.id, repositoryId: merged.repositoryId ?? null, taskId: merged.taskId ?? null,
      containerId: merged.containerId ?? null, status: merged.status, sessionPath: merged.sessionPath ?? null, updatedAt: merged.updatedAt,
    });
}
