# Input Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add TypeBox schema validation middleware to all mutating API routes in `projects.ts` and `repositories.ts`, returning structured 400 errors on invalid input.

**Architecture:** A new `backend/src/api/validate.ts` module exports a reusable `validateBody()` Express middleware factory that takes a TypeBox schema and returns a handler that calls `Value.Check()` / `Value.Errors()`. Each mutating route in `projects.ts` and `repositories.ts` is updated to use this middleware before its handler logic. Existing manual field checks (e.g., `if (!name)`) remain in place as a second layer but the TypeBox check fires first.

**Tech Stack:** TypeScript, Express, `@sinclair/typebox` (already installed), Vitest, supertest

---

## Task 1 — Write failing tests for validation

Tests go in `backend/src/__tests__/projects.test.ts` (for project and task routes) and a new `backend/src/__tests__/repositories.test.ts` (for repository routes, check if it exists first).

- [ ] Check for existing repositories test file:
  ```bash
  ls /home/ae/multi-agent-harness/backend/src/__tests__/
  ```

- [ ] Add validation tests to `backend/src/__tests__/projects.test.ts`. Find the `describe("projects API"` block (or the appropriate integration describe block) and add a new nested describe. Append after the last existing test in the file:

  ```typescript
  describe("POST /api/projects validation", () => {
    let app: ReturnType<typeof express>;
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-val-"));
      initDb(tmpDir);
      const docker = {} as Dockerode;
      app = express();
      app.use(express.json());
      app.use("/api/projects", createProjectsRouter(tmpDir, docker));
    });

    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it("returns 400 when name is missing", async () => {
      const res = await request(app)
        .post("/api/projects")
        .send({ repositoryIds: ["repo-1"] });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Validation failed", details: expect.any(Array) });
    });

    it("returns 400 when name is empty string", async () => {
      const res = await request(app)
        .post("/api/projects")
        .send({ name: "", repositoryIds: ["repo-1"] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation failed");
    });

    it("returns 400 when repositoryIds is missing", async () => {
      const res = await request(app)
        .post("/api/projects")
        .send({ name: "My Project" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation failed");
    });

    it("returns 400 when repositoryIds is empty array", async () => {
      const res = await request(app)
        .post("/api/projects")
        .send({ name: "My Project", repositoryIds: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation failed");
    });

    it("accepts extra fields (TypeBox default passthrough)", async () => {
      // Will fail at business logic (repository not found) not at validation
      const res = await request(app)
        .post("/api/projects")
        .send({ name: "My Project", repositoryIds: ["repo-1"], unknownField: true });
      // Should NOT be 400 validation error
      expect(res.status).not.toBe(400);
    });
  });

  describe("POST /api/projects/:id/tasks validation", () => {
    let app: ReturnType<typeof express>;
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-tasks-"));
      initDb(tmpDir);
      const docker = {} as Dockerode;
      app = express();
      app.use(express.json());
      app.use("/api/projects", createProjectsRouter(tmpDir, docker));
    });

    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it("returns 400 when tasks field is missing", async () => {
      const res = await request(app)
        .post("/api/projects/proj-1/tasks")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation failed");
    });

    it("returns 400 when tasks is empty array", async () => {
      const res = await request(app)
        .post("/api/projects/proj-1/tasks")
        .send({ tasks: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation failed");
    });

    it("returns 400 when a task item is missing repositoryId", async () => {
      const res = await request(app)
        .post("/api/projects/proj-1/tasks")
        .send({ tasks: [{ description: "Do something" }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation failed");
    });

    it("returns 400 when a task item is missing description", async () => {
      const res = await request(app)
        .post("/api/projects/proj-1/tasks")
        .send({ tasks: [{ repositoryId: "repo-1" }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation failed");
    });
  });
  ```

- [ ] If `backend/src/__tests__/repositories.test.ts` does not exist, create it:
  ```typescript
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
  ```

- [ ] Run tests to confirm they fail (validation not yet wired up):
  ```bash
  cd /home/ae/multi-agent-harness/backend && bun run test
  ```

---

## Task 2 — Create `backend/src/api/validate.ts`

- [ ] Create the file `backend/src/api/validate.ts`:
  ```typescript
  import { type TSchema } from "@sinclair/typebox";
  import { Value } from "@sinclair/typebox/value";
  import type { Request, Response, NextFunction } from "express";

  export function validateBody<T extends TSchema>(schema: T) {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (!Value.Check(schema, req.body)) {
        const errors = [...Value.Errors(schema, req.body)].map(e => ({
          path: e.path,
          message: e.message,
        }));
        res.status(400).json({ error: "Validation failed", details: errors });
        return;
      }
      next();
    };
  }
  ```

---

## Task 3 — Add TypeBox schemas and wire validation into `projects.ts`

- [ ] Open `backend/src/api/projects.ts`. Add the following imports at the top of the file (after the existing imports):
  ```typescript
  import { Type } from "@sinclair/typebox";
  import { validateBody } from "./validate.js";
  ```

- [ ] Add the schemas after the imports and before `createProjectsRouter`:
  ```typescript
  const CreateProjectSchema = Type.Object({
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String()),
    source: Type.Optional(Type.Any()),
    repositoryIds: Type.Array(Type.String(), { minItems: 1 }),
    primaryRepositoryId: Type.Optional(Type.String()),
  });

  const UpsertTasksSchema = Type.Object({
    tasks: Type.Array(
      Type.Object({
        id: Type.Optional(Type.String()),
        repositoryId: Type.String({ minLength: 1 }),
        description: Type.String({ minLength: 1 }),
      }),
      { minItems: 1 }
    ),
  });
  ```

- [ ] Wire `validateBody(CreateProjectSchema)` into the `POST /` route. Change:
  ```typescript
  // Create a new project
  router.post("/", (req, res) => {
  ```
  To:
  ```typescript
  // Create a new project
  router.post("/", validateBody(CreateProjectSchema), (req, res) => {
  ```

- [ ] Wire `validateBody(UpsertTasksSchema)` into the `POST /:id/tasks` route. Change:
  ```typescript
  // POST /api/projects/:id/tasks — upsert tasks and dispatch (for planning agent dispatch_tasks tool)
  router.post("/:id/tasks", async (req, res) => {
  ```
  To:
  ```typescript
  // POST /api/projects/:id/tasks — upsert tasks and dispatch (for planning agent dispatch_tasks tool)
  router.post("/:id/tasks", validateBody(UpsertTasksSchema), async (req, res) => {
  ```

- [ ] Run tests:
  ```bash
  cd /home/ae/multi-agent-harness/backend && bun run test
  ```

---

## Task 4 — Add TypeBox schemas and wire validation into `repositories.ts`

- [ ] Open `backend/src/api/repositories.ts`. Add these imports after the existing imports:
  ```typescript
  import { Type } from "@sinclair/typebox";
  import { validateBody } from "./validate.js";
  ```

- [ ] Add the schemas before `createRepositoriesRouter`:
  ```typescript
  const CreateRepositorySchema = Type.Object({
    name: Type.String({ minLength: 1, maxLength: 200 }),
    cloneUrl: Type.String({ minLength: 1 }),
    provider: Type.Union([
      Type.Literal("github"),
      Type.Literal("bitbucket-server"),
    ]),
    providerConfig: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    defaultBranch: Type.Optional(Type.String()),
  });
  ```

- [ ] Wire `validateBody(CreateRepositorySchema)` into the `POST /` route. Change:
  ```typescript
  // Create a new repository
  router.post("/", (req, res) => {
  ```
  To:
  ```typescript
  // Create a new repository
  router.post("/", validateBody(CreateRepositorySchema), (req, res) => {
  ```

- [ ] Run tests:
  ```bash
  cd /home/ae/multi-agent-harness/backend && bun run test
  ```
  All new validation tests should now pass.

---

## Task 5 — Final verification

- [ ] Run the full backend test suite:
  ```bash
  cd /home/ae/multi-agent-harness/backend && bun run test
  ```
  All tests pass.

- [ ] Run TypeScript type check:
  ```bash
  cd /home/ae/multi-agent-harness/backend && bunx tsc --noEmit
  ```
  No type errors.

- [ ] Manually verify the error shape is consistent. A `POST /api/projects` with body `{}` should return:
  ```json
  {
    "error": "Validation failed",
    "details": [
      { "path": "/name", "message": "Expected string" },
      { "path": "/repositoryIds", "message": "Expected array" }
    ]
  }
  ```

- [ ] Confirm files changed:
  - `backend/src/api/validate.ts` — new file with `validateBody` helper
  - `backend/src/api/projects.ts` — two routes now have `validateBody(...)` middleware
  - `backend/src/api/repositories.ts` — one route now has `validateBody(...)` middleware
  - `backend/src/__tests__/projects.test.ts` — two new validation describe blocks
  - `backend/src/__tests__/repositories.test.ts` — new file with repository validation tests
