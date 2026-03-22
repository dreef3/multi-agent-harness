import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDb, getDb } from "../store/db.js";
import os from "os";
import path from "path";
import fs from "fs";
import { insertProject, getProject, listProjects, updateProject, listProjectsAwaitingLgtm } from "../store/projects.js";
import { appendMessage, listMessages, listMessagesSince } from "../store/messages.js";
import { parsePlan } from "../agents/planParser.js";
import type { Project, Plan } from "../models/types.js";

describe("projects store", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-proj-"));
    initDb(tmpDir);
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const baseProject: Project = {
    id: "proj-1", name: "Test Project", status: "brainstorming",
    source: { type: "freeform", freeformDescription: "Test description" },
    repositoryIds: ["repo-1", "repo-2"], masterSessionPath: "",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };

  it("inserts and retrieves a project", () => {
    insertProject(baseProject);
    const found = getProject("proj-1");
    expect(found).toMatchObject({ id: "proj-1", name: "Test Project" });
    expect(found?.source.type).toBe("freeform");
    expect(found?.repositoryIds).toEqual(["repo-1", "repo-2"]);
  });

  it("returns null for a missing id", () => {
    expect(getProject("nonexistent")).toBeNull();
  });

  it("lists all projects ordered by createdAt desc", () => {
    insertProject(baseProject);
    const proj2 = { ...baseProject, id: "proj-2", name: "Second Project", createdAt: new Date(Date.now() + 1000).toISOString() };
    insertProject(proj2);
    const list = listProjects();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe("proj-2");
    expect(list[1].id).toBe("proj-1");
  });

  it("updates name and status", () => {
    insertProject(baseProject);
    updateProject("proj-1", { name: "Renamed Project", status: "planning" });
    const found = getProject("proj-1");
    expect(found?.name).toBe("Renamed Project");
    expect(found?.status).toBe("planning");
  });

  it("updates plan", () => {
    insertProject(baseProject);
    const plan: Plan = {
      id: "plan-1", projectId: "proj-1", content: "Plan content",
      tasks: [],
    };
    updateProject("proj-1", { plan });
    const found = getProject("proj-1");
    expect(found?.plan).toEqual(plan);
  });

  it("updates masterSessionPath", () => {
    insertProject(baseProject);
    updateProject("proj-1", { masterSessionPath: "/path/to/session" });
    expect(getProject("proj-1")?.masterSessionPath).toBe("/path/to/session");
  });

  it("throws when updating a nonexistent project", () => {
    expect(() => updateProject("missing", { name: "x" })).toThrow("Project not found");
  });

  it("stores and retrieves primaryRepositoryId, planningBranch, planningPr", () => {
    const proj: Project = {
      ...baseProject,
      id: "proj-pr",
      primaryRepositoryId: "repo-1",
      planningBranch: "harness/add-auth-a3b2c",
      planningPr: { number: 7, url: "https://github.com/org/repo/pull/7" },
    };
    insertProject(proj);
    const found = getProject("proj-pr");
    expect(found?.primaryRepositoryId).toBe("repo-1");
    expect(found?.planningBranch).toBe("harness/add-auth-a3b2c");
    expect(found?.planningPr).toEqual({ number: 7, url: "https://github.com/org/repo/pull/7" });
  });

  it("stores planningPr with approval timestamps", () => {
    const proj: Project = {
      ...baseProject,
      id: "proj-pr2",
      primaryRepositoryId: "repo-1",
      planningPr: {
        number: 8,
        url: "https://github.com/org/repo/pull/8",
        specApprovedAt: "2026-03-22T10:00:00.000Z",
        planApprovedAt: "2026-03-22T12:00:00.000Z",
      },
    };
    insertProject(proj);
    const found = getProject("proj-pr2");
    expect(found?.planningPr?.specApprovedAt).toBe("2026-03-22T10:00:00.000Z");
    expect(found?.planningPr?.planApprovedAt).toBe("2026-03-22T12:00:00.000Z");
  });

  it("listProjectsAwaitingLgtm returns only projects in awaiting states", () => {
    insertProject({ ...baseProject, id: "p-brainstorm", status: "brainstorming" });
    insertProject({ ...baseProject, id: "p-spec", status: "awaiting_spec_approval",
      primaryRepositoryId: "repo-1" });
    insertProject({ ...baseProject, id: "p-plan", status: "awaiting_plan_approval",
      primaryRepositoryId: "repo-1" });
    insertProject({ ...baseProject, id: "p-exec", status: "executing" });
    const waiting = listProjectsAwaitingLgtm();
    expect(waiting.map(p => p.id).sort()).toEqual(["p-plan", "p-spec"]);
  });
});

describe("messages store", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-msg-"));
    initDb(tmpDir);
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("appends messages with auto-incrementing seq_id", () => {
    const msg1 = appendMessage("proj-1", "user", "Hello");
    expect(msg1.seqId).toBe(1);
    expect(msg1.role).toBe("user");
    expect(msg1.content).toBe("Hello");

    const msg2 = appendMessage("proj-1", "assistant", "Hi there");
    expect(msg2.seqId).toBe(2);
    expect(msg2.role).toBe("assistant");

    const msg3 = appendMessage("proj-1", "user", "Another message");
    expect(msg3.seqId).toBe(3);
  });

  it("lists messages for a project in order", () => {
    appendMessage("proj-1", "user", "First");
    appendMessage("proj-1", "assistant", "Second");
    appendMessage("proj-1", "user", "Third");

    const list = listMessages("proj-1");
    expect(list).toHaveLength(3);
    expect(list.map(m => m.content)).toEqual(["First", "Second", "Third"]);
    expect(list.map(m => m.seqId)).toEqual([1, 2, 3]);
  });

  it("returns empty array for project with no messages", () => {
    expect(listMessages("proj-1")).toEqual([]);
  });

  it("lists messages since a given seq_id", () => {
    appendMessage("proj-1", "user", "First");
    appendMessage("proj-1", "assistant", "Second");
    appendMessage("proj-1", "user", "Third");
    appendMessage("proj-1", "assistant", "Fourth");

    const list = listMessagesSince("proj-1", 2);
    expect(list).toHaveLength(2);
    expect(list.map(m => m.content)).toEqual(["Third", "Fourth"]);
  });

  it("isolates messages by project_id", () => {
    appendMessage("proj-1", "user", "Project 1 message");
    appendMessage("proj-2", "user", "Project 2 message");

    expect(listMessages("proj-1")).toHaveLength(1);
    expect(listMessages("proj-1")[0].content).toBe("Project 1 message");
    expect(listMessages("proj-2")).toHaveLength(1);
    expect(listMessages("proj-2")[0].content).toBe("Project 2 message");
  });
});

describe("planParser", () => {
  it("parses a markdown plan into tasks", () => {
    const markdown = `
### Task 1: Update authentication

**Repository:** my-service

**Description:**
Implement OAuth2 authentication flow

### Task 2: Add logging

**Repository:** api-gateway

**Description:**
Add structured logging middleware
`;

    const repositories = [
      { id: "repo-1", name: "my-service" },
      { id: "repo-2", name: "api-gateway" },
    ];

    const tasks = parsePlan("proj-1", markdown, repositories);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].repositoryId).toBe("repo-1");
    expect(tasks[0].description).toContain("OAuth2");
    expect(tasks[0].status).toBe("pending");
    expect(tasks[1].repositoryId).toBe("repo-2");
    expect(tasks[1].description).toContain("logging");
  });

  it("skips tasks with unknown repositories", () => {
    const markdown = `
### Task 1: Update authentication

**Repository:** unknown-service

**Description:**
Some description

### Task 2: Add logging

**Repository:** my-service

**Description:**
Add structured logging
`;

    const repositories = [{ id: "repo-1", name: "my-service" }];
    const tasks = parsePlan("proj-1", markdown, repositories);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].repositoryId).toBe("repo-1");
  });

  it("skips tasks without repository header", () => {
    const markdown = `
### Task 1: Update authentication

**Description:**
Some description without repository

### Task 2: Add logging

**Repository:** my-service

**Description:**
Add structured logging
`;

    const repositories = [{ id: "repo-1", name: "my-service" }];
    const tasks = parsePlan("proj-1", markdown, repositories);
    expect(tasks).toHaveLength(1);
  });

  it("handles case-insensitive repository matching", () => {
    const markdown = `
### Task 1: Update authentication

**Repository:** My-Service

**Description:**
Implement OAuth2
`;

    const repositories = [{ id: "repo-1", name: "my-service" }];
    const tasks = parsePlan("proj-1", markdown, repositories);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].repositoryId).toBe("repo-1");
  });

  it("returns empty array when no tasks match", () => {
    const markdown = "No tasks here";
    const repositories = [{ id: "repo-1", name: "my-service" }];
    const tasks = parsePlan("proj-1", markdown, repositories);
    expect(tasks).toEqual([]);
  });

  it("uses entire block as description when no description header", () => {
    const markdown = `
### Task 1: Update authentication

**Repository:** my-service

Some content without description header
`;

    const repositories = [{ id: "repo-1", name: "my-service" }];
    const tasks = parsePlan("proj-1", markdown, repositories);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toContain("Some content");
  });
});
