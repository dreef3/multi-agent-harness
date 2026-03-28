import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initDb } from "../store/db.js";
import os from "os";
import path from "path";
import fs from "fs";
import request from "supertest";
import express from "express";
import helmet from "helmet";
import { createRouter } from "../api/routes.js";
import Dockerode from "dockerode";

vi.mock("../api/githubIssues.js", () => ({
  createGitHubIssuesRouter: () => {
    const { Router } = require("express");
    return Router();
  },
}));

vi.mock("../api/websocket.js", () => ({
  preInitAgent: vi.fn(),
  setupWebSocket: vi.fn(),
}));

describe("security headers", () => {
  let app: ReturnType<typeof express>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sec-"));
    initDb(tmpDir);
    const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });
    app = express();
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
    app.use(express.json());
    app.use("/api", createRouter(tmpDir, docker));
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("includes x-frame-options header on API responses", async () => {
    const res = await request(app).get("/api/projects");
    expect(res.headers["x-frame-options"]).toBeDefined();
  });

  it("includes x-content-type-options header on API responses", async () => {
    const res = await request(app).get("/api/projects");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("includes content-security-policy header on API responses", async () => {
    const res = await request(app).get("/api/projects");
    expect(res.headers["content-security-policy"]).toBeDefined();
  });

  it("CSP includes connect-src with ws: and wss:", async () => {
    const res = await request(app).get("/api/projects");
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toContain("connect-src");
    expect(csp).toContain("ws:");
    expect(csp).toContain("wss:");
  });
});
