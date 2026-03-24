import { getDb } from "./db.js";

export interface AgentEvent {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export function appendEvent(sessionId: string, event: AgentEvent): void {
  getDb()
    .prepare(
      "INSERT INTO agent_events (session_id, type, payload, timestamp) VALUES (?, ?, ?, ?)"
    )
    .run(sessionId, event.type, JSON.stringify(event.payload), event.timestamp);
}

export function getEvents(sessionId: string): AgentEvent[] {
  const rows = getDb()
    .prepare(
      "SELECT type, payload, timestamp FROM agent_events WHERE session_id = ? ORDER BY rowid"
    )
    .all(sessionId) as Array<{ type: string; payload: string; timestamp: string }>;
  return rows.map((r) => ({
    type: r.type,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    timestamp: r.timestamp,
  }));
}

export function clearEvents(sessionId: string): void {
  getDb()
    .prepare("DELETE FROM agent_events WHERE session_id = ?")
    .run(sessionId);
}
