import { Router } from "express";
import type Dockerode from "dockerode";
import { createProjectsRouter } from "./projects.js";
import { createRepositoriesRouter } from "./repositories.js";
import { createAgentsRouter } from "./agents.js";

export function createRouter(dataDir: string, docker: Dockerode): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Mount sub-routers
  router.use("/projects", createProjectsRouter(docker));
  router.use("/repositories", createRepositoriesRouter());
  router.use("/agents", createAgentsRouter());

  return router;
}
