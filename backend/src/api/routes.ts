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
import { createCiRouter } from "./ci.js";
import { createAgentConfigRouter } from "./agentConfig.js";
import { config } from "../config.js";
import { verifyJwt } from "./auth.js";
import { auditLog } from "./auditMiddleware.js";
import type { ContainerRuntime } from "../orchestrator/containerRuntime.js";

export function createRouter(dataDir: string, docker: Dockerode, containerRuntime?: ContainerRuntime): Router {
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

  // Agent config endpoints — no auth required (simple config reads/writes)
  router.use(createAgentConfigRouter());

  // JWT verification for all protected routes
  router.use(verifyJwt());
  router.use(auditLog());

  // Mount sub-routers
  router.use("/projects", createProjectsRouter(dataDir, docker));
  router.use("/repositories", createRepositoriesRouter());
  router.use("/agents", createAgentsRouter());
  router.use("/jira", createJiraRouter());
  router.use("/github-issues", createGitHubIssuesRouter());
  router.use("/pull-requests", createPullRequestsRouter(docker, containerRuntime));
  router.use("/webhooks", createWebhooksRouter());
  router.use("/settings", createSettingsRouter());
  router.use("/ci", createCiRouter());

  return router;
}
