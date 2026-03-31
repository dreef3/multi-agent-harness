import { getAdapter } from "./db.js";

const db = () => getAdapter();

export interface ChatMessage {
  id: number; projectId: string; seqId: number;
  role: "user" | "assistant"; content: string; createdAt: string;
}

interface MessageRow { id: number; project_id: string; seq_id: number; role: string; content: string; created_at: string; }

function fromRow(row: MessageRow): ChatMessage {
  return { id: row.id, projectId: row.project_id, seqId: row.seq_id, role: row.role as ChatMessage["role"], content: row.content, createdAt: row.created_at };
}

export function appendMessage(projectId: string, role: "user" | "assistant", content: string): ChatMessage {
  const adapter = db();
  const maxRow = adapter.prepare("SELECT COALESCE(MAX(seq_id), 0) as max_seq FROM messages WHERE project_id = ?").get(projectId) as { max_seq: number } | null;
  const seqId = (maxRow?.max_seq ?? 0) + 1;
  const createdAt = new Date().toISOString();
  const info = adapter.prepare(`INSERT INTO messages (project_id, seq_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`).run(projectId, seqId, role, content, createdAt);
  return { id: info.lastInsertRowid as number, projectId, seqId, role, content, createdAt };
}

export function listMessages(projectId: string): ChatMessage[] {
  return (db().prepare("SELECT * FROM messages WHERE project_id = ? ORDER BY seq_id ASC").all(projectId) as unknown as MessageRow[]).map(fromRow);
}

export function listMessagesSince(projectId: string, afterSeqId: number): ChatMessage[] {
  return (db().prepare("SELECT * FROM messages WHERE project_id = ? AND seq_id > ? ORDER BY seq_id ASC").all(projectId, afterSeqId) as unknown as MessageRow[]).map(fromRow);
}
