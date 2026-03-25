import { getPlanningAgentManager } from "./planningAgentManager.js";
import { broadcastStuckAgent } from "../api/websocket.js";

const STUCK_TIMEOUT_MS = 4 * 60 * 1000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function resetHeartbeat(
  sessionId: string,
  projectId: string,
  taskDescription: string
): void {
  const existing = timers.get(sessionId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    timers.delete(sessionId);
    try {
      await getPlanningAgentManager().injectMessage(
        projectId,
        `[Sub-agent: ${taskDescription}] has had no activity for 4 minutes — it may be stuck.`
      );
    } catch {
      // planning agent may not be running; best-effort
    }
    try {
      broadcastStuckAgent(projectId, sessionId);
    } catch {
      // best-effort
    }
  }, STUCK_TIMEOUT_MS);

  timers.set(sessionId, timer);
}

export function clearHeartbeat(sessionId: string): void {
  const t = timers.get(sessionId);
  if (t) {
    clearTimeout(t);
    timers.delete(sessionId);
  }
}
