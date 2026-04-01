import { getAdapter } from "./db.js";

const db = () => getAdapter();

export interface AgentEvent {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export async function appendEvent(sessionId: string, event: AgentEvent): Promise<void> {
  await db().execute(
    "INSERT INTO agent_events (session_id, type, payload, timestamp) VALUES (?, ?, ?, ?)",
    [sessionId, event.type, JSON.stringify(event.payload), event.timestamp]
  );
}

export async function getEvents(sessionId: string): Promise<AgentEvent[]> {
  const rows = await db().query<{ type: string; payload: string; timestamp: string }>(
    "SELECT type, payload, timestamp FROM agent_events WHERE session_id = ? ORDER BY rowid",
    [sessionId]
  );
  return rows.map((r) => ({
    type: r.type,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    timestamp: r.timestamp,
  }));
}

export async function clearEvents(sessionId: string): Promise<void> {
  await db().execute("DELETE FROM agent_events WHERE session_id = ?", [sessionId]);
}
