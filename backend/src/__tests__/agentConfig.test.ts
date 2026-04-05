import { describe, it, expect, beforeAll } from "vitest";
import { initDb } from "../store/db.js";
import { insertProject, getProject, updateProject } from "../store/projects.js";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";

describe("agent config on projects", () => {
  beforeAll(async () => {
    const dir = mkdtempSync(`${tmpdir()}/harness-test-`);
    await initDb(dir);
  });

  it("stores and retrieves per-project agent config", async () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await insertProject({
      id,
      name: "test",
      status: "brainstorming",
      source: { type: "freeform", freeformDescription: "test" },
      repositoryIds: [],
      masterSessionPath: "",
      createdAt: now,
      updatedAt: now,
    });

    await updateProject(id, {
      planningAgent: { type: "gemini", model: "gemini-2.5-pro" },
      implementationAgent: { type: "copilot", model: "gpt-5-mini" },
    });

    const project = await getProject(id);
    expect(project?.planningAgent).toEqual({ type: "gemini", model: "gemini-2.5-pro" });
    expect(project?.implementationAgent).toEqual({ type: "copilot", model: "gpt-5-mini" });
  });

  it("returns undefined agent config when not set", async () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await insertProject({
      id,
      name: "test-no-config",
      status: "brainstorming",
      source: { type: "freeform", freeformDescription: "test" },
      repositoryIds: [],
      masterSessionPath: "",
      createdAt: now,
      updatedAt: now,
    });

    const project = await getProject(id);
    expect(project?.planningAgent).toBeUndefined();
    expect(project?.implementationAgent).toBeUndefined();
  });
});
