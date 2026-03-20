import { Router } from "express";
import { randomUUID } from "crypto";
import { insertRepository, getRepository, listRepositories, updateRepository, deleteRepository } from "../store/repositories.js";
import type { Repository } from "../models/types.js";

export function createRepositoriesRouter(): Router {
  const router = Router();

  // List all repositories
  router.get("/", (_req, res) => {
    const repos = listRepositories();
    res.json(repos);
  });

  // Get a single repository by ID
  router.get("/:id", (req, res) => {
    const repo = getRepository(req.params.id);
    if (!repo) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    res.json(repo);
  });

  // Create a new repository
  router.post("/", (req, res) => {
    const { name, cloneUrl, provider, providerConfig, defaultBranch } = req.body;
    if (!name || !cloneUrl || !provider) {
      res.status(400).json({ error: "Missing required fields: name, cloneUrl, provider" });
      return;
    }

    const now = new Date().toISOString();
    const repo: Repository = {
      id: randomUUID(),
      name,
      cloneUrl,
      provider,
      providerConfig: providerConfig ?? {},
      defaultBranch: defaultBranch ?? "main",
      createdAt: now,
      updatedAt: now,
    };

    insertRepository(repo);
    res.status(201).json(repo);
  });

  // Update a repository
  router.patch("/:id", (req, res) => {
    const { name, cloneUrl, provider, providerConfig, defaultBranch } = req.body;
    const existing = getRepository(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }

    const updates: Partial<Omit<Repository, "id" | "createdAt">> = {};
    if (name !== undefined) updates.name = name;
    if (cloneUrl !== undefined) updates.cloneUrl = cloneUrl;
    if (provider !== undefined) updates.provider = provider;
    if (providerConfig !== undefined) updates.providerConfig = providerConfig;
    if (defaultBranch !== undefined) updates.defaultBranch = defaultBranch;

    updateRepository(req.params.id, updates);
    res.json(getRepository(req.params.id));
  });

  // Delete a repository
  router.delete("/:id", (req, res) => {
    const existing = getRepository(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    deleteRepository(req.params.id);
    res.status(204).send();
  });

  return router;
}
