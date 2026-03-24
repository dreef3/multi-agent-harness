import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GitHubConnector } from "../connectors/github.js";
import { BitbucketConnector } from "../connectors/bitbucket.js";
import type { Repository } from "../models/types.js";
import { ConnectorError } from "../connectors/types.js";

const mockCreateRef = vi.fn();
const mockGetRef = vi.fn();
const mockCreatePR = vi.fn();
const mockGetPR = vi.fn();
const mockListReviewComments = vi.fn();
const mockListReviews = vi.fn();
const mockListIssueComments = vi.fn();
const mockCreateComment = vi.fn();
const mockGetContent = vi.fn();
const mockCreateOrUpdateFileContents = vi.fn();

vi.mock("@octokit/rest", () => {
  const Octokit = function () {
    return {
      git: {
        getRef: mockGetRef,
        createRef: mockCreateRef,
      },
      pulls: {
        create: mockCreatePR,
        get: mockGetPR,
        listReviewComments: mockListReviewComments,
        listReviews: mockListReviews,
      },
      issues: {
        listComments: mockListIssueComments,
        createComment: mockCreateComment,
      },
      repos: {
        getContent: mockGetContent,
        createOrUpdateFileContents: mockCreateOrUpdateFileContents,
      },
    };
  };
  return { Octokit };
});

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

  afterEach(() => {
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

  describe("commitFile", () => {
    it("calls createOrUpdateFileContents with base64 content (new file)", async () => {
      mockGetContent.mockRejectedValue(new Error("Not Found"));
      mockCreateOrUpdateFileContents.mockResolvedValue({});

      await connector.commitFile(repo, "main", "docs/spec.md", "# Spec", "chore: add spec");

      expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith(expect.objectContaining({
        owner: "test-org",
        repo: "test-repo",
        path: "docs/spec.md",
        message: "chore: add spec",
        branch: "main",
        content: Buffer.from("# Spec", "utf-8").toString("base64"),
      }));
    });

    it("passes sha when file already exists", async () => {
      mockGetContent.mockResolvedValue({
        data: { type: "file", sha: "abc123def456" },
      });
      mockCreateOrUpdateFileContents.mockResolvedValue({});

      await connector.commitFile(repo, "main", "docs/spec.md", "# Spec v2", "chore: update spec");

      expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith(expect.objectContaining({
        sha: "abc123def456",
      }));
    });

    it("calls createBranch when createBranch option is true", async () => {
      const createBranchSpy = vi.spyOn(connector, "createBranch").mockResolvedValue(undefined);
      mockGetContent.mockRejectedValue(new Error("Not Found"));
      mockCreateOrUpdateFileContents.mockResolvedValue({});

      await connector.commitFile(repo, "feature-branch", "docs/spec.md", "# Spec", "chore: add spec", true);

      expect(createBranchSpy).toHaveBeenCalledWith(repo, "feature-branch", repo.defaultBranch);
    });

    it("throws ConnectorError on failure", async () => {
      mockGetContent.mockRejectedValue(new Error("Not Found"));
      mockCreateOrUpdateFileContents.mockRejectedValue(new Error("API error"));

      await expect(
        connector.commitFile(repo, "main", "docs/spec.md", "# Spec", "chore: add spec")
      ).rejects.toThrow(ConnectorError);
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

  describe("getApprovals", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      process.env.GITHUB_TOKEN = "test-token";
    });

    it("returns empty array when no reviews exist", async () => {
      mockListReviews.mockResolvedValue({ data: [] });

      const approvals = await connector.getApprovals(repo, "123");

      expect(approvals).toEqual([]);
      expect(mockListReviews).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        pull_number: 123,
      });
    });

    it("returns users with APPROVED state only", async () => {
      mockListReviews.mockResolvedValue({
        data: [
          { user: { login: "alice" }, state: "APPROVED", submitted_at: "2024-01-01T00:00:00Z" },
          { user: { login: "bob" }, state: "COMMENTED", submitted_at: "2024-01-01T00:00:00Z" },
          { user: { login: "carol" }, state: "APPROVED", submitted_at: "2024-01-02T00:00:00Z" },
          { user: { login: "dave" }, state: "CHANGES_REQUESTED", submitted_at: "2024-01-01T00:00:00Z" },
        ],
      });

      const approvals = await connector.getApprovals(repo, "123");

      expect(approvals).toHaveLength(2);
      expect(approvals.map((a) => a.author).sort()).toEqual(["alice", "carol"]);
    });

    it("uses latest review state when user has multiple reviews", async () => {
      mockListReviews.mockResolvedValue({
        data: [
          { user: { login: "alice" }, state: "CHANGES_REQUESTED", submitted_at: "2024-01-01T00:00:00Z" },
          { user: { login: "alice" }, state: "APPROVED", submitted_at: "2024-01-02T00:00:00Z" },
        ],
      });

      const approvals = await connector.getApprovals(repo, "123");

      expect(approvals).toHaveLength(1);
      expect(approvals[0].author).toBe("alice");
      expect(approvals[0].createdAt).toBe("2024-01-02T00:00:00Z");
    });

    it("uses latest rejected state even when preceded by approval", async () => {
      mockListReviews.mockResolvedValue({
        data: [
          { user: { login: "alice" }, state: "APPROVED", submitted_at: "2024-01-01T00:00:00Z" },
          { user: { login: "alice" }, state: "CHANGES_REQUESTED", submitted_at: "2024-01-02T00:00:00Z" },
        ],
      });

      const approvals = await connector.getApprovals(repo, "123");

      expect(approvals).toHaveLength(0);
    });

    it("handles missing submitted_at gracefully", async () => {
      mockListReviews.mockResolvedValue({
        data: [{ user: { login: "alice" }, state: "APPROVED", submitted_at: null }],
      });

      const approvals = await connector.getApprovals(repo, "123");

      expect(approvals).toHaveLength(1);
      expect(approvals[0].author).toBe("alice");
      expect(approvals[0].createdAt).toBeDefined();
    });

    it("handles users with null login", async () => {
      mockListReviews.mockResolvedValue({
        data: [
          { user: null, state: "APPROVED", submitted_at: "2024-01-01T00:00:00Z" },
          { user: { login: null }, state: "APPROVED", submitted_at: "2024-01-01T00:00:00Z" },
          { user: { login: "alice" }, state: "APPROVED", submitted_at: "2024-01-01T00:00:00Z" },
        ],
      });

      const approvals = await connector.getApprovals(repo, "123");

      expect(approvals).toHaveLength(1);
      expect(approvals[0].author).toBe("alice");
    });

    it("throws ConnectorError on API failure", async () => {
      mockListReviews.mockRejectedValue(new Error("API error"));

      await expect(connector.getApprovals(repo, "123")).rejects.toThrow(ConnectorError);
    });

    it("throws when GITHUB_TOKEN is not set", async () => {
      delete process.env.GITHUB_TOKEN;
      await expect(connector.getApprovals(repo, "123")).rejects.toThrow(ConnectorError);
      process.env.GITHUB_TOKEN = "test-token";
    });
  });
});

describe("BitbucketConnector", () => {
  let connector: BitbucketConnector;
  let mockFetch: ReturnType<typeof vi.fn>;
  const repo: Repository = {
    id: "repo-1",
    name: "test-repo",
    cloneUrl: "https://bitbucket.company.com/scm/TEST/test-repo.git",
    provider: "bitbucket-server",
    providerConfig: { projectKey: "TEST", repoSlug: "test-repo", baseUrl: "https://bitbucket.company.com" },
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    connector = new BitbucketConnector();
    vi.clearAllMocks();
    process.env.BITBUCKET_TOKEN = "test-token";
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createBranch", () => {
    it("creates a branch from the specified ref", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          values: [{ id: "refs/heads/main", latestCommit: "abc123" }],
        }),
      } as unknown as Response);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as unknown as Response);

      await connector.createBranch(repo, "feature-branch", "main");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "https://bitbucket.company.com/rest/api/1.0/projects/TEST/repos/test-repo/branches?filterText=main",
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-token" }) })
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "https://bitbucket.company.com/rest/api/1.0/projects/TEST/repos/test-repo/branches",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "feature-branch", startPoint: "abc123", message: "Create branch feature-branch" }),
        })
      );
    });

    it("throws ConnectorError on failure", async () => {
      mockFetch.mockRejectedValue(new Error("API error"));
      await expect(connector.createBranch(repo, "feature-branch", "main")).rejects.toThrow(ConnectorError);
    });
  });

  describe("createPullRequest", () => {
    it("creates a pull request and returns result", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 123,
          links: { self: [{ href: "https://bitbucket.company.com/projects/TEST/repos/test-repo/pull-requests/123" }] },
        }),
      } as unknown as Response);

      const result = await connector.createPullRequest(repo, {
        title: "Test PR",
        description: "Test description",
        headBranch: "feature-branch",
        baseBranch: "main",
      });

      expect(result).toEqual({
        id: "123",
        url: "https://bitbucket.company.com/projects/TEST/repos/test-repo/pull-requests/123",
      });
    });

    it("throws ConnectorError on failure", async () => {
      mockFetch.mockRejectedValue(new Error("API error"));
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
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 123,
          state: "OPEN",
          links: { self: [{ href: "https://bitbucket.company.com/projects/TEST/repos/test-repo/pull-requests/123" }] },
        }),
      } as unknown as Response);

      const result = await connector.getPullRequest(repo, "123");
      expect(result).toEqual({
        status: "open",
        url: "https://bitbucket.company.com/projects/TEST/repos/test-repo/pull-requests/123",
      });
    });

    it("returns merged PR info", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 123,
          state: "MERGED",
          links: { self: [{ href: "https://bitbucket.company.com/projects/TEST/repos/test-repo/pull-requests/123" }] },
        }),
      } as unknown as Response);

      const result = await connector.getPullRequest(repo, "123");
      expect(result).toEqual({
        status: "merged",
        url: "https://bitbucket.company.com/projects/TEST/repos/test-repo/pull-requests/123",
      });
    });

    it("returns declined PR info", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 123,
          state: "DECLINED",
          links: { self: [{ href: "https://bitbucket.company.com/projects/TEST/repos/test-repo/pull-requests/123" }] },
        }),
      } as unknown as Response);

      const result = await connector.getPullRequest(repo, "123");
      expect(result).toEqual({
        status: "declined",
        url: "https://bitbucket.company.com/projects/TEST/repos/test-repo/pull-requests/123",
      });
    });
  });

  describe("getComments", () => {
    it("returns comments from activities", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          values: [
            {
              action: "COMMENTED",
              comment: {
                id: 1,
                text: "Great work!",
                author: { displayName: "Reviewer 1", slug: "reviewer1" },
                createdDate: 1704067200000,
                anchor: { path: "src/file.ts", line: 42 },
              },
            },
            {
              action: "COMMENTED",
              comment: {
                id: 2,
                text: "Needs improvement",
                author: { displayName: "Reviewer 2", slug: "reviewer2" },
                createdDate: 1704153600000,
              },
            },
          ],
        }),
      } as unknown as Response);

      const comments = await connector.getComments(repo, "123");

      expect(comments).toHaveLength(2);
      expect(comments[0]).toMatchObject({
        id: "1",
        author: "Reviewer 1",
        body: "Great work!",
        filePath: "src/file.ts",
        lineNumber: 42,
      });
      expect(comments[1]).toMatchObject({
        id: "2",
        author: "Reviewer 2",
        body: "Needs improvement",
      });
    });

    it("filters comments by since timestamp", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          values: [
            {
              action: "COMMENTED",
              comment: {
                id: 1,
                text: "Old comment",
                author: { displayName: "Reviewer 1", slug: "reviewer1" },
                createdDate: new Date("2024-01-01").getTime(),
              },
            },
            {
              action: "COMMENTED",
              comment: {
                id: 2,
                text: "New comment",
                author: { displayName: "Reviewer 2", slug: "reviewer2" },
                createdDate: new Date("2024-01-03").getTime(),
              },
            },
          ],
        }),
      } as unknown as Response);

      const comments = await connector.getComments(repo, "123", "2024-01-02T00:00:00.000Z");

      expect(comments).toHaveLength(1);
      expect(comments[0].id).toBe("2");
    });

    it("filters out deleted comments", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          values: [
            {
              action: "COMMENTED",
              comment: { id: 1, text: "Deleted", author: { displayName: "User" }, createdDate: 1704067200000 },
              commentAction: "DELETED",
            },
            {
              action: "COMMENTED",
              comment: { id: 2, text: "Active", author: { displayName: "User" }, createdDate: 1704067200000 },
            },
          ],
        }),
      } as unknown as Response);

      const comments = await connector.getComments(repo, "123");

      expect(comments).toHaveLength(1);
      expect(comments[0].id).toBe("2");
    });
  });

  describe("addComment", () => {
    it("adds a comment to the PR", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as unknown as Response);

      await connector.addComment(repo, "123", "Test comment body");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://bitbucket.company.com/rest/api/1.0/projects/TEST/repos/test-repo/pull-requests/123/comments",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ text: "Test comment body" }),
        })
      );
    });

    it("throws ConnectorError on failure", async () => {
      mockFetch.mockRejectedValue(new Error("API error"));
      await expect(connector.addComment(repo, "123", "Test")).rejects.toThrow(ConnectorError);
    });
  });

  describe("commitFile", () => {
    it("calls Files API with PUT and multipart/form-data", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as unknown as Response);

      await connector.commitFile(repo, "main", "docs/spec.md", "# Spec", "chore: add spec");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/rest/api/1.0/projects/TEST/repos/test-repo/browse/docs/spec.md"),
        expect.objectContaining({
          method: "PUT",
          headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
          body: expect.any(FormData),
        })
      );
    });

    it("calls createBranch when createBranch option is true", async () => {
      const createBranchSpy = vi.spyOn(connector, "createBranch").mockResolvedValue(undefined);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as unknown as Response);

      await connector.commitFile(repo, "feature-branch", "docs/spec.md", "# Spec", "chore: add spec", true);

      expect(createBranchSpy).toHaveBeenCalledWith(repo, "feature-branch", repo.defaultBranch);
    });

    it("throws ConnectorError when response is not ok", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "Bad Request",
      } as unknown as Response);

      await expect(
        connector.commitFile(repo, "main", "docs/spec.md", "# Spec", "chore: add spec")
      ).rejects.toThrow(ConnectorError);
    });
  });

  describe("error handling", () => {
    it("throws when BITBUCKET_TOKEN is not set", async () => {
      delete process.env.BITBUCKET_TOKEN;
      await expect(connector.createBranch(repo, "feature", "main")).rejects.toThrow(ConnectorError);
    });

    it("throws when repository config is missing projectKey or repoSlug", async () => {
      const badRepo: Repository = {
        ...repo,
        providerConfig: { projectKey: "TEST" },
      };
      await expect(connector.createBranch(badRepo, "feature", "main")).rejects.toThrow(ConnectorError);
    });
  });

  describe("getApprovals", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      process.env.BITBUCKET_TOKEN = "test-token";
    });

    it("returns empty array when no reviewers have approved", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          reviewers: [{ user: { name: "alice" }, approved: false }],
        }),
      } as unknown as Response);

      const approvals = await connector.getApprovals(repo, "123");

      expect(approvals).toEqual([]);
    });

    it("returns empty array when reviewers array is empty", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ reviewers: [] }),
      } as unknown as Response);

      const approvals = await connector.getApprovals(repo, "123");

      expect(approvals).toEqual([]);
    });

    it("returns users with approved: true", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          reviewers: [
            { user: { name: "alice" }, approved: true, lastUpdated: "2024-01-01T00:00:00Z" },
            { user: { name: "bob" }, approved: false },
            { user: { name: "carol" }, approved: true, lastUpdated: "2024-01-02T00:00:00Z" },
          ],
        }),
      } as unknown as Response);

      const approvals = await connector.getApprovals(repo, "123");

      expect(approvals).toHaveLength(2);
      expect(approvals.map((a) => a.author).sort()).toEqual(["alice", "carol"]);
    });

    it("includes createdAt from lastUpdated timestamp", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          reviewers: [{ user: { name: "alice" }, approved: true, lastUpdated: "2024-03-15T10:30:00Z" }],
        }),
      } as unknown as Response);

      const approvals = await connector.getApprovals(repo, "123");

      expect(approvals[0].createdAt).toBe("2024-03-15T10:30:00Z");
    });

    it("uses current timestamp when lastUpdated is missing", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          reviewers: [{ user: { name: "alice" }, approved: true }],
        }),
      } as unknown as Response);

      const approvals = await connector.getApprovals(repo, "123");

      expect(approvals).toHaveLength(1);
      expect(approvals[0].createdAt).toBeDefined();
      // Should be a valid ISO date string
      expect(new Date(approvals[0].createdAt).toISOString()).toBe(approvals[0].createdAt);
    });

    it("handles missing user name gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          reviewers: [
            { user: null, approved: true },
            { user: { name: null }, approved: true },
            { user: { name: "alice" }, approved: true },
          ],
        }),
      } as unknown as Response);

      const approvals = await connector.getApprovals(repo, "123");

      expect(approvals).toHaveLength(1);
      expect(approvals[0].author).toBe("alice");
    });

    it("throws ConnectorError on API failure", async () => {
      mockFetch.mockRejectedValue(new Error("API error"));

      await expect(connector.getApprovals(repo, "123")).rejects.toThrow(ConnectorError);
    });

    it("throws when BITBUCKET_TOKEN is not set", async () => {
      delete process.env.BITBUCKET_TOKEN;
      await expect(connector.getApprovals(repo, "123")).rejects.toThrow(ConnectorError);
      process.env.BITBUCKET_TOKEN = "test-token";
    });
  });
});

describe("getConnector", () => {
  it("returns GitHubConnector for github provider", async () => {
    const { getConnector } = await import("../connectors/types.js");
    const connector = getConnector("github");
    expect(connector).toBeInstanceOf(GitHubConnector);
  });

  it("returns BitbucketConnector for bitbucket-server provider", async () => {
    const { getConnector } = await import("../connectors/types.js");
    const connector = getConnector("bitbucket-server");
    expect(connector).toBeInstanceOf(BitbucketConnector);
  });

  it("throws for unsupported provider", async () => {
    const { getConnector, ConnectorError } = await import("../connectors/types.js");
    expect(() => getConnector("bitbucket")).toThrow(ConnectorError);
  });
});
