import express from "express";
import { createServer } from "http";
import Dockerode from "dockerode";
import { config } from "./config.js";
import { initDb } from "./store/db.js";
import { ensureSubAgentImage } from "./orchestrator/imageBuilder.js";
import { createRouter } from "./api/routes.js";
import { setupWebSocket } from "./api/websocket.js";
import { startPolling } from "./polling.js";
import { DebounceEngine } from "./debounce/engine.js";
import { setDebounceEngine } from "./api/webhooks.js";
import { RecoveryService, setRecoveryService } from "./orchestrator/recoveryService.js";
import { PlanningAgentManager, setPlanningAgentManager } from "./orchestrator/planningAgentManager.js";

async function main() {
  console.log("[startup] Initializing database...");
  initDb(config.dataDir);

  console.log(`[startup] Connecting to Docker proxy at ${config.dockerProxyUrl}...`);
  const dockerUrl = new URL(config.dockerProxyUrl);
  console.log(`[startup]   Docker host=${dockerUrl.hostname} port=${dockerUrl.port}`);
  const docker = new Dockerode({ host: dockerUrl.hostname, port: parseInt(dockerUrl.port, 10) });

  console.log("[startup] Ensuring sub-agent image exists...");
  try { await ensureSubAgentImage(docker, config.subAgentImage); }
  catch (err) { console.error("[startup] Failed to ensure sub-agent image:", err); process.exit(1); }

  console.log("[startup] Initializing debounce engine...");
  const debounceEngine = new DebounceEngine({ delayMs: 10 * 60 * 1000 }); // 10 minutes
  setDebounceEngine(debounceEngine);

  console.log("[startup] Initializing recovery service...");
  const recoveryService = new RecoveryService(docker);
  setRecoveryService(recoveryService);

  console.log("[startup] Initializing planning agent manager...");
  const planningAgentManager = new PlanningAgentManager(docker);
  setPlanningAgentManager(planningAgentManager);
  void planningAgentManager.cleanupStaleContainers();

  console.log("[startup] Running boot recovery (stale session scan)...");
  await recoveryService.recoverOnBoot();

  console.log("[startup] Starting polling...");
  startPolling(docker);

  const app = express();
  app.use(express.json());
  app.use("/api", createRouter(config.dataDir, docker));

  const server = createServer(app);
  setupWebSocket(server);

  server.listen(config.port, () => {
    console.log(`[startup] Backend listening on port ${config.port}`);
  });
}

main().catch((err) => { console.error("[fatal]", err); process.exit(1); });
