import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import { initDb } from "../store/db.js";
import { insertProject } from "../store/projects.js";
import { createAgentConfigRouter } from "../api/agentConfig.js";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";

describe("agent config API", () => {
  let app: express.Express;
  let projectId: string;

  beforeAll(async () => {
    const dir = mkdtempSync(`${tmpdir()}/harness-test-`);
    await initDb(dir);

    projectId = randomUUID();
    const now = new Date().toISOString();
    await insertProject({
      id: projectId,
      name: "test",
      status: "brainstorming",
      source: { type: "freeform", freeformDescription: "test" },
      repositoryIds: [],
      masterSessionPath: "",
      createdAt: now,
      updatedAt: now,
    });

    app = express();
    app.use(express.json());
    app.use("/api", createAgentConfigRouter());
  });

  it("GET /api/config/available-agents returns agent list", async () => {
    const res = await request(app).get("/api/config/available-agents");
    expect(res.status).toBe(200);
    expect(res.body.agents).toBeInstanceOf(Array);
    expect(res.body.agents.length).toBeGreaterThan(0);
    expect(res.body.agents[0]).toHaveProperty("type");
    expect(res.body.agents[0]).toHaveProperty("available");
  });

  it("PUT + GET /api/projects/:id/agent-config round-trips", async () => {
    const putRes = await request(app)
      .put(`/api/projects/${projectId}/agent-config`)
      .send({
        planningAgent: { type: "gemini", model: "gemini-2.5-pro" },
        implementationAgent: { type: "copilot", model: "gpt-5-mini" },
      });
    expect(putRes.status).toBe(200);

    const getRes = await request(app)
      .get(`/api/projects/${projectId}/agent-config`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.planningAgent).toEqual({ type: "gemini", model: "gemini-2.5-pro" });
    expect(getRes.body.implementationAgent).toEqual({ type: "copilot", model: "gpt-5-mini" });
    expect(getRes.body.defaults).toBeDefined();
  });
});
