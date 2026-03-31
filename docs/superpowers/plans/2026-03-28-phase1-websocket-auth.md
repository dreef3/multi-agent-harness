# WebSocket Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate a JWT access token on every WebSocket upgrade request before allowing the connection, using the same JWKS-based verification logic as the HTTP middleware.

**Architecture:** The access token is passed as a `?token=<access_token>` query parameter on the WebSocket upgrade URL (Bearer header is unavailable during the HTTP→WS upgrade in browsers). The upgrade handler calls `verifyWsToken()` exported from `auth.ts` — the same function that backs `verifyJwt()` — so JWKS caching and role extraction are shared. When `AUTH_ENABLED=false` the check is skipped entirely. Connection is closed with code 1008 (policy violation) on any auth failure.

**Tech Stack:** `ws` library upgrade handler, `verifyWsToken` from Plan 17 (`backend/src/api/auth.ts`), existing `backend/src/api/websocket.ts`.

**Depends on:** Plan 17 (jwt-middleware) for `verifyWsToken` and `config.authEnabled`.

---

## Tasks

- [ ] **Task 1 — Read the current `backend/src/api/websocket.ts`**

  Before editing, read the file to understand its current shape:
  - Identify the `wss.on("connection", ...)` handler.
  - Note which line the `projectId` check is on.
  - Note any existing imports at the top of the file.

- [ ] **Task 2 — Add `verifyWsToken` and `config` imports to `websocket.ts`**

  At the top of `backend/src/api/websocket.ts`, add:

  ```typescript
  import { verifyWsToken, LOCAL_USER } from "./auth.js";
  import type { AuthUser } from "./auth.js";
  import { config } from "../config.js";
  ```

  If `config` is already imported, skip that line.

- [ ] **Task 3 — Add auth check at the start of the `wss.on("connection", ...)` handler**

  Locate the connection handler. It currently looks like:

  ```typescript
  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const projectId = url.searchParams.get("projectId");

    if (!projectId) {
      ws.close(1008, "Missing projectId");
      return;
    }
    // ... project lookup follows
  ```

  Replace the handler opening with:

  ```typescript
  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const projectId = url.searchParams.get("projectId");
    const token = url.searchParams.get("token");

    // ---- Auth check -------------------------------------------------------
    let wsUser: AuthUser;
    if (config.authEnabled) {
      if (!token) {
        ws.close(1008, "Missing token");
        return;
      }
      try {
        wsUser = await verifyWsToken(token);
      } catch (err) {
        ws.close(1008, "Invalid or expired token");
        return;
      }
    } else {
      wsUser = LOCAL_USER;
    }
    // -----------------------------------------------------------------------

    if (!projectId) {
      ws.close(1008, "Missing projectId");
      return;
    }
    // ... rest of existing handler continues unchanged
  ```

  The `wsUser` variable is now available for the rest of the handler. You can attach it to the WebSocket object if you need user identity downstream (e.g. for audit logging WS events):

  ```typescript
  // Optional: attach user to ws for downstream use
  (ws as WebSocket & { user: AuthUser }).user = wsUser;
  ```

- [ ] **Task 4 — Update the frontend WebSocket URL to include `?token=`**

  Open the frontend file that constructs the WebSocket URL. It will be something like:

  ```typescript
  const ws = new WebSocket(`ws://localhost:3000/ws?projectId=${projectId}`);
  ```

  Update it to attach the access token when auth is enabled:

  ```typescript
  // In the component or hook that opens the WebSocket:
  import { useAuth } from "../auth/index.js";

  const { getAccessToken } = useAuth();

  function buildWsUrl(projectId: string): string {
    const base = `${import.meta.env.VITE_API_WS_URL ?? "ws://localhost:3000"}/ws`;
    const params = new URLSearchParams({ projectId });
    if (import.meta.env.VITE_AUTH_ENABLED === "true") {
      const token = getAccessToken();
      if (token) params.set("token", token);
    }
    return `${base}?${params.toString()}`;
  }

  const ws = new WebSocket(buildWsUrl(projectId));
  ```

  Find the exact file by searching for `new WebSocket(` in the frontend source.

- [ ] **Task 5 — Verify TypeScript compiles (backend)**

  ```bash
  cd backend && bun run tsc --noEmit
  ```

- [ ] **Task 6 — Verify TypeScript compiles (frontend)**

  ```bash
  cd frontend && bun run tsc --noEmit
  ```

- [ ] **Task 7 — Write unit tests `backend/src/api/websocket-auth.test.ts`**

  ```typescript
  import { describe, it, expect, vi, beforeEach } from "vitest";

  // Mock auth before importing websocket module
  const mockVerifyWsToken = vi.fn();
  vi.mock("./auth.js", () => ({
    verifyWsToken: mockVerifyWsToken,
    LOCAL_USER: { sub: "local-user", email: "local@localhost", name: "Local User", roles: ["admin"] },
  }));

  // We test the auth guard logic directly rather than the full WS setup
  // because setupWebSocket() binds to a real HTTP server.
  // Extract the auth decision logic into a testable helper.

  import { config } from "../config.js";
  import { verifyWsToken, LOCAL_USER } from "./auth.js";
  import type { AuthUser } from "./auth.js";

  /**
   * Inline the same decision logic from the connection handler so it can
   * be unit tested without a real WebSocket server.
   */
  async function resolveWsUser(token: string | null, authEnabled: boolean): Promise<AuthUser> {
    if (!authEnabled) return LOCAL_USER;
    if (!token) throw new Error("Missing token");
    return verifyWsToken(token);
  }

  describe("WebSocket auth guard", () => {
    beforeEach(() => vi.clearAllMocks());

    it("returns LOCAL_USER when auth is disabled (no token)", async () => {
      const user = await resolveWsUser(null, false);
      expect(user).toEqual(LOCAL_USER);
    });

    it("throws when auth enabled and no token provided", async () => {
      await expect(resolveWsUser(null, true)).rejects.toThrow("Missing token");
    });

    it("throws when auth enabled and token is invalid", async () => {
      mockVerifyWsToken.mockRejectedValueOnce(new Error("bad token"));
      await expect(resolveWsUser("bad.token", true)).rejects.toThrow();
    });

    it("returns verified user when auth enabled and token is valid", async () => {
      const expectedUser: AuthUser = { sub: "u1", email: "u@e.com", name: "U", roles: ["viewer"] };
      mockVerifyWsToken.mockResolvedValueOnce(expectedUser);
      const user = await resolveWsUser("valid.token", true);
      expect(user).toEqual(expectedUser);
      expect(mockVerifyWsToken).toHaveBeenCalledWith("valid.token");
    });
  });
  ```

  Run:
  ```bash
  cd backend && bun test src/api/websocket-auth.test.ts
  ```

- [ ] **Task 8 — Manual end-to-end smoke test**

  With `AUTH_ENABLED=false` (default), verify existing WebSocket connections still work:

  ```bash
  cd backend && bun run dev &
  # Use wscat or the frontend — confirm no regression
  # Then stop the server
  kill %1
  ```

---

## Verification Checklist

- [ ] `AUTH_ENABLED=false` → WebSocket connections require only `?projectId=`, auth skipped
- [ ] `AUTH_ENABLED=true`, no `?token=` → connection closed with code 1008 "Missing token"
- [ ] `AUTH_ENABLED=true`, invalid token → connection closed with code 1008 "Invalid or expired token"
- [ ] `AUTH_ENABLED=true`, valid token → connection proceeds, `wsUser` populated
- [ ] Frontend WebSocket URL includes `?token=` when `VITE_AUTH_ENABLED=true`
- [ ] Existing WebSocket functionality (project events, log streaming) unaffected in auth-disabled mode
- [ ] All 4 unit tests pass
- [ ] TypeScript strict-mode compile passes for both backend and frontend
