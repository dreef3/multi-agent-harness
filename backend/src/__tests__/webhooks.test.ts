import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { type Request } from "express";
import request from "supertest";
import { createHmac } from "crypto";
import os from "os";
import path from "path";
import fs from "fs";
import { initDb } from "../store/db.js";
import { createWebhooksRouter, setDebounceEngine } from "../api/webhooks.js";
import { DebounceEngine } from "../debounce/engine.js";

const TEST_SECRET = "test-secret-abc123";

function sign(payload: string): string {
  const hmac = createHmac("sha256", TEST_SECRET);
  hmac.update(payload);
  return "sha256=" + hmac.digest("hex");
}

function wrongSign(payload: string): string {
  const hmac = createHmac("sha256", "wrong-secret");
  hmac.update(payload);
  return "sha256=" + hmac.digest("hex");
}

function makeApp() {
  const app = express();
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

describe("webhook signature verification", () => {
  let engine: DebounceEngine;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-webhook-"));
    initDb(tmpDir);
    process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
    engine = new DebounceEngine({ delayMs: 60_000 });
    setDebounceEngine(engine);
  });

  afterEach(() => {
    engine.dispose();
    delete process.env.GITHUB_WEBHOOK_SECRET;
    setDebounceEngine(null as unknown as DebounceEngine);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts a request with a valid HMAC signature", async () => {
    const payload = JSON.stringify({ action: "created", pull_request: { number: 42 }, comment: { id: 1, user: { login: "alice" }, body: "lgtm", path: "src/index.ts", line: 10, created_at: new Date().toISOString() } });
    const res = await request(makeApp())
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request_review_comment")
      .set("x-hub-signature-256", sign(payload))
      .set("content-type", "application/json")
      .send(payload);
    // 404 = PR not found in DB — signature was accepted
    expect([200, 404]).toContain(res.status);
  });

  it("rejects a request with an invalid HMAC signature", async () => {
    const payload = JSON.stringify({ action: "created" });
    const res = await request(makeApp())
      .post("/api/webhooks/github")
      .set("x-github-event", "push")
      .set("x-hub-signature-256", wrongSign(payload))
      .set("content-type", "application/json")
      .send(payload);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid signature");
  });

  it("uses raw bytes — pretty-printed JSON verifies correctly", async () => {
    // Re-serializing via JSON.stringify would collapse the whitespace,
    // breaking the HMAC. Only the raw-body path preserves the original bytes.
    const prettyPayload = '{\n  "action": "created",\n  "pull_request": {\n    "number": 99\n  }\n}';
    const sig = sign(prettyPayload);
    const res = await request(makeApp())
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", sig)
      .set("content-type", "application/json")
      .send(prettyPayload);
    // Any non-401 means the signature was accepted
    expect(res.status).not.toBe(401);
  });

  it("rejects when secret env var is missing", async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const payload = JSON.stringify({ action: "ping" });
    const res = await request(makeApp())
      .post("/api/webhooks/github")
      .set("x-github-event", "ping")
      .set("x-hub-signature-256", sign(payload))
      .set("content-type", "application/json")
      .send(payload);
    expect(res.status).toBe(401);
  });
});
