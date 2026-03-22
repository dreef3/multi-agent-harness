import { describe, it, expect } from "vitest";
import { slugify, buildPlanningBranch, buildPlanningFilePath } from "../agents/planningTool.js";
import type { Project } from "../models/types.js";

const baseProject: Project = {
  id: "a3b2c-uuid-goes-here", name: "Add User Auth",
  status: "spec_in_progress",
  source: { type: "freeform", freeformDescription: "" },
  repositoryIds: ["repo-1"],
  primaryRepositoryId: "repo-1",
  masterSessionPath: "",
  createdAt: "2026-03-22T00:00:00.000Z",
  updatedAt: "2026-03-22T00:00:00.000Z",
};

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Add User Auth")).toBe("add-user-auth");
  });

  it("strips non-alphanumeric characters", () => {
    expect(slugify("My Feature! (v2)")).toBe("my-feature-v2");
  });

  it("collapses consecutive hyphens", () => {
    expect(slugify("foo  --  bar")).toBe("foo-bar");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("  hello world  ")).toBe("hello-world");
  });

  it("truncates to 50 characters", () => {
    const long = "a".repeat(60);
    expect(slugify(long)).toHaveLength(50);
  });

  it("returns 'project' for an empty/whitespace name", () => {
    expect(slugify("")).toBe("project");
    expect(slugify("   ")).toBe("project");
    expect(slugify("!!!")).toBe("project");
  });
});

describe("buildPlanningBranch", () => {
  it("builds harness/{slug}-{suffix} for freeform projects", () => {
    // suffix = first 5 chars of id, lowercased, non-alphanumeric stripped
    const branch = buildPlanningBranch({ ...baseProject, id: "a3b2c-rest-of-uuid" });
    expect(branch).toBe("harness/add-user-auth-a3b2c");
  });

  it("prefixes with issue-{n}- for GitHub issue source", () => {
    const proj: Project = {
      ...baseProject,
      id: "f9e1a-uuid",
      source: { type: "github", githubIssues: ["org/repo#42"] },
    };
    const branch = buildPlanningBranch(proj);
    expect(branch).toBe("harness/issue-42-add-user-auth-f9e1a");
  });

  it("prefixes with {TICKET}- for jira source", () => {
    const proj: Project = {
      ...baseProject,
      id: "c4d2e-uuid",
      source: { type: "jira", jiraTickets: ["PROJ-123"] },
    };
    const branch = buildPlanningBranch(proj);
    expect(branch).toBe("harness/PROJ-123-add-user-auth-c4d2e");
  });

  it("truncates slug to 30 characters", () => {
    const proj: Project = {
      ...baseProject,
      id: "abc12-uuid",
      name: "This is a very long project name that exceeds thirty characters easily",
    };
    const branch = buildPlanningBranch(proj);
    // slug capped at 30, branch = harness/{slug30}-{5charId}
    const parts = branch.split("/")[1].split("-");
    const suffix = parts[parts.length - 1];
    expect(suffix).toBe("abc12");
    const slugPart = parts.slice(0, -1).join("-");
    expect(slugPart.length).toBeLessThanOrEqual(30);
  });
});

describe("buildPlanningFilePath", () => {
  it("returns correct spec path", () => {
    const path = buildPlanningFilePath("spec", "2026-03-22", "add-user-auth");
    expect(path).toBe("docs/superpowers/specs/2026-03-22-add-user-auth-design.md");
  });

  it("returns correct plan path", () => {
    const path = buildPlanningFilePath("plan", "2026-03-22", "add-user-auth");
    expect(path).toBe("docs/superpowers/plans/2026-03-22-add-user-auth-plan.md");
  });
});
