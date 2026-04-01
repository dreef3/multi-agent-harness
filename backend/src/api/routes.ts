import { Router } from "express";
import type Dockerode from "dockerode";
import { createProjectsRouter } from "./projects.js";
import { createRepositoriesRouter } from "./repositories.js";
import { createAgentsRouter } from "./agents.js";
import { createJiraRouter } from "./jira.js";
import { createGitHubIssuesRouter } from "./githubIssues.js";
import { createPullRequestsRouter } from "./pullRequests.js";
import { createWebhooksRouter } from "./webhooks.js";
import { createSettingsRouter } from "./settings.js";
import { config } from "../config.js";
import { verifyJwt } from "./auth.js";

export function createRouter(dataDir: string, docker: Dockerode): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Configuration endpoint - exposes provider and model settings
  router.get("/config", (_req, res) => {
    res.json({
      provider: config.agentProvider,
      planningModel: config.planningModel,
      implementationModel: config.implementationModel,
    });
  });

  // JWT verification for all protected routes
  router.use(verifyJwt());

  // Mount sub-routers
  router.use("/projects", createProjectsRouter(dataDir, docker));
  router.use("/repositories", createRepositoriesRouter());
  router.use("/agents", createAgentsRouter());
  router.use("/jira", createJiraRouter());
  router.use("/github-issues", createGitHubIssuesRouter());
  router.use("/pull-requests", createPullRequestsRouter(docker));
  router.use("/webhooks", createWebhooksRouter());
  router.use("/settings", createSettingsRouter());

  return router;
}
