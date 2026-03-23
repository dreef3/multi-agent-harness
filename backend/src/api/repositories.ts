import { Router } from "express";
import { randomUUID } from "crypto";
import { Octokit } from "@octokit/rest";
import { insertRepository, getRepository, listRepositories, updateRepository, deleteRepository } from "../store/repositories.js";
import type { Repository } from "../models/types.js";

export interface GitHubRepoInfo {
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  owner: string;
  repo: string;
  private: boolean;
  description?: string;
}

export function createRepositoriesRouter(): Router {
  const router = Router();

  // List all repositories
  router.get("/", (_req, res) => {
    const repos = listRepositories();
    res.json(repos);
  });

  // List GitHub repositories for the authenticated user
  router.get("/github", (_req, res) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      res.status(401).json({ error: "GITHUB_TOKEN not configured" });
      return;
    }

    const octokit = new Octokit({ auth: token });

    octokit.repos.listForAuthenticatedUser({ per_page: 100, sort: "updated" })
      .then(({ data }) => {
        const repos: GitHubRepoInfo[] = data.map((r) => ({
          name: r.name,
          fullName: r.full_name,
          cloneUrl: r.clone_url,
          defaultBranch: r.default_branch ?? "main",
          owner: r.owner.login,
          repo: r.name,
          private: r.private,
          description: r.description ?? undefined,
        }));
        res.json(repos);
      })
      .catch((err) => {
        console.error("Failed to list GitHub repositories:", err);
        res.status(500).json({ error: "Failed to list GitHub repositories" });
      });
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
