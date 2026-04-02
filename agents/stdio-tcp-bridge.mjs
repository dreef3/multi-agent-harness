#!/usr/bin/env node
// stdio-tcp-bridge.mjs — Bridges TCP :3333 to an ACP subprocess's stdio.
// Usage: node stdio-tcp-bridge.mjs <command> [args...]
import { createServer } from "net";
import { spawn } from "child_process";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error("Usage: stdio-tcp-bridge.mjs <command> [args...]"); process.exit(1); }

const agent = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });

const server = createServer((socket) => {
  socket.pipe(agent.stdin, { end: false });
  agent.stdout.pipe(socket, { end: false });
  socket.on("error", (err) => console.error("[bridge] socket error:", err.message));
  socket.on("close", () => { /* client disconnected — agent stays alive for reconnect */ });
});

server.listen(3333, "0.0.0.0", () => {
  console.log("[bridge] listening on :3333");
});

agent.on("exit", (code) => {
  console.log(`[bridge] agent exited with code ${code}`);
  process.exit(code ?? 1);
});

process.on("SIGTERM", () => { agent.kill("SIGTERM"); });
process.on("SIGINT", () => { agent.kill("SIGINT"); });
