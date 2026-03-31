# Pin SDK Version and Webhook Raw Body Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin `@mariozechner/pi-coding-agent` to an exact version in both agent `package.json` files, and fix webhook HMAC signature verification to use the original raw request bytes instead of a re-serialized body.

**Architecture:** Part A eliminates surprise breakage from minor SDK updates by locking the resolved version. Part B fixes a correctness bug: Express's `json()` middleware parses the body before the webhook handler sees it; re-serializing with `JSON.stringify` can change whitespace or key ordering, causing HMAC mismatches against GitHub's signature. The fix uses `express.json({ verify })` to capture the raw `Buffer` before parsing, stores it on `req.rawBody` via a TypeScript module augmentation, and reads that buffer in `webhooks.ts`.

**Tech Stack:** Express + TypeScript, `express.json({ verify })` built-in hook, `crypto.createHmac`, Bun test runner, Vitest.

---

## Part A — Pin `@mariozechner/pi-coding-agent`

### Step A1 — Find the resolved version

- [ ] Run the following to see what version is actually installed in each agent. Since there are no `bun.lock` files committed, check the installed package directly:

```bash
# In sub-agent
cat sub-agent/node_modules/@mariozechner/pi-coding-agent/package.json | grep '"version"'

# In planning-agent
cat planning-agent/node_modules/@mariozechner/pi-coding-agent/package.json | grep '"version"'
```

If `node_modules` are not present (Docker-only build), use `bun pm ls` after installing:

```bash
cd sub-agent && bun install && bun pm ls | grep pi-coding-agent
cd planning-agent && bun install && bun pm ls | grep pi-coding-agent
```

The expected output is something like: `@mariozechner/pi-coding-agent@0.61.1`

Record the exact version (e.g., `0.61.1`). Both agents should resolve to the same version since both declare `^0.61.1`.

### Step A2 — Update `sub-agent/package.json`

- [ ] Open `sub-agent/package.json`. Current content:

```json
{
  "name": "@multi-agent-harness/sub-agent",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "@mariozechner/pi-coding-agent": "^0.61.1"
  }
}
```

- [ ] Change `"^0.61.1"` to the exact version found in Step A1 (e.g., `"0.61.1"`):

```json
{
  "name": "@multi-agent-harness/sub-agent",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "@mariozechner/pi-coding-agent": "0.61.1"
  }
}
```

### Step A3 — Update `planning-agent/package.json`

- [ ] Open `planning-agent/package.json`. Current content:

```json
{
  "name": "@multi-agent-harness/planning-agent",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "@mariozechner/pi-coding-agent": "^0.61.1",
    "@sinclair/typebox": "^0.34.41",
    "superpowers": "github:obra/superpowers#v5.0.4"
  }
}
```

- [ ] Change `"^0.61.1"` to the exact version:

```json
{
  "name": "@multi-agent-harness/planning-agent",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "@mariozechner/pi-coding-agent": "0.61.1",
    "@sinclair/typebox": "^0.34.41",
    "superpowers": "github:obra/superpowers#v5.0.4"
  }
}
```

### Step A4 — Re-install and verify

- [ ] Run `cd sub-agent && bun install` — should complete without upgrading the SDK.
- [ ] Run `cd planning-agent && bun install` — same.

---

## Part B — Webhook raw body fix

### Background

`backend/src/api/webhooks.ts` line 63 currently reads:

```typescript
const rawBody = JSON.stringify(req.body);
```

By this point `express.json()` has already consumed the request stream and parsed the body into a JS object. `JSON.stringify` re-serializes it, which may:
- Remove insignificant whitespace that was in the original bytes
- Reorder keys (in environments where insertion order is not guaranteed)
- Fail to round-trip numbers or Unicode escape sequences precisely

GitHub signs the raw bytes it sends. Any deviation causes `timingSafeEqual` to return `false` and legitimate webhooks get rejected with 401.

### Step B1 — Add TypeScript module augmentation for `req.rawBody`

- [ ] Create `backend/src/types/express.d.ts`:

```typescript
// Augment Express Request to carry the raw request body buffer.
// Populated by the express.json({ verify }) hook in index.ts.
declare namespace Express {
  interface Request {
    rawBody?: Buffer;
  }
}
```

This file needs no imports — TypeScript picks up ambient `declare namespace Express` augmentations automatically when `tsconfig.json` includes `src/**/*.d.ts` in its file set.

- [ ] Verify `backend/tsconfig.json` includes the `src` directory (it almost certainly does via `"include": ["src"]` or similar). If it uses explicit `files`, add the new file path.

### Step B2 — Update `express.json()` call in `backend/src/index.ts`

- [ ] Open `backend/src/index.ts`
- [ ] Find the line:

```typescript
  app.use(express.json());
```

- [ ] Replace it with:

```typescript
  app.use(
    express.json({
      verify: (_req, _res, buf) => {
        (_req as import("express").Request & { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
```

The `verify` callback is called by Express's body-parser with the raw `Buffer` before any JSON parsing occurs. Storing it on the request object makes it available to all downstream handlers.

### Step B3 — Update `webhooks.ts` to use `req.rawBody`

- [ ] Open `backend/src/api/webhooks.ts`
- [ ] Find line 63:

```typescript
    const rawBody = JSON.stringify(req.body);
```

- [ ] Replace it with:

```typescript
    const rawBody = (req as import("express").Request & { rawBody: Buffer }).rawBody?.toString("utf8")
      ?? JSON.stringify(req.body);
```

The `?? JSON.stringify(req.body)` fallback ensures the handler still works in test contexts where the `verify` hook is not configured, avoiding a hard crash.

Full updated block (lines 56–67 area) for reference:

```typescript
    // Verify webhook signature
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!signature || !secret) {
      res.status(401).json({ error: "Missing signature or secret" });
      return;
    }

    const rawBody = (req as import("express").Request & { rawBody: Buffer }).rawBody?.toString("utf8")
      ?? JSON.stringify(req.body);
    if (!verifySignature(rawBody, signature, secret)) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
```

### Step B4 — Write webhook signature tests

- [ ] Create `backend/src/__tests__/webhooks.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import express, { type Request, type Response } from "express";
import { createServer } from "http";
import { createHmac } from "crypto";
import { createWebhooksRouter, setDebounceEngine } from "../api/webhooks.js";
import { DebounceEngine } from "../debounce/engine.js";

// ── helpers ────────────────────────────────────────────────────────────────

const TEST_SECRET = "test-secret-abc123";

function sign(payload: string): string {
  const hmac = createHmac("sha256", TEST_SECRET);
  hmac.update(payload);
  return "sha256=" + hmac.digest("hex");
}

function makeApp() {
  const app = express();

  // Mirror the production setup: capture raw body before JSON parse
  app.use(
    express.json({
      verify: (_req, _res, buf) => {
        (_req as Request & { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );

  app.use("/api/webhooks", createWebhooksRouter());
  return app;
}

async function postWebhook(
  app: ReturnType<typeof makeApp>,
  rawPayload: string,
  signature: string,
  event = "pull_request_review_comment",
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const req = require("http").request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/webhooks/github",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": event,
            "x-hub-signature-256": signature,
            "content-length": Buffer.byteLength(rawPayload),
          },
        },
        (res: any) => {
          let data = "";
          res.on("data", (c: string) => (data += c));
          res.on("end", () => {
            server.close();
            try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
            catch { resolve({ status: res.statusCode, body: data }); }
          });
        },
      );
      req.on("error", reject);
      req.write(rawPayload);
      req.end();
    });
  });
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("webhook signature verification", () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
    // Provide a no-op debounce engine so handler doesn't crash
    setDebounceEngine(new DebounceEngine({ delayMs: 60_000 }));
  });

  it("accepts a request with a valid HMAC signature", async () => {
    const payload = JSON.stringify({
      action: "created",
      pull_request: { number: 42 },
      comment: {
        id: 1,
        user: { login: "alice" },
        body: "looks good",
        path: "src/index.ts",
        line: 10,
        created_at: new Date().toISOString(),
      },
    });

    const sig = sign(payload);
    const result = await postWebhook(makeApp(), payload, sig);
    // 404 means signature passed but PR wasn't found — that's fine for this test
    expect([200, 404]).toContain(result.status);
  });

  it("rejects a request with an invalid HMAC signature", async () => {
    const payload = JSON.stringify({ action: "created", pull_request: { number: 1 } });
    const result = await postWebhook(makeApp(), payload, "sha256=deadbeef");
    expect(result.status).toBe(401);
  });

  it("uses raw bytes — a payload with extra whitespace verifies correctly", async () => {
    // GitHub sends compact JSON; here we test with pretty-printed JSON.
    // JSON.stringify(JSON.parse(prettyPayload)) would strip the spaces, breaking
    // the HMAC. The raw body path must preserve them.
    const prettyPayload =
      '{\n  "action": "created",\n  "pull_request": {\n    "number": 99\n  }\n}';

    const sig = sign(prettyPayload);
    const app = makeApp();
    const result = await postWebhook(app, prettyPayload, sig, "pull_request");
    // Any status except 401 means the signature was accepted
    expect(result.status).not.toBe(401);
  });

  it("rejects when secret env var is missing", async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const payload = JSON.stringify({ action: "ping" });
    const result = await postWebhook(makeApp(), payload, sign(payload));
    expect(result.status).toBe(401);
  });
});
```

### Step B5 — Type check and test

- [ ] Run `cd backend && bunx tsc --noEmit` — zero errors expected.
- [ ] Run `cd backend && bun run test` — all tests including new webhook tests must pass.

---

## Key files changed

| File | Change |
|---|---|
| `sub-agent/package.json` | `^0.61.1` → `0.61.1` (exact pin) |
| `planning-agent/package.json` | `^0.61.1` → `0.61.1` (exact pin) |
| `backend/src/types/express.d.ts` | New file — augments `Express.Request` with `rawBody?: Buffer` |
| `backend/src/index.ts` | `express.json()` → `express.json({ verify })` to capture raw buffer |
| `backend/src/api/webhooks.ts` | Line 63: use `req.rawBody?.toString("utf8")` instead of `JSON.stringify(req.body)` |
| `backend/src/__tests__/webhooks.test.ts` | New test file — 4 tests covering signature verification |

## Risks and notes

- The `express.json({ verify })` hook is called synchronously before parsing. It does not affect performance measurably for typical webhook payloads (a few KB).
- The `?? JSON.stringify(req.body)` fallback in `webhooks.ts` is intentional — it keeps the handler from crashing if `rawBody` is somehow absent (e.g., a test that sets up `express.json()` without the `verify` hook). In production the fallback will never be reached.
- Part A (pinning) should be committed separately from Part B (webhook fix) for cleaner git history and easier rollback.
- If a newer SDK version is ever needed, update both `package.json` files atomically and re-test before merging.
