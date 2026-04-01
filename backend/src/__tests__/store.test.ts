import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDb, getDb } from "../store/db.js";
import os from "os";
import path from "path";
import fs from "fs";
import { insertRepository, getRepository, listRepositories, updateRepository, deleteRepository } from "../store/repositories.js";
import type { Repository, Project } from "../models/types.js";
import { insertAgentSession, getAgentSession, listAgentSessions, updateAgentSession } from "../store/agents.js";
import type { AgentSession } from "../models/types.js";
import { insertProject, getProject, updateTaskInPlan } from "../store/projects.js";

function makeProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: "proj-1",
    name: "Test Project",
    status: "executing" as const,
    source: { type: "freeform" as const, freeformDescription: "test" },
    repositoryIds: ["repo-1"],
    masterSessionPath: "",
    createdAt: now,
    updatedAt: now,
    plan: {
      id: "plan-1",
      projectId: "proj-1",
      content: "# Plan",
      tasks: [
        { id: "task-1", repositoryId: "repo-1", description: "Do A", status: "pending" as const },
        { id: "task-2", repositoryId: "repo-1", description: "Do B", status: "pending" as const },
      ],
    },
    ...overrides,
  };
}

describe("db", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes and creates all required tables", async () => {
    await initDb(tmpDir);
    const db = getDb();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("repositories");
    expect(names).toContain("agent_sessions");
  });

  it("is idempotent — running initDb twice does not throw", async () => {
    await initDb(tmpDir);
    await expect(initDb(tmpDir)).resolves.not.toThrow();
  });

  it("creates projects and messages tables", async () => {
    await initDb(tmpDir);
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("projects");
    expect(names).toContain("messages");
  });

  it("creates pull_requests and review_comments tables", async () => {
    await initDb(tmpDir);
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("pull_requests");
    expect(tables.map((t) => t.name)).toContain("review_comments");
  });
});

describe("repositories store", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-repo-"));
    await initDb(tmpDir);
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const repo: Repository = {
    id: "repo-1", name: "my-service", cloneUrl: "https://github.com/org/my-service.git",
    provider: "github", providerConfig: { owner: "org", repo: "my-service" },
    defaultBranch: "main", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };

  it("inserts and retrieves a repository", async () => {
    await insertRepository(repo);
    const found = await getRepository("repo-1");
    expect(found).toMatchObject({ id: "repo-1", name: "my-service" });
    expect(found?.providerConfig).toEqual({ owner: "org", repo: "my-service" });
  });
  it("returns null for a missing id", async () => { expect(await getRepository("nonexistent")).toBeNull(); });
  it("lists all repositories ordered by createdAt desc", async () => {
    await insertRepository(repo);
    const list = await listRepositories();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("repo-1");
  });
  it("updates name", async () => {
    await insertRepository(repo);
    await updateRepository("repo-1", { name: "renamed-service" });
    expect((await getRepository("repo-1"))?.name).toBe("renamed-service");
  });
  it("deletes a repository", async () => {
    await insertRepository(repo);
    await deleteRepository("repo-1");
    expect(await getRepository("repo-1")).toBeNull();
  });
  it("throws when updating a nonexistent repository", async () => {
    await expect(updateRepository("missing", { name: "x" })).rejects.toThrow("Repository not found");
  });
});

describe("agent sessions store", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sess-"));
    await initDb(tmpDir);
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const session: AgentSession = {
    id: "session-1", projectId: "project-1", type: "sub", repositoryId: "repo-1",
    taskId: "task-1", status: "starting", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };

  it("inserts and retrieves a session", async () => {
    await insertAgentSession(session);
    const found = await getAgentSession("session-1");
    expect(found).toMatchObject({ id: "session-1", status: "starting" });
    expect(found?.repositoryId).toBe("repo-1");
  });
  it("returns null for a missing id", async () => { expect(await getAgentSession("missing")).toBeNull(); });
  it("lists sessions by projectId", async () => {
    await insertAgentSession(session);
    const list = await listAgentSessions("project-1");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("session-1");
  });
  it("updates status and containerId", async () => {
    await insertAgentSession(session);
    await updateAgentSession("session-1", { status: "running", containerId: "container-abc" });
    const found = await getAgentSession("session-1");
    expect(found?.status).toBe("running");
    expect(found?.containerId).toBe("container-abc");
  });
  it("throws when updating a nonexistent session", async () => {
    await expect(updateAgentSession("missing", { status: "failed" })).rejects.toThrow("AgentSession not found");
  });
});

describe("updateTaskInPlan", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
    await initDb(tmpDir);
    await insertProject(makeProject());
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("updates the target task without touching sibling tasks", async () => {
    await updateTaskInPlan("proj-1", "task-1", { status: "executing", retryCount: 0 });
    const project = (await getProject("proj-1"))!;
    const t1 = project.plan!.tasks.find(t => t.id === "task-1")!;
    const t2 = project.plan!.tasks.find(t => t.id === "task-2")!;
    expect(t1.status).toBe("executing");
    expect(t1.retryCount).toBe(0);
    expect(t2.status).toBe("pending");
  });

  it("does nothing when project has no plan", async () => {
    const proj2: Project = { ...makeProject(), id: "proj-2", plan: undefined };
    await insertProject(proj2);
    await expect(updateTaskInPlan("proj-2", "task-1", { status: "completed" })).resolves.not.toThrow();
  });

  it("does nothing when taskId is not found", async () => {
    await expect(updateTaskInPlan("proj-1", "nonexistent", { status: "completed" })).resolves.not.toThrow();
    const project = (await getProject("proj-1"))!;
    expect(project.plan!.tasks[0].status).toBe("pending");
  });

  it("does nothing when project does not exist", async () => {
    await expect(updateTaskInPlan("nonexistent-project", "task-1", { status: "completed" })).resolves.not.toThrow();
  });
});

describe("agent_events table", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
    await initDb(tmpDir);
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("table exists after migration", () => {
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_events'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("agent_events");
  });

  it("index exists after migration", () => {
    const indexes = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_events_session'")
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
  });
});
