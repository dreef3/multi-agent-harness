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

export async function appendMessage(projectId: string, role: "user" | "assistant", content: string): Promise<ChatMessage> {
  const adapter = db();
  const createdAt = new Date().toISOString();
  // Inline subquery makes seq_id computation + INSERT a single atomic statement,
  // preventing the UNIQUE constraint race when concurrent appends run for the
  // same project. The SQLite adapter's execute() is synchronous under the hood,
  // so no other append can interleave between the subquery and the write.
  await adapter.execute(
    `INSERT INTO messages (project_id, seq_id, role, content, created_at)
     VALUES (?, (SELECT COALESCE(MAX(seq_id), 0) + 1 FROM messages WHERE project_id = ?), ?, ?, ?)`,
    [projectId, projectId, role, content, createdAt]
  );
  const rows = await adapter.query<MessageRow>(
    "SELECT * FROM messages WHERE project_id = ? ORDER BY seq_id DESC LIMIT 1", [projectId]
  );
  return fromRow(rows[0]!);
}

export async function listMessages(projectId: string): Promise<ChatMessage[]> {
  const rows = await db().query<MessageRow>(
    "SELECT * FROM messages WHERE project_id = ? ORDER BY seq_id ASC", [projectId]
  );
  return rows.map(fromRow);
}

export async function listMessagesSince(projectId: string, afterSeqId: number): Promise<ChatMessage[]> {
  const rows = await db().query<MessageRow>(
    "SELECT * FROM messages WHERE project_id = ? AND seq_id > ? ORDER BY seq_id ASC", [projectId, afterSeqId]
  );
  return rows.map(fromRow);
}
