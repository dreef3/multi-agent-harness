export interface AgentEvent {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

const store = new Map<string, AgentEvent[]>();

export function appendEvent(sessionId: string, event: AgentEvent): void {
  const events = store.get(sessionId) ?? [];
  events.push(event);
  store.set(sessionId, events);
}

export function getEvents(sessionId: string): AgentEvent[] {
  return store.get(sessionId) ?? [];
}

export function clearEvents(sessionId: string): void {
  store.delete(sessionId);
}
