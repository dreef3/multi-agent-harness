import { Router } from "express";
import type Dockerode from "dockerode";
import { createProjectsRouter } from "./projects.js";
import { createRepositoriesRouter } from "./repositories.js";
import { createAgentsRouter } from "./agents.js";
import { createJiraRouter } from "./jira.js";
import { createPullRequestsRouter } from "./pullRequests.js";
import { createWebhooksRouter } from "./webhooks.js";
import { config } from "../config.js";

export function createRouter(dataDir: string, docker: Dockerode): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Configuration endpoint - exposes provider and model settings
  router.get("/config", (_req, res) => {
    const provider = config.agentProvider;
    const models = config.models[provider as keyof typeof config.models] ?? config.models["opencode-go"];
    
    res.json({
      provider,
      models,
    });
  });

  // Mount sub-routers
  router.use("/projects", createProjectsRouter(docker));
  router.use("/repositories", createRepositoriesRouter());
  router.use("/agents", createAgentsRouter());
  router.use("/jira", createJiraRouter());
  router.use("/pull-requests", createPullRequestsRouter(docker));
  router.use("/webhooks", createWebhooksRouter());

  return router;
}
