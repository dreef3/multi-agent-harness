import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => "mock-jwks"),
  jwtVerify: vi.fn(),
}));

vi.mock("../../store/users.js", () => ({
  upsertUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../config.js", () => ({
  config: {
    authEnabled:         false,
    oidcIssuerUrl:       "https://idp.example.com",
    oidcAudience:        "harness",
    oidcRoleClaim:       "roles",
    oidcRoleMapAdmin:    "harness-admins",
    oidcRoleMapOperator: "harness-operators",
    oidcRoleMapReviewer: "harness-reviewers",
    oidcRoleMapViewer:   "harness-viewers",
  },
}));

import { jwtVerify } from "jose";
import { upsertUser } from "../../store/users.js";
import { config } from "../../config.js";
import { verifyJwt, requireRole, LOCAL_USER } from "../auth.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeReqRes(authHeader?: string) {
  const req = {
    headers: authHeader ? { authorization: authHeader } : {},
    user: undefined,
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json:   vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("verifyJwt middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (config as Record<string, unknown>).authEnabled = false;
  });

  it("injects LOCAL_USER and calls next when auth is disabled", async () => {
    (config as Record<string, unknown>).authEnabled = false;
    const { req, res, next } = makeReqRes();
    await verifyJwt()(req, res, next);
    expect(req.user).toEqual(LOCAL_USER);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is missing", async () => {
    (config as Record<string, unknown>).authEnabled = true;
    const { req, res, next } = makeReqRes();
    await verifyJwt()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when token is invalid", async () => {
    (config as Record<string, unknown>).authEnabled = true;
    vi.mocked(jwtVerify).mockRejectedValueOnce(new Error("invalid signature"));
    const { req, res, next } = makeReqRes("Bearer bad-token");
    await verifyJwt()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("populates req.user and calls upsertUser on valid token", async () => {
    (config as Record<string, unknown>).authEnabled = true;
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: {
        sub:   "user-123",
        email: "user@example.com",
        name:  "Test User",
        roles: ["harness-admins"],
        iss:   "https://idp.example.com",
        aud:   "harness",
        iat:   Math.floor(Date.now() / 1000),
        exp:   Math.floor(Date.now() / 1000) + 3600,
      },
      protectedHeader: { alg: "RS256" },
    } as unknown as Awaited<ReturnType<typeof jwtVerify>>);

    const { req, res, next } = makeReqRes("Bearer valid-token");
    await verifyJwt()(req, res, next);

    expect(req.user).toMatchObject({
      sub:         "user-123",
      email:       "user@example.com",
      displayName: "Test User",
      roles:       ["admin"],
    });
    expect(upsertUser).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("requireRole middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls next when user has a required role", () => {
    const { req, res, next } = makeReqRes();
    req.user = { sub: "u1", email: "a@b.com", displayName: "A", roles: ["admin"] };
    requireRole("admin")(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 403 when user lacks required role", () => {
    const { req, res, next } = makeReqRes();
    req.user = { sub: "u1", email: "a@b.com", displayName: "A", roles: ["viewer"] };
    requireRole("admin", "operator")(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
