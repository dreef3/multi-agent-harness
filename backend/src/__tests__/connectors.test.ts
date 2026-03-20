import { describe, it, expect, beforeEach, vi } from "vitest";
import { GitHubConnector } from "../connectors/github.js";
import type { Repository } from "../models/types.js";
import { ConnectorError } from "../connectors/types.js";

const mockCreateRef = vi.fn();
const mockGetRef = vi.fn();
const mockCreatePR = vi.fn();
const mockGetPR = vi.fn();
const mockListReviewComments = vi.fn();
const mockListIssueComments = vi.fn();
const mockCreateComment = vi.fn();

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    git: {
      getRef: mockGetRef,
      createRef: mockCreateRef,
    },
    pulls: {
      create: mockCreatePR,
      get: mockGetPR,
      listReviewComments: mockListReviewComments,
    },
    issues: {
      listComments: mockListIssueComments,
      createComment: mockCreateComment,
    },
  })),
}));

describe("GitHubConnector", () => {
  let connector: GitHubConnector;
  const repo: Repository = {
    id: "repo-1",
    name: "test-repo",
    cloneUrl: "https://github.com/test-org/test-repo.git",
    provider: "github",
    providerConfig: { owner: "test-org", repo: "test-repo" },
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    connector = new GitHubConnector();
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = "test-token";
  });

  describe("createBranch", () => {
    it("creates a branch from the specified ref", async () => {
      mockGetRef.mockResolvedValue({
        data: { object: { sha: "abc123" } },
      });
      mockCreateRef.mockResolvedValue({ data: {} });

      await connector.createBranch(repo, "feature-branch", "main");

      expect(mockGetRef).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        ref: "heads/main",
      });
      expect(mockCreateRef).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        ref: "refs/heads/feature-branch",
        sha: "abc123",
      });
    });

    it("throws ConnectorError on failure", async () => {
      mockGetRef.mockRejectedValue(new Error("Ref not found"));
      await expect(connector.createBranch(repo, "feature-branch", "main")).rejects.toThrow(ConnectorError);
    });
  });

  describe("createPullRequest", () => {
    it("creates a pull request and returns result", async () => {
      mockCreatePR.mockResolvedValue({
        data: {
          number: 123,
          html_url: "https://github.com/test-org/test-repo/pull/123",
        },
      });

      const result = await connector.createPullRequest(repo, {
        title: "Test PR",
        description: "Test description",
        headBranch: "feature-branch",
        baseBranch: "main",
      });

      expect(result).toEqual({
        id: "123",
        url: "https://github.com/test-org/test-repo/pull/123",
      });
    });

    it("throws ConnectorError on failure", async () => {
      mockCreatePR.mockRejectedValue(new Error("Validation failed"));
      await expect(
        connector.createPullRequest(repo, {
          title: "Test PR",
          description: "Test description",
          headBranch: "feature-branch",
          baseBranch: "main",
        })
      ).rejects.toThrow(ConnectorError);
    });
  });

  describe("getPullRequest", () => {
    it("returns open PR info", async () => {
      mockGetPR.mockResolvedValue({
        data: {
          number: 123,
          state: "open",
          merged: false,
          html_url: "https://github.com/test-org/test-repo/pull/123",
        },
      });

      const result = await connector.getPullRequest(repo, "123");
      expect(result).toEqual({
        status: "open",
        url: "https://github.com/test-org/test-repo/pull/123",
      });
    });

    it("returns merged PR info", async () => {
      mockGetPR.mockResolvedValue({
        data: {
          number: 123,
          state: "closed",
          merged: true,
          html_url: "https://github.com/test-org/test-repo/pull/123",
        },
      });

      const result = await connector.getPullRequest(repo, "123");
      expect(result).toEqual({
        status: "merged",
        url: "https://github.com/test-org/test-repo/pull/123",
      });
    });

    it("returns declined PR info for closed but not merged", async () => {
      mockGetPR.mockResolvedValue({
        data: {
          number: 123,
          state: "closed",
          merged: false,
          html_url: "https://github.com/test-org/test-repo/pull/123",
        },
      });

      const result = await connector.getPullRequest(repo, "123");
      expect(result).toEqual({
        status: "declined",
        url: "https://github.com/test-org/test-repo/pull/123",
      });
    });
  });

  describe("getComments", () => {
    it("returns review and issue comments", async () => {
      mockListReviewComments.mockResolvedValue({
        data: [
          {
            id: 1,
            user: { login: "reviewer1" },
            body: "Review comment",
            path: "src/file.ts",
            line: 42,
            created_at: "2024-01-01T00:00:00Z",
          },
        ],
      });
      mockListIssueComments.mockResolvedValue({
        data: [
          {
            id: 2,
            user: { login: "reviewer2" },
            body: "Issue comment",
            created_at: "2024-01-02T00:00:00Z",
          },
        ],
      });

      const comments = await connector.getComments(repo, "123");

      expect(comments).toHaveLength(2);
      expect(comments[0]).toMatchObject({
        id: "1",
        author: "reviewer1",
        body: "Review comment",
        filePath: "src/file.ts",
        lineNumber: 42,
      });
      expect(comments[1]).toMatchObject({
        id: "2",
        author: "reviewer2",
        body: "Issue comment",
      });
    });

    it("filters comments by since timestamp", async () => {
      mockListReviewComments.mockResolvedValue({
        data: [
          {
            id: 1,
            user: { login: "reviewer1" },
            body: "Old comment",
            created_at: "2024-01-01T00:00:00Z",
          },
          {
            id: 2,
            user: { login: "reviewer2" },
            body: "New comment",
            created_at: "2024-01-03T00:00:00Z",
          },
        ],
      });
      mockListIssueComments.mockResolvedValue({ data: [] });

      const comments = await connector.getComments(repo, "123", "2024-01-02T00:00:00Z");

      expect(comments).toHaveLength(1);
      expect(comments[0].id).toBe("2");
    });

    it("sorts comments by createdAt", async () => {
      mockListReviewComments.mockResolvedValue({
        data: [
          {
            id: 1,
            user: { login: "reviewer1" },
            body: "Second",
            created_at: "2024-01-02T00:00:00Z",
          },
        ],
      });
      mockListIssueComments.mockResolvedValue({
        data: [
          {
            id: 2,
            user: { login: "reviewer2" },
            body: "First",
            created_at: "2024-01-01T00:00:00Z",
          },
        ],
      });

      const comments = await connector.getComments(repo, "123");

      expect(comments[0].id).toBe("2");
      expect(comments[1].id).toBe("1");
    });
  });

  describe("addComment", () => {
    it("adds a comment to the PR", async () => {
      mockCreateComment.mockResolvedValue({ data: {} });

      await connector.addComment(repo, "123", "Test comment body");

      expect(mockCreateComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 123,
        body: "Test comment body",
      });
    });

    it("throws ConnectorError on failure", async () => {
      mockCreateComment.mockRejectedValue(new Error("API error"));
      await expect(connector.addComment(repo, "123", "Test")).rejects.toThrow(ConnectorError);
    });
  });

  describe("error handling", () => {
    it("throws when GITHUB_TOKEN is not set", async () => {
      delete process.env.GITHUB_TOKEN;
      await expect(connector.createBranch(repo, "feature", "main")).rejects.toThrow(ConnectorError);
    });

    it("throws when repository config is missing owner or repo", async () => {
      const badRepo: Repository = {
        ...repo,
        providerConfig: { owner: "test-org" },
      };
      await expect(connector.createBranch(badRepo, "feature", "main")).rejects.toThrow(ConnectorError);
    });
  });
});

describe("getConnector", () => {
  it("returns GitHubConnector for github provider", async () => {
    const { getConnector } = await import("../connectors/types.js");
    const connector = getConnector("github");
    expect(connector).toBeInstanceOf(GitHubConnector);
  });

  it("throws for unsupported provider", async () => {
    const { getConnector, ConnectorError } = await import("../connectors/types.js");
    expect(() => getConnector("bitbucket")).toThrow(ConnectorError);
  });
});
