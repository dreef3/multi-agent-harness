import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import {
  insertAgentSession,
  getAgentSession,
  updateAgentSession,
} from "../store/agents.js";
import { getProject } from "../store/projects.js";
import { appendEvent, getEvents } from "../store/agentEvents.js";
import { getPlanningAgentManager } from "../orchestrator/planningAgentManager.js";
import { resetHeartbeat, clearHeartbeat } from "../orchestrator/heartbeatMonitor.js";
import { broadcastAgentActivity } from "./websocket.js";
import type { AgentSession } from "../models/types.js";

// msgId → { resolve, timeout }
const pendingMessages = new Map<string, {
  resolve: (reply: string) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

/** Look up the human-readable task description for a session's taskId. */
function resolveTaskDescription(session: AgentSession): string {
  if (!session.taskId) return "unknown task";
  const project = getProject(session.projectId);
  const task = project?.plan?.tasks.find((t) => t.id === session.taskId);
  return task?.description?.slice(0, 80) ?? session.taskId;
}

export function createAgentsRouter(): Router {
  const router = Router();

  // --- Existing CRUD endpoints ---

  // Get a single agent session by ID
  router.get("/:id", (req: Request, res: Response) => {
    const session = getAgentSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Agent session not found" });
      return;
    }
    res.json(session);
  });

  // Create a new agent session (sub-agent)
  router.post("/", (req: Request, res: Response) => {
    const { projectId, type, repositoryId, taskId } = req.body as {
      projectId?: string;
      type?: string;
      repositoryId?: string;
      taskId?: string;
    };
    if (!projectId || !type) {
      res.status(400).json({ error: "Missing required fields: projectId, type" });
      return;
    }

    const project = getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const now = new Date().toISOString();
    const session: AgentSession = {
      id: randomUUID(),
      projectId,
      type: type as AgentSession["type"],
      repositoryId,
      taskId,
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };

    insertAgentSession(session);
    res.status(201).json(session);
  });

  // Update an agent session
  router.patch("/:id", (req: Request, res: Response) => {
    const { repositoryId, taskId, containerId, status, sessionPath } = req.body as {
      repositoryId?: string;
      taskId?: string;
      containerId?: string;
      status?: string;
      sessionPath?: string;
    };
    const existing = getAgentSession(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Agent session not found" });
      return;
    }

    const updates: Partial<Omit<AgentSession, "id" | "projectId" | "type" | "createdAt">> = {};
    if (repositoryId !== undefined) updates.repositoryId = repositoryId;
    if (taskId !== undefined) updates.taskId = taskId;
    if (containerId !== undefined) updates.containerId = containerId;
    if (status !== undefined) updates.status = status as AgentSession["status"];
    if (sessionPath !== undefined) updates.sessionPath = sessionPath;

    updateAgentSession(req.params.id, updates);

    // Clear stuck timer when session reaches a terminal state
    if (status === "completed" || status === "failed" || status === "stopped") {
      clearHeartbeat(req.params.id);
    }

    res.json(getAgentSession(req.params.id));
  });

  // Stop an agent session
  router.post("/:id/stop", (req: Request, res: Response) => {
    const session = getAgentSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Agent session not found" });
      return;
    }
    if (session.status === "completed" || session.status === "failed" || session.status === "stopped") {
      res.status(400).json({ error: `Cannot stop agent with status: ${session.status}` });
      return;
    }

    updateAgentSession(req.params.id, { status: "stopped" });
    clearHeartbeat(req.params.id);
    res.json({ success: true, status: "stopped" });
  });

  // --- New: sub-agent blocking message request ---
  router.post("/:id/message", async (req: Request, res: Response) => {
    const session = getAgentSession(req.params.id);
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }
    const { question } = req.body as { question?: string };
    if (!question) { res.status(400).json({ error: "Missing question" }); return; }

    const msgId = randomUUID();
    const taskDesc = resolveTaskDescription(session);
    const TIMEOUT_MS = 5 * 60 * 1000;

    // Store the question as an outbound message event on the sub-agent's feed
    const ts = new Date().toISOString();
    appendEvent(req.params.id, {
      type: "message_out",
      payload: { text: question },
      timestamp: ts,
    });
    broadcastAgentActivity(session.projectId, req.params.id, {
      type: "message_out",
      payload: { text: question },
      timestamp: ts,
    });

    // Hoist the resolve + timeout handle so the catch block can cancel the timer.
    // Note: the 5-min long-poll is intentionally longer than the 4-min heartbeat stuck
    // threshold — sub-agent runners send heartbeats every 2 min via setInterval
    // independently, so they keep pinging even while blocked here.
    let replyResolve!: (reply: string) => void;
    let timeoutHandle!: ReturnType<typeof setTimeout>;

    const replyPromise = new Promise<string>((resolve) => {
      replyResolve = resolve;
      timeoutHandle = setTimeout(() => {
        pendingMessages.delete(msgId);
        resolve("[TIMEOUT] No reply within 5 minutes.");
      }, TIMEOUT_MS);
      pendingMessages.set(msgId, { resolve: replyResolve, timeout: timeoutHandle });
    });

    try {
      getPlanningAgentManager().injectMessage(
        session.projectId,
        `[msgId: ${msgId}] [Sub-agent: ${taskDesc}] asks: ${question}`
      );
    } catch {
      clearTimeout(timeoutHandle);
      pendingMessages.delete(msgId);
      res.status(503).json({ error: "Planning agent not available" });
      return;
    }

    const reply = await replyPromise;

    // Store the reply as an inbound message event
    const replyTs = new Date().toISOString();
    appendEvent(req.params.id, {
      type: "message_in",
      payload: { text: reply, from: "Planning Agent" },
      timestamp: replyTs,
    });
    broadcastAgentActivity(session.projectId, req.params.id, {
      type: "message_in",
      payload: { text: reply, from: "Planning Agent" },
      timestamp: replyTs,
    });

    res.json({ reply });
  });

  // --- New: planning agent delivers reply ---
  router.post("/:id/message/:msgId/reply", (req: Request, res: Response) => {
    const session = getAgentSession(req.params.id);
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }
    const { msgId } = req.params;
    const { reply } = req.body as { reply?: string };
    if (!reply) { res.status(400).json({ error: "Missing reply" }); return; }

    const pending = pendingMessages.get(msgId);
    if (!pending) { res.status(404).json({ error: "No pending message with that msgId" }); return; }

    clearTimeout(pending.timeout);
    pendingMessages.delete(msgId);
    pending.resolve(reply);
    res.json({ ok: true });
  });

  // --- New: sub-agent posts activity event ---
  router.post("/:id/events", (req: Request, res: Response) => {
    const session = getAgentSession(req.params.id);
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }
    const event = req.body as { type?: string; payload?: Record<string, unknown>; timestamp?: string };
    if (!event.type || typeof event.type !== "string") {
      res.status(400).json({ error: "Missing or invalid type" });
      return;
    }
    appendEvent(req.params.id, event as { type: string; payload: Record<string, unknown>; timestamp: string });
    broadcastAgentActivity(session.projectId, req.params.id, event);
    res.json({ ok: true });
  });

  // --- New: fetch accumulated events ---
  router.get("/:id/events", (req: Request, res: Response) => {
    const session = getAgentSession(req.params.id);
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }
    res.json(getEvents(req.params.id));
  });

  // --- New: heartbeat ---
  router.post("/:id/heartbeat", (req: Request, res: Response) => {
    const session = getAgentSession(req.params.id);
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }
    const taskDesc = resolveTaskDescription(session);
    resetHeartbeat(req.params.id, session.projectId, taskDesc);
    res.json({ ok: true });
  });

  return router;
}
