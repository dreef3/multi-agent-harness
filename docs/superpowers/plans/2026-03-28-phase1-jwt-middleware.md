# JWT Middleware Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement stateless JWT verification middleware with `AUTH_ENABLED` toggle, role extraction, and `requireRole` guard for all Express routes.

**Architecture:** A single `backend/src/api/auth.ts` module exports `verifyJwt()`, `requireRole()`, and a helper `verifyWsToken()` (used by the WebSocket plan). When `AUTH_ENABLED=false`, every request is attributed to a synthetic `local-user` admin without touching the network. When enabled, JWKS are fetched from the IdP discovery endpoint, cached in memory, and automatically refreshed on unknown-kid errors.

**Tech Stack:** `jose` (JWKS + JWT verification), Express middleware pattern, `better-sqlite3` via `upsertUser` from the schema plan.

---

## Tasks

- [ ] **Task 1 — Install `jose`**

  ```bash
  cd backend && bun add jose
  ```

  Verify `jose` appears in `backend/package.json` dependencies.

- [ ] **Task 2 — Extend `backend/src/config.ts` with auth config fields**

  Open `backend/src/config.ts` (or the equivalent config module). Add the following fields to the exported config object. Read the file first to understand its current shape — it likely exports a plain object or uses `process.env` directly.

  ```typescript
  authEnabled:         process.env.AUTH_ENABLED === "true",
  oidcIssuerUrl:       process.env.OIDC_ISSUER_URL ?? "",
  oidcAudience:        process.env.OIDC_AUDIENCE ?? process.env.OIDC_CLIENT_ID ?? "",
  oidcRoleClaim:       process.env.OIDC_ROLE_CLAIM ?? "roles",
  oidcRoleMapAdmin:    process.env.OIDC_ROLE_MAP_ADMIN    ?? "harness-admins",
  oidcRoleMapOperator: process.env.OIDC_ROLE_MAP_OPERATOR ?? "harness-operators",
  oidcRoleMapReviewer: process.env.OIDC_ROLE_MAP_REVIEWER ?? "harness-reviewers",
  oidcRoleMapViewer:   process.env.OIDC_ROLE_MAP_VIEWER   ?? "harness-viewers",
  ```

  `AUTH_ENABLED` defaults to `false` — only `"true"` (exact string) enables auth.

- [ ] **Task 3 — Create `backend/src/api/auth.ts`**

  Create the file with the following full implementation:

  ```typescript
  import { jwtVerify, createRemoteJWKSet } from "jose";
  import type { Request, Response, NextFunction } from "express";
  import { config } from "../config.js";
  import { upsertUser } from "../store/users.js";

  // ---- Types ----------------------------------------------------------------

  export interface AuthUser {
    sub: string;
    email: string;
    name: string;
    roles: string[];
  }

  // Augment Express Request so downstream handlers can access req.user
  declare module "express-serve-static-core" {
    interface Request {
      user?: AuthUser;
    }
  }

  // ---- JWKS cache -----------------------------------------------------------

  // One cached instance per process — refreshed when a request fails due to
  // unknown kid (key rotation scenario).
  let remoteJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  async function getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (!remoteJwks) {
      if (!config.oidcIssuerUrl) {
        throw new Error("OIDC_ISSUER_URL is not configured");
      }
      const discoveryUrl = `${config.oidcIssuerUrl}/.well-known/openid-configuration`;
      const discovery = await fetch(discoveryUrl).then(r => {
        if (!r.ok) throw new Error(`OIDC discovery failed: ${r.status}`);
        return r.json() as Promise<{ jwks_uri: string }>;
      });
      remoteJwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    }
    return remoteJwks;
  }

  // ---- Synthetic local user -------------------------------------------------

  export const LOCAL_USER: AuthUser = {
    sub: "local-user",
    email: "local@localhost",
    name: "Local User",
    roles: ["admin"],
  };

  // ---- Token verification (shared by HTTP and WebSocket) --------------------

  export async function verifyToken(token: string): Promise<AuthUser> {
    const jwks = await getJwks();
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.oidcIssuerUrl,
      audience: config.oidcAudience || undefined,
      clockTolerance: 30, // seconds of allowed clock skew
    });

    const rolesClaim = getNestedClaim(payload as Record<string, unknown>, config.oidcRoleClaim);
    const rawRoles = Array.isArray(rolesClaim) ? (rolesClaim as string[]) : [];
    const roles = mapRoles(rawRoles);

    return {
      sub: payload.sub!,
      email: ((payload as Record<string, unknown>).email as string) ?? "",
      name: ((payload as Record<string, unknown>).name as string) ?? payload.sub!,
      roles,
    };
  }

  /** Used by the WebSocket upgrade handler */
  export async function verifyWsToken(token: string): Promise<AuthUser> {
    return verifyToken(token);
  }

  // ---- Express middleware ----------------------------------------------------

  /**
   * verifyJwt() — must be applied before any route that requires authentication.
   *
   * When AUTH_ENABLED=false:  sets req.user = LOCAL_USER and calls next().
   * When AUTH_ENABLED=true:   validates Bearer token, populates req.user,
   *                           then calls upsertUser() to keep the users table current.
   */
  export function verifyJwt() {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      if (!config.authEnabled) {
        req.user = LOCAL_USER;
        return next();
      }

      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Missing Bearer token" });
        return;
      }

      const token = authHeader.slice(7);
      try {
        const user = await verifyToken(token);
        req.user = user;

        // Keep the users table up to date with latest profile + roles
        upsertUser({
          id: user.sub,
          email: user.email,
          displayName: user.name,
          roles: user.roles,
          lastSeen: new Date().toISOString(),
          createdAt: new Date().toISOString(), // ignored on UPDATE by upsertUser
        });

        next();
      } catch (err) {
        // Invalidate JWKS cache in case of key rotation
        remoteJwks = null;
        res.status(401).json({ error: "Invalid or expired token" });
      }
    };
  }

  /**
   * requireRole(...roles) — must be applied AFTER verifyJwt().
   * Returns 403 if req.user holds none of the listed roles.
   */
  export function requireRole(...roles: string[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
      const userRoles = req.user?.roles ?? [];
      const hasRole = roles.some(r => userRoles.includes(r));
      if (!hasRole) {
        res.status(403).json({ error: "Insufficient permissions", required: roles });
        return;
      }
      next();
    };
  }

  // ---- Helpers ---------------------------------------------------------------

  function getNestedClaim(payload: Record<string, unknown>, claimPath: string): unknown {
    return claimPath
      .split(".")
      .reduce<unknown>((obj, key) =>
        obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined,
        payload
      );
  }

  function mapRoles(rawRoles: string[]): string[] {
    const roleMap: Record<string, string> = {
      [config.oidcRoleMapAdmin]:    "admin",
      [config.oidcRoleMapOperator]: "operator",
      [config.oidcRoleMapReviewer]: "reviewer",
      [config.oidcRoleMapViewer]:   "viewer",
    };
    // Also pass through canonical role names directly (idempotent)
    const canonical = new Set(["admin", "operator", "reviewer", "viewer"]);
    return rawRoles.flatMap(r => {
      if (roleMap[r]) return [roleMap[r]];
      if (canonical.has(r)) return [r];
      return [];
    });
  }
  ```

- [ ] **Task 4 — Wire `verifyJwt()` globally in `backend/src/api/routes.ts`**

  Open `backend/src/api/routes.ts`. Import `verifyJwt` and apply it as the first middleware on the main router (before all sub-routers are mounted):

  ```typescript
  import { verifyJwt } from "./auth.js";

  // At the top of the router setup, before mounting sub-routers:
  router.use(verifyJwt());
  ```

  Do NOT add `requireRole` at the global level — it will be applied per-route in later plans.

- [ ] **Task 5 — Verify TypeScript compiles**

  ```bash
  cd backend && bun run tsc --noEmit
  ```

  Fix any import or type errors. Common issues:
  - `express-serve-static-core` augmentation conflicts — if the project already augments `Request`, merge the `user` field into the existing declaration.
  - Missing `config` fields — ensure Task 2 was completed first.

- [ ] **Task 6 — Write unit tests `backend/src/api/auth.test.ts`**

  Create the test file:

  ```typescript
  import { describe, it, expect, vi, beforeEach } from "vitest";

  // Must mock jose BEFORE importing auth.ts
  vi.mock("jose", () => ({
    jwtVerify: vi.fn(),
    createRemoteJWKSet: vi.fn(() => "mock-jwks"),
  }));

  // Mock fetch for OIDC discovery
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ jwks_uri: "https://idp.example.com/jwks" }),
  }) as unknown as typeof fetch;

  import { jwtVerify } from "jose";
  import { verifyJwt, requireRole, LOCAL_USER } from "./auth.js";
  import type { Request, Response, NextFunction } from "express";

  // Helper to build minimal Express mocks
  function mockReq(overrides: Partial<Request> = {}): Request {
    return { headers: {}, ...overrides } as Request;
  }
  function mockRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; _status: number } {
    const res: Record<string, unknown> = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res as unknown as ReturnType<typeof mockRes>;
  }
  const next: NextFunction = vi.fn();

  describe("verifyJwt middleware", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      // Reset module-level JWKS cache between tests
    });

    it("passes LOCAL_USER when AUTH_ENABLED=false", async () => {
      process.env.AUTH_ENABLED = "false";
      const req = mockReq();
      const res = mockRes();
      await verifyJwt()(req as Request, res as unknown as Response, next);
      expect((req as Request & { user: unknown }).user).toEqual(LOCAL_USER);
      expect(next).toHaveBeenCalledOnce();
    });

    it("returns 401 when no Authorization header and AUTH_ENABLED=true", async () => {
      process.env.AUTH_ENABLED = "true";
      process.env.OIDC_ISSUER_URL = "https://idp.example.com";
      const req = mockReq({ headers: {} });
      const res = mockRes();
      await verifyJwt()(req as Request, res as unknown as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("returns 401 when token is invalid", async () => {
      process.env.AUTH_ENABLED = "true";
      (jwtVerify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("bad token"));
      const req = mockReq({ headers: { authorization: "Bearer bad.token.here" } });
      const res = mockRes();
      await verifyJwt()(req as Request, res as unknown as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("populates req.user from valid token", async () => {
      process.env.AUTH_ENABLED = "true";
      (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        payload: {
          sub: "user-123",
          email: "alice@example.com",
          name: "Alice",
          roles: ["harness-admins"],
        },
      });
      const req = mockReq({ headers: { authorization: "Bearer valid.token" } });
      const res = mockRes();
      await verifyJwt()(req as Request, res as unknown as Response, next);
      expect((req as Request & { user: unknown }).user).toMatchObject({
        sub: "user-123",
        email: "alice@example.com",
        roles: ["admin"],
      });
      expect(next).toHaveBeenCalledOnce();
    });
  });

  describe("requireRole middleware", () => {
    it("calls next when user has required role", () => {
      const req = mockReq() as Request & { user: unknown };
      req.user = { sub: "u1", email: "u@e.com", name: "U", roles: ["operator"] };
      const res = mockRes();
      requireRole("admin", "operator")(req as Request, res as unknown as Response, next);
      expect(next).toHaveBeenCalledOnce();
    });

    it("returns 403 when user lacks required role", () => {
      const req = mockReq() as Request & { user: unknown };
      req.user = { sub: "u1", email: "u@e.com", name: "U", roles: ["viewer"] };
      const res = mockRes();
      requireRole("admin", "operator")(req as Request, res as unknown as Response, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Task 7 — Run tests**

  ```bash
  cd backend && bun test src/api/auth.test.ts
  ```

  All tests must pass before marking this plan complete.

---

## Verification Checklist

- [ ] `jose` in `backend/package.json` dependencies
- [ ] `config.authEnabled` defaults to `false` (i.e., `AUTH_ENABLED` not set → auth disabled)
- [ ] `verifyJwt()` applied globally in `routes.ts` before all sub-routers
- [ ] `AUTH_ENABLED=false` → `req.user` is `LOCAL_USER` with role `["admin"]`
- [ ] Valid Bearer token → `req.user` populated, `upsertUser` called
- [ ] Invalid/expired token → HTTP 401
- [ ] Missing Authorization header → HTTP 401
- [ ] User with wrong role → HTTP 403 from `requireRole`
- [ ] JWKS cache invalidated after any verification failure
- [ ] TypeScript strict-mode compile passes
- [ ] All 6 unit tests pass
