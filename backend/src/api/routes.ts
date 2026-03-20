import { Router } from "express";
import { createProjectsRouter } from "./projects.js";
import { createRepositoriesRouter } from "./repositories.js";
import { createAgentsRouter } from "./agents.js";

export function createRouter(dataDir: string): Router {
  const router = Router();
  
  router.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Mount sub-routers
  router.use("/projects", createProjectsRouter());
  router.use("/repositories", createRepositoriesRouter());
  router.use("/agents", createAgentsRouter());
  
  return router;
}
