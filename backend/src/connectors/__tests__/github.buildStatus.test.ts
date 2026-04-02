import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubConnector } from "../github.js";

describe("GitHubConnector.getBuildStatus", () => {
  it("returns 'success' when all checks pass", async () => {
    const connector = new GitHubConnector();
    const mockOctokit = {
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              { id: 1, name: "test-backend", conclusion: "success", html_url: "http://example.com", started_at: null, completed_at: null },
              { id: 2, name: "test-frontend", conclusion: "success", html_url: "http://example.com", started_at: null, completed_at: null },
            ],
          },
        }),
      },
    };
    // @ts-expect-error: inject mock octokit
    vi.spyOn(connector, "getOctokit").mockReturnValue(mockOctokit);
    vi.stubEnv("GITHUB_TOKEN", "test-token");

    const repo = { cloneUrl: "https://github.com/org/repo.git", provider: "github", providerConfig: { owner: "org", repo: "repo" } } as any;
    const result = await connector.getBuildStatus(repo, "main");

    expect(result.state).toBe("success");
    expect(result.checks).toHaveLength(2);
  });

  it("returns 'failure' when any check fails", async () => {
    const connector = new GitHubConnector();
    const mockOctokit = {
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              { id: 1, name: "test-backend", conclusion: "failure", html_url: "", started_at: null, completed_at: null },
              { id: 2, name: "test-frontend", conclusion: "success", html_url: "", started_at: null, completed_at: null },
            ],
          },
        }),
      },
    };
    // @ts-expect-error: inject mock octokit
    vi.spyOn(connector, "getOctokit").mockReturnValue(mockOctokit);
    vi.stubEnv("GITHUB_TOKEN", "test-token");

    const repo = { cloneUrl: "https://github.com/org/repo.git", provider: "github", providerConfig: { owner: "org", repo: "repo" } } as any;
    const result = await connector.getBuildStatus(repo, "feature/foo");

    expect(result.state).toBe("failure");
    expect(result.checks.find(c => c.name === "test-backend")?.status).toBe("failure");
  });

  it("returns 'pending' when checks are in progress", async () => {
    const connector = new GitHubConnector();
    const mockOctokit = {
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              { id: 1, name: "test-backend", conclusion: null, html_url: "", started_at: "2026-01-01T00:00:00Z", completed_at: null },
            ],
          },
        }),
      },
    };
    // @ts-expect-error: inject mock octokit
    vi.spyOn(connector, "getOctokit").mockReturnValue(mockOctokit);
    vi.stubEnv("GITHUB_TOKEN", "test-token");

    const repo = { cloneUrl: "https://github.com/org/repo.git", provider: "github", providerConfig: { owner: "org", repo: "repo" } } as any;
    const result = await connector.getBuildStatus(repo, "sha-abc123");

    expect(result.state).toBe("pending");
  });

  it("returns 'unknown' when no checks exist", async () => {
    const connector = new GitHubConnector();
    const mockOctokit = {
      checks: {
        listForRef: vi.fn().mockResolvedValue({ data: { check_runs: [] } }),
      },
    };
    // @ts-expect-error: inject mock octokit
    vi.spyOn(connector, "getOctokit").mockReturnValue(mockOctokit);
    vi.stubEnv("GITHUB_TOKEN", "test-token");

    const repo = { cloneUrl: "https://github.com/org/repo.git", provider: "github", providerConfig: { owner: "org", repo: "repo" } } as any;
    const result = await connector.getBuildStatus(repo, "sha-no-ci");

    expect(result.state).toBe("unknown");
    expect(result.checks).toHaveLength(0);
  });
});
