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
  // Use transactionAsync to atomically compute and claim the next seq_id,
  // preventing the UNIQUE constraint race when concurrent messages are persisted.
  return adapter.transactionAsync(async (tx) => {
    const maxRows = await tx.query<{ max_seq: number }>(
      "SELECT COALESCE(MAX(seq_id), 0) as max_seq FROM messages WHERE project_id = ?", [projectId]
    );
    const seqId = (maxRows[0]?.max_seq ?? 0) + 1;
    await tx.execute(
      `INSERT INTO messages (project_id, seq_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      [projectId, seqId, role, content, createdAt]
    );
    const rows = await tx.query<MessageRow>(
      "SELECT * FROM messages WHERE project_id = ? AND seq_id = ?", [projectId, seqId]
    );
    return fromRow(rows[0]!);
  });
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
