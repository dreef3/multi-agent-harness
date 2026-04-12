import { Router, type Request, type Response } from "express";
import { validTokens } from "../mcp/server.js";
import { handleWritePlanningDocument } from "../agents/planningTool.js";
import { config } from "../config.js";

/**
 * Lightweight REST façade for planning tools.
 *
 * Pi-acp does not support MCP, so the planning agent calls these plain HTTP
 * endpoints instead. Auth uses the same MCP token set as the SSE MCP server.
 *
 * Mounted at /api/tools (before JWT middleware so agents can reach it without
 * a user JWT).
 */
export function createPlanningToolsRouter(): Router {
  const router = Router();

  router.post("/write-planning-document", async (req: Request, res: Response) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token || !validTokens.has(token)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { projectId, type, content } = req.body as Record<string, unknown>;

    if (typeof projectId !== "string" || !projectId) {
      res.status(400).json({ error: "projectId is required" });
      return;
    }
    if (type !== "spec" && type !== "plan") {
      res.status(400).json({ error: 'type must be "spec" or "plan"' });
      return;
    }
    if (typeof content !== "string" || !content) {
      res.status(400).json({ error: "content is required" });
      return;
    }

    const result = await handleWritePlanningDocument(projectId, type, content, config.dataDir);
    if ("error" in result) {
      res.status(422).json(result);
      return;
    }
    res.json(result);
  });

  return router;
}
