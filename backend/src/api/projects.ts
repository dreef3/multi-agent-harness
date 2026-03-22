import { Router } from "express";
import { randomUUID } from "crypto";
import { insertProject, getProject, listProjects, updateProject, deleteProject } from "../store/projects.js";
import { getRepository } from "../store/repositories.js";
import { listMessages } from "../store/messages.js";
import { listAgentSessions } from "../store/agents.js";
import type { Project } from "../models/types.js";
import { preInitAgent } from "./websocket.js";

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
    const { name, description, source, repositoryIds, primaryRepositoryId } = req.body;
    if (!name) {
      res.status(400).json({ error: "Missing required field: name" });
      return;
    }

    if (!repositoryIds || (Array.isArray(repositoryIds) && repositoryIds.length === 0)) {
      res.status(400).json({ error: "At least one repository is required" });
      return;
    }

    // GitHub Issues source requires all repositories to be GitHub-hosted
    if (source?.type === "github" && Array.isArray(repositoryIds) && repositoryIds.length > 0) {
      const nonGithubRepos = repositoryIds
        .map((id: string) => getRepository(id))
        .filter((r): r is NonNullable<typeof r> => r != null)
        .filter(r => r.provider !== "github");
      if (nonGithubRepos.length > 0) {
        res.status(400).json({
          error: "GitHub Issues source is only supported with GitHub repositories",
          invalidRepositories: nonGithubRepos.map(r => r.name),
        });
        return;
      }
    }

    const resolvedRepoIds: string[] = repositoryIds || [];
    const resolvedPrimaryRepoId: string | undefined =
      primaryRepositoryId ?? (resolvedRepoIds.length === 1 ? resolvedRepoIds[0] : undefined);

    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name,
      status: "brainstorming",
      source: source || {
        type: "freeform",
        freeformDescription: description || "",
      },
      repositoryIds: resolvedRepoIds,
      primaryRepositoryId: resolvedPrimaryRepoId,
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
    const { name, source, repositoryIds, plan, status, planningBranch, planningPr } = req.body;
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
    if (planningBranch !== undefined) updates.planningBranch = planningBranch;
    if (planningPr !== undefined) updates.planningPr = planningPr;

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

  // Delete project
  router.delete("/:id", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    deleteProject(req.params.id);
    res.json({ success: true });
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
