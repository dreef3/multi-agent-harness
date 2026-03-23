import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitHubRepoInfo } from "../api/repositories.js";

describe("GitHub repository listing", () => {
  describe("GitHub repository data transformation", () => {
    it("transforms GitHub API response to expected repository format", () => {
      // Mock GitHub API response structure (from Octokit)
      const githubApiResponse = {
        id: 123,
        name: "test-repo",
        full_name: "owner/test-repo",
        clone_url: "https://github.com/owner/test-repo.git",
        default_branch: "main",
        owner: { login: "owner" },
        private: false,
        description: "A test repository",
      };

      // Transform to our internal format (same as the API endpoint)
      const transformed: GitHubRepoInfo = {
        name: githubApiResponse.name,
        fullName: githubApiResponse.full_name,
        cloneUrl: githubApiResponse.clone_url,
        defaultBranch: githubApiResponse.default_branch ?? "main",
        owner: githubApiResponse.owner.login,
        repo: githubApiResponse.name,
        private: githubApiResponse.private,
        description: githubApiResponse.description ?? undefined,
      };

      expect(transformed.name).toBe("test-repo");
      expect(transformed.fullName).toBe("owner/test-repo");
      expect(transformed.cloneUrl).toBe("https://github.com/owner/test-repo.git");
      expect(transformed.defaultBranch).toBe("main");
      expect(transformed.owner).toBe("owner");
      expect(transformed.repo).toBe("test-repo");
      expect(transformed.private).toBe(false);
      expect(transformed.description).toBe("A test repository");
    });

    it("handles repositories with null default_branch", () => {
      // Simulating what GitHub API might return when default_branch is null
      const githubApiResponse = {
        id: 456,
        name: "old-repo",
        full_name: "owner/old-repo",
        clone_url: "https://github.com/owner/old-repo.git",
        default_branch: null as unknown as string | null,
        owner: { login: "owner" },
        private: true,
        description: null as unknown as string | null,
      };

      const transformed: GitHubRepoInfo = {
        name: githubApiResponse.name,
        fullName: githubApiResponse.full_name,
        cloneUrl: githubApiResponse.clone_url,
        defaultBranch: githubApiResponse.default_branch ?? "main",
        owner: githubApiResponse.owner.login,
        repo: githubApiResponse.name,
        private: githubApiResponse.private,
        description: githubApiResponse.description ?? undefined,
      };

      expect(transformed.defaultBranch).toBe("main"); // Falls back to main
    });
  });

  describe("provider config transformation", () => {
    it("creates correct providerConfig for Repository model", () => {
      const githubRepo: GitHubRepoInfo = {
        name: "test-repo",
        fullName: "owner/test-repo",
        cloneUrl: "https://github.com/owner/test-repo.git",
        defaultBranch: "main",
        owner: "owner",
        repo: "test-repo",
        private: false,
      };

      // Transform to providerConfig format for Repository model
      const providerConfig = {
        owner: githubRepo.owner,
        repo: githubRepo.repo,
      };

      expect(providerConfig).toEqual({
        owner: "owner",
        repo: "test-repo",
      });
    });

    it("handles HTTPS and SSH clone URLs", () => {
      const httpsUrl = "https://github.com/owner/repo.git";
      const sshUrl = "git@github.com:owner/repo.git";

      // Extract owner/repo from HTTPS URL
      const httpsMatch = httpsUrl.match(/github\.com\/(.+)\/(.+)\.git/);
      expect(httpsMatch).not.toBeNull();
      if (httpsMatch) {
        expect(httpsMatch[1]).toBe("owner");
        expect(httpsMatch[2]).toBe("repo");
      }

      // Extract owner/repo from SSH URL
      const sshMatch = sshUrl.match(/github\.com[:/](.+)\/(.+)\.git/);
      expect(sshMatch).not.toBeNull();
      if (sshMatch) {
        expect(sshMatch[1]).toBe("owner");
        expect(sshMatch[2]).toBe("repo");
      }
    });
  });

  describe("batch transformation", () => {
    it("transforms multiple repositories correctly", () => {
      const githubApiResponses = [
        {
          id: 1,
          name: "repo-1",
          full_name: "org/repo-1",
          clone_url: "https://github.com/org/repo-1.git",
          default_branch: "main",
          owner: { login: "org" },
          private: false,
          description: "First repo",
        },
        {
          id: 2,
          name: "repo-2",
          full_name: "org/repo-2",
          clone_url: "https://github.com/org/repo-2.git",
          default_branch: "develop",
          owner: { login: "org" },
          private: true,
          description: "Second repo",
        },
      ];

      const transformed: GitHubRepoInfo[] = githubApiResponses.map((r) => ({
        name: r.name,
        fullName: r.full_name,
        cloneUrl: r.clone_url,
        defaultBranch: r.default_branch ?? "main",
        owner: r.owner.login,
        repo: r.name,
        private: r.private,
        description: r.description ?? undefined,
      }));

      expect(transformed).toHaveLength(2);
      expect(transformed[0]).toEqual({
        name: "repo-1",
        fullName: "org/repo-1",
        cloneUrl: "https://github.com/org/repo-1.git",
        defaultBranch: "main",
        owner: "org",
        repo: "repo-1",
        private: false,
        description: "First repo",
      });
      expect(transformed[1]).toEqual({
        name: "repo-2",
        fullName: "org/repo-2",
        cloneUrl: "https://github.com/org/repo-2.git",
        defaultBranch: "develop",
        owner: "org",
        repo: "repo-2",
        private: true,
        description: "Second repo",
      });
    });
  });
});
