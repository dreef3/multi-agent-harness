/**
 * Unit tests for buildMasterAgentContext (the system-prompt prefix injected into
 * every planning-agent turn).
 *
 * These tests verify the two bugs are fixed:
 *   1. The context no longer references superpowers:executing-plans (an implementation
 *      skill that caused the agent to write code instead of planning).
 *   2. The context explicitly instructs the agent to use write_planning_document.
 */
import { describe, test, expect } from "vitest";
import { buildMasterAgentContextForTest } from "../api/websocket.js";
import type { Project } from "../models/types.js";
import type { Repository } from "../models/types.js";

const fakeProject: Project = {
  id: "proj-test-1",
  name: "Test Project",
  source: { type: "freeform", freeformDescription: "a test project about dark mode" },
  repositoryIds: ["repo-1"],
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as Project;

const fakeRepos: Repository[] = [
  {
    id: "repo-1",
    name: "my-repo",
    cloneUrl: "https://github.com/org/my-repo",
    defaultBranch: "main",
    provider: "github",
  } as unknown as Repository,
];

describe("buildMasterAgentContext", () => {
  test("does NOT reference superpowers:executing-plans", () => {
    const ctx = buildMasterAgentContextForTest(fakeProject, fakeRepos);
    expect(ctx).not.toContain("executing-plans");
  });

  test("does NOT claim agent has no local file access", () => {
    const ctx = buildMasterAgentContextForTest(fakeProject, fakeRepos);
    expect(ctx).not.toContain("NO local direct file access");
  });

  test("mentions write_planning_document", () => {
    const ctx = buildMasterAgentContextForTest(fakeProject, fakeRepos);
    expect(ctx).toContain("write_planning_document");
  });

  test("mentions write_planning_document for both spec and plan types", () => {
    const ctx = buildMasterAgentContextForTest(fakeProject, fakeRepos);
    expect(ctx).toContain('"spec"');
    expect(ctx).toContain('"plan"');
  });

  test("includes the project description", () => {
    const ctx = buildMasterAgentContextForTest(fakeProject, fakeRepos);
    expect(ctx).toContain("a test project about dark mode");
  });

  test("includes the repository clone URL", () => {
    const ctx = buildMasterAgentContextForTest(fakeProject, fakeRepos);
    expect(ctx).toContain("https://github.com/org/my-repo");
  });

  test("returns placeholder when no repos configured", () => {
    const ctx = buildMasterAgentContextForTest(fakeProject, []);
    expect(ctx).toContain("no repositories configured");
  });

  test("includes JIRA ticket for jira source type", () => {
    const jiraProject: Project = {
      ...fakeProject,
      source: { type: "jira", jiraTickets: ["PROJ-123"] },
    } as unknown as Project;
    const ctx = buildMasterAgentContextForTest(jiraProject, []);
    expect(ctx).toContain("PROJ-123");
  });

  test("includes github issue refs for github source type", () => {
    const ghProject: Project = {
      ...fakeProject,
      source: { type: "github", githubIssues: ["org/repo#42"] },
    } as unknown as Project;
    const ctx = buildMasterAgentContextForTest(ghProject, []);
    expect(ctx).toContain("org/repo#42");
  });
});
