import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PullRequest, Repository } from "../models/types.js";

// ── Shared mocks ─────────────────────────────────────────────────────────────

const mockGetPullRequest = vi.fn();
const mockGetComments = vi.fn();
const mockUpdatePullRequest = vi.fn();
const mockUpsertReviewComment = vi.fn();
const mockGetRepository = vi.fn();
const mockGetDebounceEngine = vi.fn().mockReturnValue(null);

vi.mock("../connectors/types.js", () => ({
  getConnector: vi.fn().mockReturnValue({
    getPullRequest: mockGetPullRequest,
    getComments: mockGetComments,
  }),
}));

vi.mock("../store/repositories.js", () => ({
  getRepository: mockGetRepository,
}));

vi.mock("../store/pullRequests.js", () => ({
  upsertReviewComment: mockUpsertReviewComment,
  listPullRequestsByProject: vi.fn(),
  updatePullRequest: mockUpdatePullRequest,
}));

vi.mock("../api/webhooks.js", () => ({
  getDebounceEngine: mockGetDebounceEngine,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const repo: Repository = {
  id: "repo-1",
  name: "my-repo",
  provider: "github",
  providerConfig: { owner: "org", repo: "my-repo" },
  cloneUrl: "https://github.com/org/my-repo.git",
  defaultBranch: "main",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const pr: PullRequest = {
  id: "pr-1",
  projectId: "project-1",
  repositoryId: "repo-1",
  agentSessionId: "session-1",
  provider: "github",
  externalId: "42",
  url: "https://github.com/org/my-repo/pull/42",
  branch: "feature/impl",
  status: "open",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("detectLgtm", () => {
  it("detects standalone LGTM (case-insensitive)", async () => {
    const { detectLgtm } = await import("../polling.js");
    expect(detectLgtm("LGTM")).toBe(true);
    expect(detectLgtm("lgtm")).toBe(true);
    expect(detectLgtm("Looks good! LGTM")).toBe(true);
    expect(detectLgtm("LGTM!")).toBe(true);
    expect(detectLgtm("Great work")).toBe(false);
    expect(detectLgtm("LGTMs")).toBe(false); // not a standalone word
  });
});

describe("pollPullRequest — PR status sync (restart ghost-push bug)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRepository.mockReturnValue(repo);
    mockGetDebounceEngine.mockReturnValue(null);
  });

  it("skips comment poll and updates local status when remote PR is merged", async () => {
    mockGetPullRequest.mockResolvedValue({ status: "merged", url: pr.url });

    const { pollPullRequest } = await import("../polling.js");
    const newComments = await pollPullRequest({} as never, pr);

    expect(newComments).toBe(0);
    expect(mockUpdatePullRequest).toHaveBeenCalledWith("pr-1", { status: "merged" });
    expect(mockGetComments).not.toHaveBeenCalled();
    expect(mockUpsertReviewComment).not.toHaveBeenCalled();
  });

  it("skips comment poll and updates local status when remote PR is declined", async () => {
    mockGetPullRequest.mockResolvedValue({ status: "declined", url: pr.url });

    const { pollPullRequest } = await import("../polling.js");
    const newComments = await pollPullRequest({} as never, pr);

    expect(newComments).toBe(0);
    expect(mockUpdatePullRequest).toHaveBeenCalledWith("pr-1", { status: "declined" });
    expect(mockGetComments).not.toHaveBeenCalled();
  });

  it("counts only new comments, not already-seen ones after restart (no since)", async () => {
    // Remote PR is still open
    mockGetPullRequest.mockResolvedValue({ status: "open", url: pr.url });
    // Connector returns two historical comments (fetched because since=undefined on restart)
    mockGetComments.mockResolvedValue([
      { id: "gh-c1", author: "alice", body: "LGTM", createdAt: "2024-01-01T10:00:00Z" },
      { id: "gh-c2", author: "bob", body: "Fix line 5", createdAt: "2024-01-01T11:00:00Z" },
    ]);
    // gh-c1 is already in DB (upsert returns false), gh-c2 is new (returns true)
    mockUpsertReviewComment
      .mockReturnValueOnce(false)  // gh-c1 already existed
      .mockReturnValueOnce(true);  // gh-c2 is new

    const { pollPullRequest } = await import("../polling.js");
    const newComments = await pollPullRequest({} as never, pr);

    expect(newComments).toBe(1); // only gh-c2 counted
    expect(mockGetDebounceEngine).toHaveBeenCalled();
  });

  it("returns 0 new comments when all fetched comments already existed in DB", async () => {
    mockGetPullRequest.mockResolvedValue({ status: "open", url: pr.url });
    mockGetComments.mockResolvedValue([
      { id: "gh-c1", author: "alice", body: "old comment", createdAt: "2024-01-01T10:00:00Z" },
    ]);
    // Comment already in DB — upsert returns false
    mockUpsertReviewComment.mockReturnValue(false);

    const { pollPullRequest } = await import("../polling.js");
    const newComments = await pollPullRequest({} as never, pr);

    expect(newComments).toBe(0);
    // Debounce engine must NOT be triggered for already-seen comments
    expect(mockGetDebounceEngine).not.toHaveBeenCalled();
  });
});
