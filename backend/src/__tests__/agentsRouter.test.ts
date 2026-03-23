import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../orchestrator/planningAgentManager.js", () => ({
  getPlanningAgentManager: vi.fn(() => ({ injectMessage: vi.fn() })),
}));
vi.mock("../orchestrator/heartbeatMonitor.js", () => ({
  resetHeartbeat: vi.fn(),
  clearHeartbeat: vi.fn(),
}));
vi.mock("../store/agents.js", () => ({
  getAgentSession: vi.fn(),
  updateAgentSession: vi.fn(),
  insertAgentSession: vi.fn(),
  listAgentSessions: vi.fn().mockReturnValue([]),
}));
vi.mock("../store/agentEvents.js", () => ({
  appendEvent: vi.fn(),
  getEvents: vi.fn().mockReturnValue([]),
}));
vi.mock("../api/websocket.js", () => ({
  broadcastAgentActivity: vi.fn(),
}));
vi.mock("../store/projects.js", () => ({
  getProject: vi.fn(),
}));

import { createAgentsRouter } from "../api/agents.js";
import { getAgentSession, updateAgentSession } from "../store/agents.js";
import { getEvents, appendEvent } from "../store/agentEvents.js";
import { resetHeartbeat, clearHeartbeat } from "../orchestrator/heartbeatMonitor.js";
import { getProject } from "../store/projects.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/agents", createAgentsRouter());
  return app;
}

describe("POST /api/agents/:id/heartbeat", () => {
  it("returns 200 and resets heartbeat timer", async () => {
    (getAgentSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "sess-1", projectId: "proj-1", taskId: "task-1", status: "running",
    });
    (getProject as ReturnType<typeof vi.fn>).mockReturnValue({
      plan: { tasks: [{ id: "task-1", description: "Build auth module" }] },
    });
    const app = buildApp();
    const res = await request(app).post("/api/agents/sess-1/heartbeat");
    expect(res.status).toBe(200);
    expect(resetHeartbeat).toHaveBeenCalledWith("sess-1", "proj-1", "Build auth module");
  });

  it("returns 404 for unknown session", async () => {
    (getAgentSession as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const app = buildApp();
    const res = await request(app).post("/api/agents/unknown/heartbeat");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/agents/:id/events", () => {
  it("stores and broadcasts the event", async () => {
    (getAgentSession as ReturnType<typeof vi.fn>).mockReturnValue({ id: "sess-2", projectId: "proj-1" });
    const app = buildApp();
    const res = await request(app)
      .post("/api/agents/sess-2/events")
      .send({ type: "tool_call", payload: { toolName: "bash" }, timestamp: "2026-01-01T00:00:00Z" });
    expect(res.status).toBe(200);
    expect(appendEvent).toHaveBeenCalledWith("sess-2", expect.objectContaining({ type: "tool_call" }));
  });
});

describe("GET /api/agents/:id/events", () => {
  it("returns accumulated events", async () => {
    (getAgentSession as ReturnType<typeof vi.fn>).mockReturnValue({ id: "sess-3", projectId: "proj-1" });
    (getEvents as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: "text", payload: { text: "hi" }, timestamp: "t1" },
    ]);
    const app = buildApp();
    const res = await request(app).get("/api/agents/sess-3/events");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe("PATCH /api/agents/:id clears heartbeat on completion", () => {
  it("calls clearHeartbeat when status transitions to completed", async () => {
    (getAgentSession as ReturnType<typeof vi.fn>).mockReturnValue({ id: "sess-4", projectId: "proj-1", status: "running" });
    const app = buildApp();
    await request(app).patch("/api/agents/sess-4").send({ status: "completed" });
    expect(clearHeartbeat).toHaveBeenCalledWith("sess-4");
  });

  it("calls clearHeartbeat when status transitions to failed", async () => {
    (getAgentSession as ReturnType<typeof vi.fn>).mockReturnValue({ id: "sess-5", projectId: "proj-1", status: "running" });
    const app = buildApp();
    await request(app).patch("/api/agents/sess-5").send({ status: "failed" });
    expect(clearHeartbeat).toHaveBeenCalledWith("sess-5");
  });
});
