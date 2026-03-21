import { Octokit } from "@octokit/rest";
import type { Repository } from "../models/types.js";
import { ConnectorError } from "./types.js";

export interface GitHubIssue {
  ref: string;          // "owner/repo#123"
  number: number;
  title: string;
  body?: string;
  labels: string[];
  assignees: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  repository: string;   // "owner/repo"
}

export class GitHubIssuesConnector {
  private readonly octokit: Octokit;

  constructor(octokit?: Octokit) {
    if (octokit) {
      this.octokit = octokit;
    } else {
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new ConnectorError("GITHUB_TOKEN environment variable not set", "github");
      }
      this.octokit = new Octokit({ auth: token });
    }
  }

  private getOctokit(): Octokit {
    return this.octokit;
  }

  /**
   * Search open issues by title across a set of repositories.
   * If query is empty, returns recent open issues from those repos.
   */
  async searchIssues(repos: Repository[], query: string, maxResults = 20): Promise<GitHubIssue[]> {
    const octokit = this.getOctokit();

    const repoQualifiers = repos
      .filter(r => r.providerConfig.owner && r.providerConfig.repo)
      .map(r => `repo:${r.providerConfig.owner}/${r.providerConfig.repo}`)
      .join(" ");

    if (!repoQualifiers) {
      return [];
    }

    const q = [
      query.trim() ? `${query.trim()} in:title` : "",
      "is:issue",
      "is:open",
      repoQualifiers,
    ]
      .filter(Boolean)
      .join(" ");

    try {
      const { data } = await octokit.search.issuesAndPullRequests({
        q,
        per_page: maxResults,
        sort: "updated",
        order: "desc",
      });

      return data.items.map(item => this.mapIssue(item));
    } catch (error) {
      throw new ConnectorError(
        `Failed to search issues: ${error instanceof Error ? error.message : String(error)}`,
        "github",
        error
      );
    }
  }

  /**
   * Get a single GitHub issue.
   */
  async getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
    const octokit = this.getOctokit();

    try {
      const { data } = await octokit.issues.get({ owner, repo, issue_number: number });
      return this.mapIssue(data);
    } catch (error) {
      throw new ConnectorError(
        `Failed to get issue: ${error instanceof Error ? error.message : String(error)}`,
        "github",
        error
      );
    }
  }

  /**
   * Format an array of GitHub issues as context string for the master agent prompt.
   */
  formatIssuesAsContext(issues: GitHubIssue[]): string {
    if (issues.length === 0) {
      return "No GitHub issues found.";
    }

    const lines: string[] = [`## GitHub Issues (${issues.length} found)`, ""];

    for (const issue of issues) {
      lines.push(`### ${issue.ref}: ${issue.title}`);
      lines.push(`- **Repository:** ${issue.repository}`);
      if (issue.labels.length > 0) {
        lines.push(`- **Labels:** ${issue.labels.join(", ")}`);
      }
      if (issue.assignees.length > 0) {
        lines.push(`- **Assignees:** ${issue.assignees.join(", ")}`);
      }
      lines.push(`- **URL:** ${issue.url}`);
      if (issue.body) {
        lines.push("");
        lines.push("**Description:**");
        lines.push("```");
        lines.push(issue.body);
        lines.push("```");
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapIssue(item: any): GitHubIssue {
    const repoUrl: string = item.repository_url ?? item.url ?? "";
    // Extract "owner/repo" from URL like https://api.github.com/repos/owner/repo
    const repoMatch = repoUrl.match(/\/repos\/([^/]+\/[^/]+)/);
    const repository = repoMatch ? repoMatch[1] : (item.html_url ?? "").replace("https://github.com/", "").split("/issues/")[0];

    return {
      ref: `${repository}#${item.number}`,
      number: item.number,
      title: item.title,
      body: item.body ?? undefined,
      labels: (item.labels ?? []).map((l: { name: string } | string) =>
        typeof l === "string" ? l : l.name
      ),
      assignees: (item.assignees ?? []).map((a: { login: string }) => a.login),
      author: item.user?.login ?? "unknown",
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      url: item.html_url,
      repository,
    };
  }
}
