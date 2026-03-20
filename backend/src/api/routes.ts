import { Router } from "express";

export function createRouter(): Router {
  const router = Router();
  router.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });
  return router;
}
