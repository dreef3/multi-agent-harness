import { describe, it, expect, vi, beforeEach } from "vitest";
import { auditLog } from "../auditMiddleware.js";
import type { Request, Response, NextFunction } from "express";

vi.mock("../../store/auditLog.js", () => ({
  writeAuditEntry: vi.fn().mockResolvedValue(undefined),
}));

import { writeAuditEntry } from "../../store/auditLog.js";

function mockReq(method: string, path: string, body: Record<string,unknown> = {}) {
  return { method, path, body, user: { sub: "u1" } } as unknown as Request;
}
function mockRes(status = 200) {
  const res = { statusCode: status } as unknown as Response;
  res.json = vi.fn().mockReturnValue(res);
  return res;
}
const next = vi.fn() as unknown as NextFunction;

describe("auditLog middleware", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips GET requests", async () => {
    const req = mockReq("GET", "/api/projects");
    await auditLog()(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it("logs POST to /api/projects after response", async () => {
    const req = mockReq("POST", "/api/projects", { name: "Proj" });
    const res = mockRes(201);
    const originalJson = res.json;
    await auditLog()(req, res, next);
    // Trigger the intercepted json
    res.json({ id: "p1" });
    await new Promise(r => setTimeout(r, 10)); // let promise resolve
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      action: "project.post",
      resourceType: "project",
    }));
  });

  it("does NOT log on 4xx response", async () => {
    const req = mockReq("POST", "/api/projects");
    const res = mockRes(400);
    await auditLog()(req, res, next);
    res.json({ error: "bad" });
    await new Promise(r => setTimeout(r, 10));
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it("logs DELETE to /api/projects/:id", async () => {
    const req = mockReq("DELETE", "/api/projects/proj-1");
    const res = mockRes(204);
    await auditLog()(req, res, next);
    res.json({});
    await new Promise(r => setTimeout(r, 10));
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: "proj-1",
      action: "project.delete",
    }));
  });
});
