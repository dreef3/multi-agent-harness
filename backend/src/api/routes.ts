import { Router } from "express";
import type { Request, Response } from "express";
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
import { createMcpMiddleware, lookupMcpTokenContext } from "../mcp/server.js";
import { handleWritePlanningDocument } from "../agents/planningTool.js";

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

  // MCP SSE server — no auth (agents connect directly)
  router.use("/mcp", createMcpMiddleware());

  // Agent REST tools — Bearer-token auth via MCP token store (mounted before JWT)
  // Called by harness-planning-tools.mjs extension in pi/copilot planning containers.
  router.post("/tools/write-planning-document", async (req: Request, res: Response) => {
    const token = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : undefined;
    const ctx = token ? lookupMcpTokenContext(token) : undefined;
    if (!ctx) {
      res.status(401).json({ error: "Unauthorized: missing or invalid token" });
      return;
    }

    const { type, content } = (req.body ?? {}) as { type?: string; content?: string };
    if (!type || !content) {
      res.status(400).json({ error: "Missing required fields: type, content" });
      return;
    }
    if (type !== "spec" && type !== "plan") {
      res.status(400).json({ error: 'type must be "spec" or "plan"' });
      return;
    }

    const result = await handleWritePlanningDocument(ctx.projectId, type, content, dataDir);
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result);
  });

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
