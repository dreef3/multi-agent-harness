import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDb } from "../store/db.js";
import os from "os";
import path from "path";
import fs from "fs";
import {
  insertPullRequest,
  getPullRequest,
  listPullRequestsByProject,
  updatePullRequest,
  upsertReviewComment,
  getPendingComments,
  markCommentsStatus,
  listAllPendingComments,
} from "../store/pullRequests.js";
import type { PullRequest, ReviewComment } from "../models/types.js";

describe("pullRequests store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pr-"));
    initDb(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const pr: PullRequest = {
    id: "pr-1",
    projectId: "project-1",
    repositoryId: "repo-1",
    agentSessionId: "session-1",
    provider: "github",
    externalId: "123",
    url: "https://github.com/org/repo/pull/123",
    branch: "feature/test",
    status: "open",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("inserts and retrieves a pull request", () => {
    insertPullRequest(pr);
    const found = getPullRequest("pr-1");
    expect(found).toMatchObject({ id: "pr-1", status: "open" });
    expect(found?.url).toBe("https://github.com/org/repo/pull/123");
  });

  it("returns null for a missing id", () => {
    expect(getPullRequest("nonexistent")).toBeNull();
  });

  it("lists pull requests by projectId", () => {
    insertPullRequest(pr);
    const list = listPullRequestsByProject("project-1");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("pr-1");
  });

  it("returns empty list for project with no pull requests", () => {
    const list = listPullRequestsByProject("project-no-prs");
    expect(list).toHaveLength(0);
  });

  it("updates status and branch", () => {
    insertPullRequest(pr);
    updatePullRequest("pr-1", { status: "merged", branch: "feature/test-renamed" });
    const found = getPullRequest("pr-1");
    expect(found?.status).toBe("merged");
    expect(found?.branch).toBe("feature/test-renamed");
  });

  it("throws when updating a nonexistent pull request", () => {
    expect(() => updatePullRequest("missing", { status: "merged" })).toThrow("PullRequest not found");
  });
});

describe("reviewComments store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-comment-"));
    initDb(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const comment: ReviewComment = {
    id: "comment-1",
    pullRequestId: "pr-1",
    externalId: "gh-comment-1",
    author: "reviewer",
    body: "This needs work",
    filePath: "src/file.ts",
    lineNumber: 42,
    status: "pending",
    receivedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("inserts and retrieves a review comment", () => {
    upsertReviewComment(comment);
    const pending = getPendingComments("pr-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: "comment-1", body: "This needs work" });
    expect(pending[0].filePath).toBe("src/file.ts");
    expect(pending[0].lineNumber).toBe(42);
  });

  it("returns empty list for PR with no pending comments", () => {
    const pending = getPendingComments("pr-no-comments");
    expect(pending).toHaveLength(0);
  });

  it("returns true when inserting a new comment", () => {
    const isNew = upsertReviewComment(comment);
    expect(isNew).toBe(true);
  });

  it("returns false when upserting an existing comment (same externalId)", () => {
    upsertReviewComment(comment);
    const isNew = upsertReviewComment({ ...comment, body: "Updated body" });
    expect(isNew).toBe(false);
  });

  it("updates existing comment by externalId", () => {
    upsertReviewComment(comment);
    const updatedComment: ReviewComment = {
      ...comment,
      body: "Updated body",
      status: "batched",
    };
    upsertReviewComment(updatedComment);
    const pending = getPendingComments("pr-1");
    expect(pending).toHaveLength(0);
    const allPending = listAllPendingComments();
    expect(allPending).toHaveLength(0);
  });

  it("marks comments status", () => {
    upsertReviewComment(comment);
    markCommentsStatus("pr-1", ["comment-1"], "fixing");
    const pending = getPendingComments("pr-1");
    expect(pending).toHaveLength(0);
  });

  it("lists all pending comments across all PRs", () => {
    upsertReviewComment(comment);
    const comment2: ReviewComment = {
      id: "comment-2",
      pullRequestId: "pr-2",
      externalId: "gh-comment-2",
      author: "reviewer2",
      body: "Another comment",
      status: "pending",
      receivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    upsertReviewComment(comment2);
    const allPending = listAllPendingComments();
    expect(allPending).toHaveLength(2);
  });

  it("filters pending comments correctly", () => {
    upsertReviewComment(comment);
    const fixedComment: ReviewComment = {
      id: "comment-2",
      pullRequestId: "pr-1",
      externalId: "gh-comment-2",
      author: "reviewer2",
      body: "Already fixed",
      status: "fixed",
      receivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    upsertReviewComment(fixedComment);
    const pending = getPendingComments("pr-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("comment-1");
  });
});
