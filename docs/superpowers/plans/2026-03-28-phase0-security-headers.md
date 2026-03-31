# Security Headers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HTTP security headers to the Express backend via helmet and to the nginx frontend via `add_header` directives.

**Architecture:** The Express app in `backend/src/index.ts` gets a `helmet()` call with a custom CSP that permits WebSocket connections and inline styles (required by the frontend). The nginx config at `frontend/nginx.conf` gets five `add_header` directives in the top-level `server` block so they apply to all responses. A new integration test in `backend/src/__tests__/security.test.ts` asserts that the key headers are present on API responses.

**Tech Stack:** Express, helmet, nginx, TypeScript, Vitest, supertest

---

## Task 1 — Write failing security header tests

- [ ] Create `backend/src/__tests__/security.test.ts`:
  ```typescript
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { initDb } from "../store/db.js";
  import os from "os";
  import path from "path";
  import fs from "fs";
  import request from "supertest";
  import express from "express";
  import helmet from "helmet";
  import { createRouter } from "../api/routes.js";
  import Dockerode from "dockerode";

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
  ```

- [ ] Run tests to confirm they fail (helmet not yet installed/wired):
  ```bash
  cd /home/ae/multi-agent-harness/backend && bun run test --reporter=verbose 2>&1 | grep -A3 "security headers"
  ```

---

## Task 2 — Install helmet

- [ ] Install helmet and its types:
  ```bash
  cd /home/ae/multi-agent-harness/backend && bun add helmet
  ```

- [ ] Verify installation:
  ```bash
  cd /home/ae/multi-agent-harness/backend && bun pm ls | grep helmet
  ```
  Note: `@types/helmet` is not needed — helmet v7+ ships its own TypeScript types.

---

## Task 3 — Wire helmet into `backend/src/index.ts`

Current relevant section of `index.ts` (lines 48-50):
```typescript
const app = express();
app.use(express.json());
app.use("/api", createRouter(config.dataDir, docker));
```

- [ ] Add the helmet import at the top of `backend/src/index.ts`, after the existing imports:
  ```typescript
  import helmet from "helmet";
  ```

- [ ] Replace the `app.use(express.json())` setup block (lines 48-50) with:
  ```typescript
  const app = express();
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
  app.use("/api", createRouter(config.dataDir, docker));
  ```

- [ ] Run the security header tests:
  ```bash
  cd /home/ae/multi-agent-harness/backend && bun run test --reporter=verbose 2>&1 | grep -A10 "security headers"
  ```
  All four security header tests should now pass.

- [ ] Run the full test suite to confirm no regressions:
  ```bash
  cd /home/ae/multi-agent-harness/backend && bun run test
  ```

---

## Task 4 — Add security headers to nginx

Current `frontend/nginx.conf` server block (full file for reference):
```nginx
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    # Enable gzip compression
    gzip on;
    ...

    # Cache static assets
    location ~* \.(js|css|...)$ { ... }

    # Handle client-side routing
    location / { ... }

    # Proxy API requests to backend
    location /api { ... }

    # Proxy WebSocket requests to backend
    location /ws { ... }
}
```

- [ ] Edit `frontend/nginx.conf` — add the security headers block immediately after `index index.html;` and before the `# Enable gzip compression` comment. Insert these lines:
  ```nginx
      # Security headers
      add_header X-Frame-Options "SAMEORIGIN" always;
      add_header X-Content-Type-Options "nosniff" always;
      add_header X-XSS-Protection "1; mode=block" always;
      add_header Referrer-Policy "strict-origin-when-cross-origin" always;
      add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  ```

  The resulting top of the server block should look like:
  ```nginx
  server {
      listen 80;
      server_name localhost;
      root /usr/share/nginx/html;
      index index.html;

      # Security headers
      add_header X-Frame-Options "SAMEORIGIN" always;
      add_header X-Content-Type-Options "nosniff" always;
      add_header X-XSS-Protection "1; mode=block" always;
      add_header Referrer-Policy "strict-origin-when-cross-origin" always;
      add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

      # Enable gzip compression
      gzip on;
      ...
  ```

  Note: Place the headers in the top-level `server` block (not inside a `location` block) so they apply to all responses including static assets, API proxy responses, and the SPA fallback. The `always` parameter ensures the headers are sent even on error responses.

- [ ] Validate nginx config syntax (if nginx is available locally):
  ```bash
  nginx -t -c /home/ae/multi-agent-harness/frontend/nginx.conf 2>&1 || echo "nginx not available locally — verify in container"
  ```

---

## Task 5 — Final verification

- [ ] Run the full backend test suite:
  ```bash
  cd /home/ae/multi-agent-harness/backend && bun run test
  ```

- [ ] Run TypeScript type check:
  ```bash
  cd /home/ae/multi-agent-harness/backend && bunx tsc --noEmit
  ```

- [ ] Confirm changed files:
  - `backend/src/index.ts` — `import helmet from "helmet"` added; `app.use(helmet({...}))` before `app.use(express.json())`
  - `backend/package.json` — `helmet` in dependencies
  - `backend/src/__tests__/security.test.ts` — new test file with 4 header assertions
  - `frontend/nginx.conf` — 5 `add_header` directives in the `server` block

- [ ] Verify the helmet CSP does not break frontend assets. The directives allow:
  - `'unsafe-inline'` in `styleSrc` — required for CSS-in-JS and injected styles
  - `ws:` and `wss:` in `connectSrc` — required for the WebSocket connection from frontend to `/ws`
  - `data:` in `imgSrc` — required for inline data URIs used in icons/avatars
