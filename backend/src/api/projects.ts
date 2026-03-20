import { Router } from "express";
import { randomUUID } from "crypto";
import { insertProject, getProject, listProjects, updateProject } from "../store/projects.js";
import { listMessages } from "../store/messages.js";
import { listAgentSessions } from "../store/agents.js";
import type { Project } from "../models/types.js";

export function createProjectsRouter(): Router {
  const router = Router();

  // List all projects
  router.get("/", (_req, res) => {
    const projects = listProjects();
    res.json(projects);
  });

  // Get a single project by ID
  router.get("/:id", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(project);
  });

  // Create a new project
  router.post("/", (req, res) => {
    const { name, source, repositoryIds } = req.body;
    if (!name || !source || !repositoryIds) {
      res.status(400).json({ error: "Missing required fields: name, source, repositoryIds" });
      return;
    }

    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name,
      status: "brainstorming",
      source,
      repositoryIds,
      masterSessionPath: "",
      createdAt: now,
      updatedAt: now,
    };

    insertProject(project);
    res.status(201).json(project);
  });

  // Update a project
  router.patch("/:id", (req, res) => {
    const { name, source, repositoryIds } = req.body;
    const existing = getProject(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const updates: Partial<Omit<Project, "id" | "createdAt">> = {};
    if (name !== undefined) updates.name = name;
    if (source !== undefined) updates.source = source;
    if (repositoryIds !== undefined) updates.repositoryIds = repositoryIds;

    updateProject(req.params.id, updates);
    res.json(getProject(req.params.id));
  });

  // Get project messages
  router.get("/:id/messages", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const messages = listMessages(req.params.id);
    res.json(messages);
  });

  // Get project agent sessions
  router.get("/:id/agents", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const sessions = listAgentSessions(req.params.id);
    res.json(sessions);
  });

  // Approve plan
  router.post("/:id/approve", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!project.plan) {
      res.status(400).json({ error: "No plan to approve" });
      return;
    }
    if (project.plan.approved) {
      res.status(400).json({ error: "Plan already approved" });
      return;
    }

    const approvedPlan = {
      ...project.plan,
      approved: true,
      approvedAt: new Date().toISOString(),
    };
    updateProject(req.params.id, { plan: approvedPlan, status: "executing" });
    res.json({ success: true, plan: approvedPlan });
  });

  // Cancel project
  router.post("/:id/cancel", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (project.status === "completed" || project.status === "cancelled") {
      res.status(400).json({ error: `Cannot cancel project with status: ${project.status}` });
      return;
    }

    updateProject(req.params.id, { status: "cancelled" });
    res.json({ success: true, status: "cancelled" });
  });

  return router;
}
