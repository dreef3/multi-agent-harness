import express from "express";
import { createServer } from "http";
import Dockerode from "dockerode";
import { config } from "./config.js";
import { initDb } from "./store/db.js";
import { ensureSubAgentImage } from "./orchestrator/imageBuilder.js";
import { createRouter } from "./api/routes.js";
import { setupWebSocket } from "./api/websocket.js";

async function main() {
  console.log("[startup] Initializing database...");
  initDb(config.dataDir);

  console.log("[startup] Connecting to Docker proxy...");
  const dockerUrl = new URL(config.dockerProxyUrl);
  const docker = new Dockerode({ host: dockerUrl.hostname, port: parseInt(dockerUrl.port, 10) });

  console.log("[startup] Ensuring sub-agent image exists...");
  try { await ensureSubAgentImage(docker, config.subAgentImage); }
  catch (err) { console.error("[startup] Failed to ensure sub-agent image:", err); process.exit(1); }

  const app = express();
  app.use(express.json());
  app.use("/api", createRouter(config.dataDir, docker));

  const server = createServer(app);
  setupWebSocket(server, config.dataDir);

  server.listen(config.port, () => {
    console.log(`[startup] Backend listening on port ${config.port}`);
  });
}

main().catch((err) => { console.error("[fatal]", err); process.exit(1); });
