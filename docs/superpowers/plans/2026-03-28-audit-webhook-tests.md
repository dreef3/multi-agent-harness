# Webhook Handler Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add comprehensive test coverage for `backend/src/api/webhooks.ts`, which currently has zero tests, covering HMAC signature verification, GitHub event routing, and debounce integration.

**Architecture:** Tests use `supertest` (already in devDependencies) against a real Express app instance wired with a temp SQLite DB, following the same setup pattern as `backend/src/__tests__/projects.test.ts`. The `verifySignature` function is not exported, so signature tests work through the HTTP layer by constructing valid/invalid HMAC-SHA256 signatures. The `DebounceEngine` is mocked to avoid timing dependencies.

**Tech Stack:** Express + TypeScript, Vitest, supertest, better-sqlite3 temp DB, Node.js `crypto.createHmac`.

---

## Context

**File to test:** `backend/src/api/webhooks.ts`

Key behaviors to verify:
1. `verifySignature` — HMAC-SHA256 using `timingSafeEqual`. The function is not exported, so it is tested via HTTP.
2. `POST /webhooks/github` — auth guard (missing secret → 401, invalid HMAC → 401, valid → 200).
3. PR review event (`pull_request_review` + `action=submitted`) — inserts comment, calls `debounceEngine.notify`.
4. PR review comment event (`pull_request_review_comment`) — inserts comment, calls `debounceEngine.notify`.
5. PR closed event (`pull_request` + `action=closed`) — calls `debounceEngine.cancel`.
6. Unknown PR number (404 from store) — returns 404.
7. `POST /webhooks/test` — always returns 200 (sanity check).

**Router mount:** In `routes.ts`, webhooks are mounted at `/webhooks` within the `/api` prefix → full path is `/api/webhooks/github`. In tests, mount the router directly at `/webhooks` and call `/webhooks/github`.

**Existing pattern:** `backend/src/__tests__/projects.test.ts` uses `fs.mkdtempSync` + `initDb` + `express()` + `supertest`. Follow exactly.

**Raw body:** The production `index.ts` registers `express.json({ verify: (_req, _res, buf) => { (req as any).rawBody = buf; } })`. The webhook handler uses `JSON.stringify(req.body)` as the payload for signature verification rather than the raw buffer. Tests must match this — sign `JSON.stringify(payload)`.

---

## Steps

- [ ] **Step 1 — Create the test file**

  Create `backend/src/__tests__/webhooks.test.ts`.

  Full file content:

  ```typescript
  import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
  import { createHmac } from "crypto";
  import express from "express";
  import request from "supertest";
  import fs from "fs";
  import path from "path";
  import os from "os";
  import { initDb } from "../store/db.js";
  import { createWebhooksRouter, setDebounceEngine } from "../api/webhooks.js";
  import type { DebounceEngine } from "../debounce/engine.js";

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function makeApp() {
    const app = express();
    // Use express.json() — webhook handler signs JSON.stringify(req.body)
    app.use(express.json());
    app.use("/webhooks", createWebhooksRouter());
    return app;
  }

  function sign(payload: unknown, secret: string): string {
    const body = JSON.stringify(payload);
    const hmac = createHmac("sha256", secret);
    hmac.update(body);
    return "sha256=" + hmac.digest("hex");
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-webhook-"));
    initDb(tmpDir);
    // Clear GITHUB_WEBHOOK_SECRET before each test to avoid cross-test leakage
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setDebounceEngine(null as unknown as DebounceEngine);
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Auth guard
  // ---------------------------------------------------------------------------

  describe("POST /webhooks/github — auth", () => {
    it("returns 401 when GITHUB_WEBHOOK_SECRET is not set", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/webhooks/github")
        .set("x-github-event", "ping")
        .set("x-hub-signature-256", "sha256=anything")
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/missing/i);
    });

    it("returns 401 when x-hub-signature-256 header is missing", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "secret";
      const app = makeApp();
      const res = await request(app)
        .post("/webhooks/github")
        .set("x-github-event", "ping")
        .send({});
      expect(res.status).toBe(401);
    });

    it("returns 401 for invalid HMAC signature", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "secret";
      const app = makeApp();
      const res = await request(app)
        .post("/webhooks/github")
        .set("x-github-event", "ping")
        .set("x-hub-signature-256", "sha256=0000000000000000000000000000000000000000000000000000000000000000")
        .send({ action: "ping" });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid/i);
    });

    it("returns 401 when signature length mismatches (timing-safe guard)", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "secret";
      const app = makeApp();
      // Deliberately short signature — timingSafeEqual requires equal-length buffers;
      // verifySignature must not throw, just return false → 401
      const res = await request(app)
        .post("/webhooks/github")
        .set("x-github-event", "ping")
        .set("x-hub-signature-256", "sha256=abc")
        .send({ action: "ping" });
      expect(res.status).toBe(401);
    });

    it("accepts a request with a valid HMAC signature", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "secret";
      const app = makeApp();
      const payload = { action: "ping" };
      const res = await request(app)
        .post("/webhooks/github")
        .set("x-github-event", "ping")
        .set("x-hub-signature-256", sign(payload, "secret"))
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // pull_request_review event
  // ---------------------------------------------------------------------------

  describe("POST /webhooks/github — pull_request_review", () => {
    it("returns 400 when pull_request is missing from payload", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "s";
      const app = makeApp();
      const payload = { action: "submitted", review: { id: 1, user: { login: "reviewer" }, body: "LGTM" } };
      const res = await request(app)
        .post("/webhooks/github")
        .set("x-github-event", "pull_request_review")
        .set("x-hub-signature-256", sign(payload, "s"))
        .send(payload);
      expect(res.status).toBe(400);
    });

    it("returns 404 when PR number is not in the database", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "s";
      const app = makeApp();
      const payload = {
        action: "submitted",
        pull_request: { number: 99, html_url: "https://github.com/org/repo/pull/99" },
        review: { id: 1, user: { login: "reviewer" }, body: "LGTM" },
      };
      const res = await request(app)
        .post("/webhooks/github")
        .set("x-github-event", "pull_request_review")
        .set("x-hub-signature-256", sign(payload, "s"))
        .send(payload);
      expect(res.status).toBe(404);
    });

    it("notifies debounce engine when PR exists", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "s";

      // Seed a PR in the database
      const { upsertPullRequest } = await import("../store/pullRequests.js");
      upsertPullRequest({
        id: "pr-1",
        projectId: "proj-1",
        repositoryId: "repo-1",
        agentSessionId: "sess-1",
        provider: "github",
        externalId: "42",
        url: "https://github.com/org/repo/pull/42",
        branch: "agent/task-1",
        status: "open",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockNotify = vi.fn();
      const mockEngine = { notify: mockNotify, cancel: vi.fn() } as unknown as DebounceEngine;
      setDebounceEngine(mockEngine);

      const app = makeApp();
      const payload = {
        action: "submitted",
        pull_request: { number: 42, html_url: "https://github.com/org/repo/pull/42" },
        review: { id: 101, user: { login: "reviewer" }, body: "Looks good" },
      };
      const res = await request(app)
        .post("/webhooks/github")
        .set("x-github-event", "pull_request_review")
        .set("x-hub-signature-256", sign(payload, "s"))
        .send(payload);

      expect(res.status).toBe(200);
      expect(mockNotify).toHaveBeenCalledWith("pr-1", expect.any(Function));
    });

    it("does not throw when review body is empty (no comment inserted)", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "s";

      const { upsertPullRequest } = await import("../store/pullRequests.js");
      upsertPullRequest({
        id: "pr-2", projectId: "proj-1", repositoryId: "repo-1", agentSessionId: "sess-1",
        provider: "github", externalId: "43", url: "https://github.com/org/repo/pull/43",
        branch: "agent/task-2", status: "open",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });

      const app = makeApp();
      const payload = {
        action: "submitted",
        pull_request: { number: 43 },
        review: { id: 102, user: { login: "reviewer" }, body: "" },
      };
      const res = await request(app)
        .post("/webhooks/github")
        .set("x-github-event", "pull_request_review")
        .set("x-hub-signature-256", sign(payload, "s"))
        .send(payload);
      expect(res.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // pull_request_review_comment event
  // ---------------------------------------------------------------------------

  describe("POST /webhooks/github — pull_request_review_comment", () => {
    it("returns 400 when comment is missing from payload", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "s";
      const app = makeApp();
      const payload = {
        action: "created",
        pull_request: { number: 1, html_url: "https://github.com/org/repo/pull/1" },
        // comment intentionally omitted
      };
      const res = await request(app)
        .post("/webhooks/github")
        .set("x-github-event", "pull_request_review_comment")
        .set("x-hub-signature-256", sign(payload, "s"))
        .send(payload);
      expect(res.status).toBe(400);
    });

    it("returns 404 when PR is not in the database", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "s";
      const app = makeApp();
      const payload = {
        action: "created",
        pull_request: { number: 999 },
        comment: {
          id: 5, user: { login: "dev" }, body: "nit: spacing",
          path: "src/index.ts", line: 10, created_at: new Date().toISOString(),
        },
      };
      const res = await request(app)
        .post("/webhooks/github")
        .set("x-github-event", "pull_request_review_comment")
        .set("x-hub-signature-256", sign(payload, "s"))
        .send(payload);
      expect(res.status).toBe(404);
    });

    it("inserts comment and returns 200 when PR exists", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "s";

      const { upsertPullRequest, getReviewComments } = await import("../store/pullRequests.js");
      upsertPullRequest({
        id: "pr-3", projectId: "proj-1", repositoryId: "repo-1", agentSessionId: "sess-1",
        provider: "github", externalId: "55", url: "https://github.com/org/repo/pull/55",
        branch: "agent/task-3", status: "open",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });

      const app = makeApp();
      const payload = {
        action: "created",
        pull_request: { number: 55 },
        comment: {
          id: 7, user: { login: "alice" }, body: "fix this",
          path: "src/foo.ts", line: 42, created_at: new Date().toISOString(),
        },
      };
      const res = await request(app)
        .post("/webhooks/github")
        .set("x-github-event", "pull_request_review_comment")
        .set("x-hub-signature-256", sign(payload, "s"))
        .send(payload);

      expect(res.status).toBe(200);
      const comments = getReviewComments("pr-3");
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toBe("fix this");
      expect(comments[0].filePath).toBe("src/foo.ts");
      expect(comments[0].lineNumber).toBe(42);
    });
  });

  // ---------------------------------------------------------------------------
  // pull_request closed/merged — debounce cancel
  // ---------------------------------------------------------------------------

  describe("POST /webhooks/github — pull_request closed", () => {
    it("calls debounce cancel when PR is closed", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "s";

      const { upsertPullRequest } = await import("../store/pullRequests.js");
      upsertPullRequest({
        id: "pr-4", projectId: "proj-1", repositoryId: "repo-1", agentSessionId: "sess-1",
        provider: "github", externalId: "70", url: "https://github.com/org/repo/pull/70",
        branch: "agent/task-4", status: "open",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });

      const mockCancel = vi.fn();
      setDebounceEngine({ notify: vi.fn(), cancel: mockCancel } as unknown as DebounceEngine);

      const app = makeApp();
      const payload = { action: "closed", pull_request: { number: 70 } };
      const res = await request(app)
        .post("/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", sign(payload, "s"))
        .send(payload);

      expect(res.status).toBe(200);
      expect(mockCancel).toHaveBeenCalledWith("pr-4");
    });

    it("does not throw when PR is not in database during close event", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "s";
      const app = makeApp();
      const payload = { action: "closed", pull_request: { number: 9999 } };
      const res = await request(app)
        .post("/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", sign(payload, "s"))
        .send(payload);
      // Returns 200 — the handler silently skips if PR not found during close
      expect(res.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Test endpoint
  // ---------------------------------------------------------------------------

  describe("POST /webhooks/test", () => {
    it("returns 200 with received=true for any payload", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/webhooks/test")
        .send({ hello: "world" });
      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
      expect(res.body.timestamp).toBeTruthy();
    });
  });
  ```

- [ ] **Step 2 — Check `setDebounceEngine` null safety**

  The `afterEach` in the test calls `setDebounceEngine(null as unknown as DebounceEngine)` to reset the global. Verify that `webhooks.ts` exports `setDebounceEngine` (it does — line 39). Confirm the function accepts `null` without crashing — look at line 37: `let debounceEngine: DebounceEngine | null = null`. The assignment is fine.

- [ ] **Step 3 — Check `upsertPullRequest` and `getReviewComments` are exported from the store**

  ```bash
  grep -n "export" /home/ae/multi-agent-harness/backend/src/store/pullRequests.ts | head -20
  ```

  If `getReviewComments` is not exported, adjust the test for the review_comment insertion step to check via the HTTP response body or use a different store function that is exported.

- [ ] **Step 4 — Run tests**

  ```bash
  cd /home/ae/multi-agent-harness/backend && bun test src/__tests__/webhooks.test.ts --reporter=verbose 2>&1
  ```

  Fix any import errors:
  - If `upsertPullRequest` is not exported: use the HTTP endpoint to create test PRs instead, or export it.
  - If `getReviewComments` is not exported: verify via the pull-requests HTTP API or export the function.

  All tests should pass.

- [ ] **Step 5 — Run full backend test suite**

  ```bash
  cd /home/ae/multi-agent-harness/backend && bun test --reporter=verbose 2>&1 | tail -30
  ```

  No regressions in existing tests.

---

## Notes

- The webhook handler signs `JSON.stringify(req.body)` (line 64 of `webhooks.ts`), not the raw request buffer. The `sign()` helper in the test reflects this. In production, if GitHub sends a body with different key ordering or whitespace, this would fail — but that is a pre-existing issue with the current implementation, not introduced by these tests.
- `timingSafeEqual` throws a `RangeError` if the two buffers have different lengths. The production `verifySignature` at line 33 does not guard against this. The "mismatched length" test case verifies that the implementation handles this gracefully (it should return false or throw and be caught by Express's error handler). If the test shows it throws unhandled, add a try/catch to `verifySignature` in `webhooks.ts` as a follow-up fix.
- `supertest` is already in `devDependencies` (`^7.2.2`) — no installation needed.
