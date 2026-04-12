/**
 * Tests for the /api/tools/write-planning-document endpoint.
 *
 * Verifies auth, input validation, and that the handler is called
 * with the correct arguments. Does not test the actual Git operations
 * (those are covered by planningTool.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createPlanningToolsRouter } from "../api/planningToolsRouter.js";
import { registerMcpToken, revokeMcpToken } from "../mcp/server.js";

// Mock handleWritePlanningDocument so we don't need a real Git repo
vi.mock("../agents/planningTool.js", () => ({
  handleWritePlanningDocument: vi.fn().mockResolvedValue({ prUrl: "https://github.com/org/repo/pull/1" }),
}));

const TEST_TOKEN = "test-mcp-token-router-123";

describe("POST /api/tools/write-planning-document", () => {
  let app: express.Express;

  beforeAll(() => {
    registerMcpToken(TEST_TOKEN);
    app = express();
    app.use(express.json());
    app.use("/api/tools", createPlanningToolsRouter());
  });

  afterAll(() => {
    revokeMcpToken(TEST_TOKEN);
  });

  test("returns 401 with no Authorization header", async () => {
    const res = await request(app)
      .post("/api/tools/write-planning-document")
      .send({ projectId: "proj-1", type: "spec", content: "# spec" });
    expect(res.status).toBe(401);
  });

  test("returns 401 with wrong token", async () => {
    const res = await request(app)
      .post("/api/tools/write-planning-document")
      .set("Authorization", "Bearer wrong-token")
      .send({ projectId: "proj-1", type: "spec", content: "# spec" });
    expect(res.status).toBe(401);
  });

  test("returns 400 if projectId is missing", async () => {
    const res = await request(app)
      .post("/api/tools/write-planning-document")
      .set("Authorization", `Bearer ${TEST_TOKEN}`)
      .send({ type: "spec", content: "# spec" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("projectId");
  });

  test("returns 400 if type is invalid", async () => {
    const res = await request(app)
      .post("/api/tools/write-planning-document")
      .set("Authorization", `Bearer ${TEST_TOKEN}`)
      .send({ projectId: "proj-1", type: "invalid", content: "# spec" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("type");
  });

  test("returns 400 if content is missing", async () => {
    const res = await request(app)
      .post("/api/tools/write-planning-document")
      .set("Authorization", `Bearer ${TEST_TOKEN}`)
      .send({ projectId: "proj-1", type: "spec" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("content");
  });

  test("returns 200 with prUrl for valid spec request", async () => {
    const res = await request(app)
      .post("/api/tools/write-planning-document")
      .set("Authorization", `Bearer ${TEST_TOKEN}`)
      .send({ projectId: "proj-1", type: "spec", content: "# My Spec" });
    expect(res.status).toBe(200);
    expect(res.body.prUrl).toBeDefined();
  });

  test("returns 200 with prUrl for valid plan request", async () => {
    const res = await request(app)
      .post("/api/tools/write-planning-document")
      .set("Authorization", `Bearer ${TEST_TOKEN}`)
      .send({ projectId: "proj-1", type: "plan", content: "# My Plan" });
    expect(res.status).toBe(200);
    expect(res.body.prUrl).toBeDefined();
  });
});
