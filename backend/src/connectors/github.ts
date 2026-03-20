import { Octokit } from "@octokit/rest";
import type { Repository, VcsComment } from "../models/types.js";
import type { VcsConnector, CreatePullRequestParams, PullRequestResult, PullRequestInfo } from "./types.js";
import { ConnectorError } from "./types.js";

export class GitHubConnector implements VcsConnector {
  private getToken(): string {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new ConnectorError("GITHUB_TOKEN environment variable not set", "github");
    }
    return token;
  }

  private getOctokit(): Octokit {
    return new Octokit({ auth: this.getToken() });
  }

  private getOwnerRepo(repo: Repository): { owner: string; repoName: string } {
    const config = repo.providerConfig;
    if (!config.owner || !config.repo) {
      throw new ConnectorError("Repository missing owner or repo in providerConfig", "github");
    }
    return { owner: config.owner, repoName: config.repo };
  }

  async createBranch(repo: Repository, branchName: string, fromRef: string): Promise<void> {
    const octokit = this.getOctokit();
    const { owner, repoName } = this.getOwnerRepo(repo);

    try {
      const { data: refData } = await octokit.git.getRef({
        owner,
        repo: repoName,
        ref: `heads/${fromRef}`,
      });

      await octokit.git.createRef({
        owner,
        repo: repoName,
        ref: `refs/heads/${branchName}`,
        sha: refData.object.sha,
      });
    } catch (error) {
      throw new ConnectorError(
        `Failed to create branch: ${error instanceof Error ? error.message : String(error)}`,
        "github",
        error
      );
    }
  }

  async createPullRequest(repo: Repository, params: CreatePullRequestParams): Promise<PullRequestResult> {
    const octokit = this.getOctokit();
    const { owner, repoName } = this.getOwnerRepo(repo);

    try {
      const { data } = await octokit.pulls.create({
        owner,
        repo: repoName,
        title: params.title,
        body: params.description,
        head: params.headBranch,
        base: params.baseBranch,
      });

      return {
        id: String(data.number),
        url: data.html_url,
      };
    } catch (error) {
      throw new ConnectorError(
        `Failed to create pull request: ${error instanceof Error ? error.message : String(error)}`,
        "github",
        error
      );
    }
  }

  async getPullRequest(repo: Repository, prId: string): Promise<PullRequestInfo> {
    const octokit = this.getOctokit();
    const { owner, repoName } = this.getOwnerRepo(repo);

    try {
      const { data } = await octokit.pulls.get({
        owner,
        repo: repoName,
        pull_number: parseInt(prId, 10),
      });

      let status: PullRequestInfo["status"] = "open";
      if (data.merged) {
        status = "merged";
      } else if (data.state === "closed") {
        status = "declined";
      }

      return {
        status,
        url: data.html_url,
      };
    } catch (error) {
      throw new ConnectorError(
        `Failed to get pull request: ${error instanceof Error ? error.message : String(error)}`,
        "github",
        error
      );
    }
  }

  async getComments(repo: Repository, prId: string, since?: string): Promise<VcsComment[]> {
    const octokit = this.getOctokit();
    const { owner, repoName } = this.getOwnerRepo(repo);

    try {
      const { data: reviewComments } = await octokit.pulls.listReviewComments({
        owner,
        repo: repoName,
        pull_number: parseInt(prId, 10),
      });

      const { data: issueComments } = await octokit.issues.listComments({
        owner,
        repo: repoName,
        issue_number: parseInt(prId, 10),
      });

      const comments: VcsComment[] = [];

      for (const comment of reviewComments) {
        if (since && comment.created_at && new Date(comment.created_at) < new Date(since)) {
          continue;
        }
        comments.push({
          id: String(comment.id),
          author: comment.user?.login ?? "unknown",
          body: comment.body ?? "",
          filePath: comment.path ?? undefined,
          lineNumber: comment.line ?? undefined,
          createdAt: comment.created_at ?? new Date().toISOString(),
        });
      }

      for (const comment of issueComments) {
        if (since && comment.created_at && new Date(comment.created_at) < new Date(since)) {
          continue;
        }
        comments.push({
          id: String(comment.id),
          author: comment.user?.login ?? "unknown",
          body: comment.body ?? "",
          createdAt: comment.created_at ?? new Date().toISOString(),
        });
      }

      return comments.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    } catch (error) {
      throw new ConnectorError(
        `Failed to get comments: ${error instanceof Error ? error.message : String(error)}`,
        "github",
        error
      );
    }
  }

  async addComment(repo: Repository, prId: string, body: string): Promise<void> {
    const octokit = this.getOctokit();
    const { owner, repoName } = this.getOwnerRepo(repo);

    try {
      await octokit.issues.createComment({
        owner,
        repo: repoName,
        issue_number: parseInt(prId, 10),
        body,
      });
    } catch (error) {
      throw new ConnectorError(
        `Failed to add comment: ${error instanceof Error ? error.message : String(error)}`,
        "github",
        error
      );
    }
  }
}
