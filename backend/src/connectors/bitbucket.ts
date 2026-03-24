import type { Repository, VcsComment, VcsApproval } from "../models/types.js";
import type { VcsConnector, CreatePullRequestParams, PullRequestResult, PullRequestInfo } from "./types.js";
import { ConnectorError } from "./types.js";

interface BitbucketRef {
  id: string;
  latestCommit: string;
}

interface BitbucketPullRequest {
  id: number;
  version: number;
  title: string;
  description?: string;
  fromRef: BitbucketRef;
  toRef: BitbucketRef;
  state: "OPEN" | "MERGED" | "DECLINED";
  links: {
    self: { href: string }[];
  };
}

interface BitbucketComment {
  id: number;
  text: string;
  author: {
    displayName: string;
    slug: string;
  };
  createdDate: number;
  anchor?: {
    path: string;
    line: number;
    lineType: string;
  };
}

export class BitbucketConnector implements VcsConnector {
  private getToken(): string {
    const token = process.env.BITBUCKET_TOKEN;
    if (!token) {
      throw new ConnectorError("BITBUCKET_TOKEN environment variable not set", "bitbucket-server");
    }
    return token;
  }

  private getProjectRepo(repo: Repository): { projectKey: string; repoSlug: string; baseUrl: string } {
    const config = repo.providerConfig;
    if (!config.projectKey || !config.repoSlug) {
      throw new ConnectorError("Repository missing projectKey or repoSlug in providerConfig", "bitbucket-server");
    }
    const baseUrl = config.baseUrl ?? "";
    return { projectKey: config.projectKey, repoSlug: config.repoSlug, baseUrl };
  }

  private getAuthHeaders(): Record<string, string> {
    const token = this.getToken();
    return {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  private async fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.getAuthHeaders(),
        ...(options?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "Unknown error");
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async createBranch(repo: Repository, branchName: string, fromRef: string): Promise<void> {
    const { projectKey, repoSlug, baseUrl } = this.getProjectRepo(repo);

    try {
      // First, get the commit SHA of the source branch
      const refsUrl = `${baseUrl}/rest/api/1.0/projects/${projectKey}/repos/${repoSlug}/branches?filterText=${encodeURIComponent(fromRef)}`;
      const refsResponse = await this.fetchJson<{ values: Array<{ id: string; latestCommit: string }> }>(refsUrl);

      const sourceBranch = refsResponse.values.find(ref => ref.id === `refs/heads/${fromRef}`);
      if (!sourceBranch) {
        throw new Error(`Source branch not found: ${fromRef}`);
      }

      // Create the new branch
      const createUrl = `${baseUrl}/rest/api/1.0/projects/${projectKey}/repos/${repoSlug}/branches`;
      try {
        await this.fetchJson(createUrl, {
          method: "POST",
          body: JSON.stringify({
            name: branchName,
            startPoint: sourceBranch.latestCommit,
            message: `Create branch ${branchName}`,
          }),
        });
      } catch (branchErr: unknown) {
        const msg = branchErr instanceof Error ? branchErr.message : String(branchErr);
        if (!msg.includes("HTTP 409") && !msg.toLowerCase().includes("already exists")) {
          throw new ConnectorError(`Failed to create branch: ${msg}`, "bitbucket-server", branchErr);
        }
        // Branch already exists — that's fine for idempotent calls
      }
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(
        `Failed to create branch: ${error instanceof Error ? error.message : String(error)}`,
        "bitbucket-server",
        error
      );
    }
  }

  async createPullRequest(repo: Repository, params: CreatePullRequestParams): Promise<PullRequestResult> {
    const { projectKey, repoSlug, baseUrl } = this.getProjectRepo(repo);

    try {
      const url = `${baseUrl}/rest/api/1.0/projects/${projectKey}/repos/${repoSlug}/pull-requests`;
      const pr = await this.fetchJson<BitbucketPullRequest>(url, {
        method: "POST",
        body: JSON.stringify({
          title: params.title,
          description: params.description,
          fromRef: {
            id: `refs/heads/${params.headBranch}`,
          },
          toRef: {
            id: `refs/heads/${params.baseBranch}`,
          },
        }),
      });

      return {
        id: String(pr.id),
        url: pr.links.self[0]?.href ?? "",
      };
    } catch (error) {
      throw new ConnectorError(
        `Failed to create pull request: ${error instanceof Error ? error.message : String(error)}`,
        "bitbucket-server",
        error
      );
    }
  }

  async findPullRequestByBranch(_repo: Repository, _headBranch: string): Promise<import("./types.js").PullRequestResult | null> {
    // Not yet implemented for Bitbucket
    return null;
  }

  async getPullRequest(repo: Repository, prId: string): Promise<PullRequestInfo> {
    const { projectKey, repoSlug, baseUrl } = this.getProjectRepo(repo);

    try {
      const url = `${baseUrl}/rest/api/1.0/projects/${projectKey}/repos/${repoSlug}/pull-requests/${prId}`;
      const pr = await this.fetchJson<BitbucketPullRequest>(url);

      let status: PullRequestInfo["status"];
      switch (pr.state) {
        case "MERGED":
          status = "merged";
          break;
        case "DECLINED":
          status = "declined";
          break;
        default:
          status = "open";
      }

      return {
        status,
        url: pr.links.self[0]?.href ?? "",
      };
    } catch (error) {
      throw new ConnectorError(
        `Failed to get pull request: ${error instanceof Error ? error.message : String(error)}`,
        "bitbucket-server",
        error
      );
    }
  }

  async getComments(repo: Repository, prId: string, since?: string): Promise<VcsComment[]> {
    const { projectKey, repoSlug, baseUrl } = this.getProjectRepo(repo);

    try {
      const url = `${baseUrl}/rest/api/1.0/projects/${projectKey}/repos/${repoSlug}/pull-requests/${prId}/activities`;
      const response = await this.fetchJson<{ values: Array<{ action: string; comment?: BitbucketComment; commentAction?: string }> }>(url);

      const comments: VcsComment[] = [];
      const sinceMs = since ? new Date(since).getTime() : 0;

      for (const activity of response.values) {
        if (activity.action === "COMMENTED" && activity.comment && activity.commentAction !== "DELETED") {
          const comment = activity.comment;
          const createdAt = new Date(comment.createdDate).toISOString();

          if (sinceMs && new Date(createdAt).getTime() < sinceMs) {
            continue;
          }

          comments.push({
            id: String(comment.id),
            author: comment.author?.displayName ?? comment.author?.slug ?? "unknown",
            body: comment.text,
            filePath: comment.anchor?.path,
            lineNumber: comment.anchor?.line,
            createdAt,
          });
        }
      }

      return comments.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    } catch (error) {
      throw new ConnectorError(
        `Failed to get comments: ${error instanceof Error ? error.message : String(error)}`,
        "bitbucket-server",
        error
      );
    }
  }

  async addComment(repo: Repository, prId: string, body: string): Promise<void> {
    const { projectKey, repoSlug, baseUrl } = this.getProjectRepo(repo);

    try {
      const url = `${baseUrl}/rest/api/1.0/projects/${projectKey}/repos/${repoSlug}/pull-requests/${prId}/comments`;
      await this.fetchJson(url, {
        method: "POST",
        body: JSON.stringify({ text: body }),
      });
    } catch (error) {
      throw new ConnectorError(
        `Failed to add comment: ${error instanceof Error ? error.message : String(error)}`,
        "bitbucket-server",
        error
      );
    }
  }

  async commitFile(
    repo: Repository,
    branch: string,
    path: string,
    content: string,
    message: string,
    createBranch = false
  ): Promise<void> {
    const { projectKey, repoSlug, baseUrl } = this.getProjectRepo(repo);
    const token = this.getToken();

    try {
      if (createBranch) {
        await this.createBranch(repo, branch, repo.defaultBranch);
      }

      const url = `${baseUrl}/rest/api/1.0/projects/${projectKey}/repos/${repoSlug}/browse/${path}`;

      const formData = new FormData();
      // Bitbucket Server Files API expects the content as a file blob
      formData.append("content", new Blob([content], { type: "text/plain" }), path.split("/").pop() ?? "file");
      formData.append("message", message);
      formData.append("branch", branch);

      const response = await fetch(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "Unknown error");
        throw new Error(`HTTP ${response.status}: ${text}`);
      }
    } catch (error) {
      throw new ConnectorError(
        `Failed to commit file: ${error instanceof Error ? error.message : String(error)}`,
        "bitbucket-server",
        error
      );
    }
  }

  async getApprovals(repo: Repository, prId: string): Promise<VcsApproval[]> {
    const { projectKey, repoSlug, baseUrl } = this.getProjectRepo(repo);

    try {
      const url = `${baseUrl}/rest/api/1.0/projects/${projectKey}/repos/${repoSlug}/pull-requests/${prId}`;
      const pr = await this.fetchJson<{
        reviewers: Array<{
          user: { name: string; displayName?: string };
          approved: boolean;
          lastUpdated?: string;
        }>;
      }>(url);

      const approvals: VcsApproval[] = [];
      for (const reviewer of pr.reviewers ?? []) {
        if (reviewer.approved && reviewer.user?.name) {
          approvals.push({
            author: reviewer.user.name,
            createdAt: reviewer.lastUpdated ?? new Date().toISOString(),
          });
        }
      }

      return approvals;
    } catch (error) {
      throw new ConnectorError(
        `Failed to get approvals: ${error instanceof Error ? error.message : String(error)}`,
        "bitbucket-server",
        error
      );
    }
  }
}
