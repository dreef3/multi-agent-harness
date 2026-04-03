import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import http from "http";
import { createMcpMiddleware } from "../mcp/server.js";
import { initDb } from "../store/db.js";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";

describe("MCP SSE server", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const dir = mkdtempSync(`${tmpdir()}/harness-test-`);
    await initDb(dir);
    const app = express();
    app.use("/mcp", createMcpMiddleware());
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    port = (server.address() as { port: number }).port;
  });

  it("responds to SSE connection on /mcp", async () => {
    // The MCP SSE endpoint keeps the connection open for streaming.
    // We connect, read the status + headers, then destroy the socket.
    const { statusCode, headers } = await new Promise<{
      statusCode: number;
      headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${port}/mcp?projectId=test&sessionId=test&role=planning`,
        (res) => {
          resolve({ statusCode: res.statusCode!, headers: res.headers });
          res.destroy(); // close the stream without waiting for it to end
        }
      );
      req.on("error", (err: NodeJS.ErrnoException) => {
        // ECONNRESET is expected after res.destroy() — ignore it
        if (err.code !== "ECONNRESET") reject(err);
      });
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error("request timed out"));
      });
    });

    expect(statusCode).toBe(200);
    expect(headers["content-type"]).toMatch(/text\/event-stream/);
  });
});
