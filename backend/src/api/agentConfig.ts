import { Router } from "express";
import { getProject, updateProject } from "../store/projects.js";
import { resolveAgentConfig } from "../config.js";

const AGENT_TYPES = ["pi", "gemini", "claude", "copilot", "opencode"] as const;

const REQUIRED_ENV: Record<string, string> = {
  pi: "COPILOT_GITHUB_TOKEN",
  gemini: "GEMINI_API_KEY",
  claude: "ANTHROPIC_API_KEY",
  copilot: "COPILOT_GITHUB_TOKEN",
  opencode: "ANTHROPIC_API_KEY",  // fallback; opencode supports multiple providers
};

// Check: env var set OR explicit {TYPE}_ENABLED=true flag (for device-auth flows)
function isAgentAvailable(type: string): boolean {
  const enabledFlag = `${type.toUpperCase()}_ENABLED`;
  if (process.env[enabledFlag] === "true") return true;
  const envKey = REQUIRED_ENV[type];
  return envKey ? !!process.env[envKey] : false;
}

export function createAgentConfigRouter(): Router {
  const router = Router();

  router.get("/config/available-agents", (_req, res) => {
    const agents = AGENT_TYPES.map((type) => ({
      type,
      available: isAgentAvailable(type),
    }));
    res.json({ agents });
  });

  router.get("/projects/:id/agent-config", async (req, res) => {
    const project = await getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json({
      planningAgent: project.planningAgent ?? null,
      implementationAgent: project.implementationAgent ?? null,
      defaults: {
        planningAgent: resolveAgentConfig("planning"),
        implementationAgent: resolveAgentConfig("implementation"),
      },
    });
  });

  router.put("/projects/:id/agent-config", async (req, res) => {
    const project = await getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const { planningAgent, implementationAgent } = req.body as {
      planningAgent?: { type: string; model?: string };
      implementationAgent?: { type: string; model?: string };
    };
    await updateProject(req.params.id, { planningAgent, implementationAgent });
    res.json({ ok: true });
  });

  return router;
}
