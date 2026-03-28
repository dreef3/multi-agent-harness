import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDb } from "../store/db.js";
import os from "os";
import path from "path";
import fs from "fs";
import request from "supertest";
import express from "express";
import { createRepositoriesRouter } from "../api/repositories.js";

describe("POST /api/repositories validation", () => {
  let app: ReturnType<typeof express>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-repo-"));
    initDb(tmpDir);
    app = express();
    app.use(express.json());
    app.use("/api/repositories", createRepositoriesRouter());
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/api/repositories")
      .send({ cloneUrl: "https://github.com/org/repo", provider: "github" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Validation failed", details: expect.any(Array) });
  });

  it("returns 400 when cloneUrl is missing", async () => {
    const res = await request(app)
      .post("/api/repositories")
      .send({ name: "my-repo", provider: "github" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("returns 400 when provider is invalid value", async () => {
    const res = await request(app)
      .post("/api/repositories")
      .send({ name: "my-repo", cloneUrl: "https://github.com/org/repo", provider: "gitlab" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("returns 400 when provider is missing", async () => {
    const res = await request(app)
      .post("/api/repositories")
      .send({ name: "my-repo", cloneUrl: "https://github.com/org/repo" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("accepts bitbucket-server as valid provider", async () => {
    const res = await request(app)
      .post("/api/repositories")
      .send({ name: "my-repo", cloneUrl: "https://bitbucket.example.com/scm/org/repo.git", provider: "bitbucket-server" });
    expect(res.status).toBe(201);
  });

  it("accepts extra fields without error", async () => {
    const res = await request(app)
      .post("/api/repositories")
      .send({ name: "my-repo", cloneUrl: "https://github.com/org/repo", provider: "github", unknownField: "ignored" });
    expect(res.status).toBe(201);
  });
});
