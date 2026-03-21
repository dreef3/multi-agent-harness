import { Router } from "express";
import type Dockerode from "dockerode";
import { randomUUID } from "crypto";
import { insertProject, getProject, listProjects, updateProject } from "../store/projects.js";
import { listMessages } from "../store/messages.js";
import { listAgentSessions } from "../store/agents.js";
import type { Project } from "../models/types.js";
import { TaskDispatcher } from "../orchestrator/taskDispatcher.js";
import { preInitAgent } from "./websocket.js";

export function createProjectsRouter(docker: Dockerode): Router {
  const router = Router();
  const taskDispatcher = new TaskDispatcher();

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
    const { name, description, source, repositoryIds } = req.body;
    if (!name) {
      res.status(400).json({ error: "Missing required field: name" });
      return;
    }

    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name,
      status: "brainstorming",
      source: source || {
        type: "freeform",
        freeformDescription: description || "",
      },
      repositoryIds: repositoryIds || [],
      masterSessionPath: "",
      createdAt: now,
      updatedAt: now,
    };

    insertProject(project);
    // Start agent initialization in background so it's ready when the WS connects
    preInitAgent(project.id);
    res.status(201).json(project);
  });

  // Update a project
  router.patch("/:id", (req, res) => {
    const { name, source, repositoryIds, plan, status } = req.body;
    const existing = getProject(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const updates: Partial<Omit<Project, "id" | "createdAt">> = {};
    if (name !== undefined) updates.name = name;
    if (source !== undefined) updates.source = source;
    if (repositoryIds !== undefined) updates.repositoryIds = repositoryIds;
    if (plan !== undefined) updates.plan = plan;
    if (status !== undefined) updates.status = status;

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
  router.post("/:id/approve", async (req, res) => {
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

    // Start dispatching tasks asynchronously
    // Don't await - let it run in background
    taskDispatcher.dispatchTasks(docker, req.params.id).catch(err => {
      console.error(`Task dispatch failed for project ${req.params.id}:`, err);
    });

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
