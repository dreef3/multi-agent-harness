import "./telemetry.js"; // MUST be first — patches Node.js HTTP before any other import
import express from "express";
import helmet from "helmet";
import { createServer } from "http";
import Dockerode from "dockerode";
import { config } from "./config.js";
import { initDb } from "./store/db.js";
import { ensureSubAgentImage } from "./orchestrator/imageBuilder.js";
import { createRouter } from "./api/routes.js";
import { setupWebSocket } from "./api/websocket.js";
import { startPolling, stopPolling } from "./polling.js";
import { DebounceEngine } from "./debounce/engine.js";
import { setDebounceEngine } from "./api/webhooks.js";
import { RecoveryService, setRecoveryService } from "./orchestrator/recoveryService.js";
import { PlanningAgentManager, setPlanningAgentManager } from "./orchestrator/planningAgentManager.js";
import { createShutdownHandler } from "./orchestrator/shutdownHandler.js";
import { DockerContainerRuntime } from "./orchestrator/dockerRuntime.js";
import { KubernetesContainerRuntime } from "./orchestrator/kubernetesRuntime.js";
import type { ContainerRuntime } from "./orchestrator/containerRuntime.js";

async function main() {
  console.log("[startup] Initializing database...");
  await initDb(config.dataDir);

  console.log(`[startup] Connecting to Docker proxy at ${config.dockerProxyUrl}...`);
  const dockerUrl = new URL(config.dockerProxyUrl);
  console.log(`[startup]   Docker host=${dockerUrl.hostname} port=${dockerUrl.port}`);
  const docker = new Dockerode({ host: dockerUrl.hostname, port: parseInt(dockerUrl.port, 10) });

  let containerRuntime: ContainerRuntime;
  if (config.containerRuntime === "kubernetes") {
    console.log(`[startup] Using Kubernetes runtime (namespace: ${config.k8sNamespace})`);
    containerRuntime = new KubernetesContainerRuntime(config.k8sNamespace);
  } else {
    console.log("[startup] Using Docker runtime");
    containerRuntime = new DockerContainerRuntime(docker);
  }

  console.log("[startup] Ensuring sub-agent image exists...");
  try { await ensureSubAgentImage(docker, config.subAgentImage); }
  catch (err) { console.warn("[startup] Sub-agent image not found — task dispatch will fail until built:", (err as Error).message); }

  console.log("[startup] Initializing debounce engine...");
  const debounceEngine = new DebounceEngine({ delayMs: 10 * 60 * 1000 }); // 10 minutes
  setDebounceEngine(debounceEngine);

  console.log("[startup] Initializing recovery service...");
  const recoveryService = new RecoveryService(containerRuntime);
  setRecoveryService(recoveryService);

  console.log("[startup] Initializing planning agent manager...");
  const planningAgentManager = new PlanningAgentManager(containerRuntime);
  setPlanningAgentManager(planningAgentManager);
  void planningAgentManager.cleanupStaleContainers();

  console.log("[startup] Running boot recovery (stale session scan)...");
  await recoveryService.recoverOnBoot();

  console.log("[startup] Starting polling...");
  startPolling(docker, containerRuntime);

  const app = express();
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'", "ws:", "wss:"],
          imgSrc: ["'self'", "data:"],
        },
      },
    })
  );
  app.use(
    express.json({
      verify: (_req, _res, buf) => {
        (_req as import("express").Request & { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use("/api", createRouter(config.dataDir, docker, containerRuntime));

  const server = createServer(app);
  setupWebSocket(server);

  server.listen(config.port, () => {
    console.log(`[startup] Backend listening on port ${config.port}`);
  });

  const shutdown = createShutdownHandler({ server, stopPolling, debounceEngine });
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT",  () => void shutdown("SIGINT"));
}

main().catch((err) => { console.error("[fatal]", err); process.exit(1); });
