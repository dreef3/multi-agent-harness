# Audit Logging Middleware Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically log all state-mutating API calls (POST, PATCH, PUT, DELETE) to the `audit_log` table with full user attribution, resource context, and a truncated copy of the request body.

**Architecture:** An Express middleware `auditLog()` intercepts the response by wrapping `res.json`. After a successful response (status < 400), it derives `resourceType` and `resourceId` from the request path using regex matching, then calls `writeAuditEntry()` synchronously via `better-sqlite3`. The middleware is mounted in `routes.ts` immediately after `verifyJwt()`, so `req.user` is always populated before it runs. Read-only requests (GET, HEAD, OPTIONS) are ignored entirely.

**Tech Stack:** Express middleware, `better-sqlite3` (synchronous writes), `writeAuditEntry` from the schema plan (`backend/src/store/auditLog.ts`).

**Depends on:** Plan 16 (auth-schema) for `writeAuditEntry`, Plan 17 (jwt-middleware) for `req.user`.

---

## Tasks

- [ ] **Task 1 — Create `backend/src/api/auditMiddleware.ts`**

  ```typescript
  import type { Request, Response, NextFunction } from "express";
  import { writeAuditEntry } from "../store/auditLog.js";

  // ---- Resource extraction ---------------------------------------------------

  interface Resource {
    type: string;
    id: string;
  }

  /**
   * Derive resource type and ID from the request path.
   * Returns null for non-mutating methods — the middleware will short-circuit.
   *
   * Matching is intentionally broad: add new patterns here as new resource
   * types are introduced.
   */
  function parseResource(method: string, path: string): Resource | null {
    const mutating = ["POST", "PATCH", "PUT", "DELETE"];
    if (!mutating.includes(method.toUpperCase())) return null;

    // Try most-specific patterns first
    const patterns: Array<[RegExp, string]> = [
      [/^\/projects\/([^/]+)\/sessions/,    "session"],
      [/^\/projects\/([^/]+)\/plan/,         "plan"],
      [/^\/projects\/([^/]+)/,               "project"],
      [/^\/repositories\/([^/]+)/,           "repository"],
      [/^\/settings/,                        "settings"],
    ];

    for (const [regex, type] of patterns) {
      const match = path.match(regex);
      if (match) {
        return { type, id: match[1] ?? path };
      }
    }

    // Fallback: log unknown resources so nothing is silently dropped
    return { type: "unknown", id: path };
  }

  // ---- Middleware ------------------------------------------------------------

  /**
   * auditLog() — wraps res.json to write an audit entry after every successful
   * mutation. Must be mounted AFTER verifyJwt() so req.user is present.
   *
   * Usage in routes.ts:
   *   router.use(verifyJwt());
   *   router.use(auditLog());
   */
  export function auditLog() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const resource = parseResource(req.method, req.path);

      // Skip reads or paths we can't categorise
      if (!resource) {
        next();
        return;
      }

      // Wrap res.json to intercept the response body
      const originalJson = res.json.bind(res);
      res.json = function (body: unknown): Response {
        // Only log on success (2xx / 3xx)
        if (res.statusCode < 400 && req.user) {
          try {
            writeAuditEntry({
              userId: req.user.sub,
              userEmail: req.user.email,
              action: `${resource.type}.${req.method.toLowerCase()}`,
              resourceType: resource.type,
              resourceId: resource.id,
              // Truncate body to 500 chars to avoid bloating the log table
              details: JSON.stringify(req.body ?? {}).slice(0, 500),
              ipAddress: req.ip,
            });
          } catch (err) {
            // Audit write failures must never break the response
            console.error("[audit] Failed to write audit entry:", err);
          }
        }
        return originalJson(body);
      };

      next();
    };
  }
  ```

- [ ] **Task 2 — Wire `auditLog()` into `backend/src/api/routes.ts`**

  Open `backend/src/api/routes.ts`. Import `auditLog` and mount it immediately after `verifyJwt()`:

  ```typescript
  import { verifyJwt } from "./auth.js";
  import { auditLog } from "./auditMiddleware.js";

  // Existing: router.use(verifyJwt());
  router.use(auditLog()); // <-- add this line
  ```

  Order matters: `verifyJwt` → `auditLog` → sub-routers.

- [ ] **Task 3 — Verify TypeScript compiles**

  ```bash
  cd backend && bun run tsc --noEmit
  ```

- [ ] **Task 4 — Write unit tests `backend/src/api/auditMiddleware.test.ts`**

  ```typescript
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { auditLog } from "./auditMiddleware.js";
  import type { Request, Response, NextFunction } from "express";

  // Mock the store so tests don't need a real DB
  const mockWriteAuditEntry = vi.fn();
  vi.mock("../store/auditLog.js", () => ({
    writeAuditEntry: mockWriteAuditEntry,
  }));

  function buildMocks(method: string, path: string, status = 200) {
    const req = {
      method,
      path,
      ip: "127.0.0.1",
      body: { name: "test" },
      user: { sub: "user-1", email: "user@example.com", name: "User", roles: ["admin"] },
    } as unknown as Request;

    let capturedBody: unknown;
    const res = {
      statusCode: status,
      json: vi.fn().mockImplementation((body: unknown) => { capturedBody = body; return res; }),
    } as unknown as Response;

    const next: NextFunction = vi.fn();
    return { req, res, next, getCapturedBody: () => capturedBody };
  }

  describe("auditLog middleware", () => {
    beforeEach(() => vi.clearAllMocks());

    it("calls writeAuditEntry on successful POST", () => {
      const { req, res, next } = buildMocks("POST", "/projects/proj-123", 201);
      auditLog()(req, res, next);
      (res.json as ReturnType<typeof vi.fn>)({ id: "proj-123" });
      expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
      expect(mockWriteAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        userId: "user-1",
        resourceType: "project",
        resourceId: "proj-123",
        action: "project.post",
      }));
    });

    it("does NOT call writeAuditEntry on GET", () => {
      const { req, res, next } = buildMocks("GET", "/projects/proj-123");
      auditLog()(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      // res.json was never wrapped, so no audit entry
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it("does NOT call writeAuditEntry on 4xx response", () => {
      const { req, res, next } = buildMocks("DELETE", "/projects/proj-123", 404);
      auditLog()(req, res, next);
      (res.json as ReturnType<typeof vi.fn>)({ error: "not found" });
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it("still returns response body even if writeAuditEntry throws", () => {
      mockWriteAuditEntry.mockImplementationOnce(() => { throw new Error("db error"); });
      const { req, res, next } = buildMocks("POST", "/repositories/repo-abc", 200);
      auditLog()(req, res, next);
      expect(() => (res.json as ReturnType<typeof vi.fn>)({ id: "repo-abc" })).not.toThrow();
    });

    it("logs session mutations under resource type 'session'", () => {
      const { req, res, next } = buildMocks("POST", "/projects/proj-1/sessions", 201);
      auditLog()(req, res, next);
      (res.json as ReturnType<typeof vi.fn>)({});
      expect(mockWriteAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        resourceType: "session",
        action: "session.post",
      }));
    });

    it("truncates large request bodies to 500 chars", () => {
      const { req, res, next } = buildMocks("PATCH", "/projects/proj-1", 200);
      (req as unknown as Record<string, unknown>).body = { data: "x".repeat(1000) };
      auditLog()(req, res, next);
      (res.json as ReturnType<typeof vi.fn>)({});
      const call = mockWriteAuditEntry.mock.calls[0][0] as { details: string };
      expect(call.details.length).toBeLessThanOrEqual(500);
    });
  });
  ```

  Run:
  ```bash
  cd backend && bun test src/api/auditMiddleware.test.ts
  ```

- [ ] **Task 5 — Integration smoke test**

  Start the backend and make a mutating request, then check the audit log:

  ```bash
  cd backend && bun run dev &
  # Create a project
  curl -s -X POST http://localhost:3000/api/projects \
    -H "Content-Type: application/json" \
    -d '{"name":"audit-test","description":"test"}' | jq .

  # Check audit_log table
  sqlite3 data/harness.db "SELECT user_email, action, resource_type, resource_id FROM audit_log LIMIT 5;"
  kill %1
  ```

  Expected: one row with `user_email=local@localhost`, `action=project.post`.

---

## Verification Checklist

- [ ] `auditLog()` mounted in `routes.ts` after `verifyJwt()`, before sub-routers
- [ ] POST/PATCH/PUT/DELETE on `/projects/:id` → row inserted in `audit_log`
- [ ] GET requests → no rows inserted
- [ ] 4xx/5xx responses → no rows inserted
- [ ] `details` column truncated to ≤ 500 characters
- [ ] `writeAuditEntry` failure does not break the HTTP response
- [ ] `req.user` not present (should not happen in practice) → no row written, no crash
- [ ] All 5 unit tests pass
- [ ] TypeScript strict-mode compile passes
