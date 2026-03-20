import { Router } from "express";
import { randomUUID } from "crypto";
import { insertAgentSession, getAgentSession, updateAgentSession } from "../store/agents.js";
import { getProject } from "../store/projects.js";
import type { AgentSession } from "../models/types.js";

export function createAgentsRouter(): Router {
  const router = Router();

  // Get a single agent session by ID
  router.get("/:id", (req, res) => {
    const session = getAgentSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Agent session not found" });
      return;
    }
    res.json(session);
  });

  // Create a new agent session (sub-agent)
  router.post("/", (req, res) => {
    const { projectId, type, repositoryId, taskId } = req.body;
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
      type,
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
  router.patch("/:id", (req, res) => {
    const { repositoryId, taskId, containerId, status, sessionPath } = req.body;
    const existing = getAgentSession(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Agent session not found" });
      return;
    }

    const updates: Partial<Omit<AgentSession, "id" | "projectId" | "type" | "createdAt">> = {};
    if (repositoryId !== undefined) updates.repositoryId = repositoryId;
    if (taskId !== undefined) updates.taskId = taskId;
    if (containerId !== undefined) updates.containerId = containerId;
    if (status !== undefined) updates.status = status;
    if (sessionPath !== undefined) updates.sessionPath = sessionPath;

    updateAgentSession(req.params.id, updates);
    res.json(getAgentSession(req.params.id));
  });

  // Stop an agent session
  router.post("/:id/stop", (req, res) => {
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
    res.json({ success: true, status: "stopped" });
  });

  return router;
}
