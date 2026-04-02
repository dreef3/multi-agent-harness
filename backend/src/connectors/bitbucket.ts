import type { Repository, VcsComment } from "../models/types.js";
import type { VcsConnector, CreatePullRequestParams, PullRequestResult, PullRequestInfo, PrApproval, BuildStatus, BuildCheckRun } from "./types.js";
import { ConnectorError } from "./types.js";

/** Extract the TeamCity internal build ID from a TC build URL. */
function extractTeamCityBuildId(url: string): string | null {
  // viewLog.html?buildId=12345 or ?buildId=12345&...
  const m1 = url.match(/[?&]buildId=(\d+)/);
  if (m1) return m1[1];
  // /buildConfiguration/{configId}/12345 or /build/12345
  const m2 = url.match(/\/(?:buildConfiguration\/[^/?]+|build)\/(\d+)/);
  if (m2) return m2[1];
  return null;
}

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

  async getPrApprovals(repo: Repository, prId: string): Promise<PrApproval[]> {
    const { projectKey, repoSlug, baseUrl } = this.getProjectRepo(repo);

    try {
      const url = `${baseUrl}/rest/api/1.0/projects/${projectKey}/repos/${repoSlug}/pull-requests/${prId}/participants`;
      const response = await this.fetchJson<{
        values: Array<{
          user: { slug: string; displayName?: string };
          role: string;
          approved: boolean;
          status: "APPROVED" | "NEEDS_WORK" | "UNAPPROVED";
          lastReviewedCommit?: string;
        }>;
      }>(url);

      return response.values.map(p => ({
        userId: p.user.slug,
        state: p.status === "APPROVED" ? "approved" : p.status === "NEEDS_WORK" ? "changes_requested" : "pending",
        submittedAt: new Date().toISOString(),
      }));
    } catch (error) {
      throw new ConnectorError(
        `Failed to get PR approvals: ${error instanceof Error ? error.message : String(error)}`,
        "bitbucket-server",
        error
      );
    }
  }

  async getBuildStatus(repo: Repository, ref: string): Promise<BuildStatus> {
    const { baseUrl } = this.getProjectRepo(repo);

    const data = await this.fetchJson<{
      values: Array<{
        key: string;
        state: "SUCCESSFUL" | "FAILED" | "INPROGRESS";
        url: string;
        dateAdded: number;
        name?: string;
      }>;
      isLastPage: boolean;
    }>(`${baseUrl}/rest/build-status/1.0/commits/${ref}`);

    const checks: BuildCheckRun[] = data.values.map((v) => ({
      name: v.name ?? v.key,
      status:
        v.state === "SUCCESSFUL" ? "success"
        : v.state === "FAILED" ? "failure"
        : "pending",
      url: v.url,
      buildId: v.key,
      startedAt: v.dateAdded ? new Date(v.dateAdded).toISOString() : undefined,
    }));

    const overallState: BuildStatus["state"] =
      checks.some((c) => c.status === "failure") ? "failure"
      : checks.some((c) => c.status === "pending") ? "pending"
      : checks.length > 0 && checks.every((c) => c.status === "success")
      ? "success"
      : "unknown";

    return { state: overallState, checks };
  }

  async getBuildLogs(_repo: Repository, buildId: string, buildUrl?: string): Promise<string> {
    // Bitbucket Server does not store logs itself — delegate to the CI backend.

    const teamcityBase = process.env.TEAMCITY_URL?.replace(/\/$/, "");
    const teamcityToken = process.env.TEAMCITY_TOKEN;
    const jenkinsBase = process.env.JENKINS_URL?.replace(/\/$/, "");
    const jenkinsToken = process.env.JENKINS_TOKEN;

    // --- TeamCity ---
    if (teamcityBase && buildUrl && buildUrl.startsWith(teamcityBase)) {
      const tcBuildId = extractTeamCityBuildId(buildUrl) ?? buildId;
      const logUrl = `${teamcityBase}/app/rest/builds/id:${tcBuildId}/log`;
      try {
        const res = await fetch(logUrl, {
          headers: {
            Authorization: `Bearer ${teamcityToken ?? ""}`,
            Accept: "text/plain",
          },
        });
        if (res.ok) return res.text();
        return `TeamCity log fetch failed (${res.status}). View build at: ${buildUrl}`;
      } catch (err) {
        return `TeamCity log fetch error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // --- Jenkins ---
    if (jenkinsBase && buildUrl && buildUrl.startsWith(jenkinsBase)) {
      const logUrl = buildUrl.replace(/\/?$/, "/") + "consoleText";
      try {
        const headers: Record<string, string> = { "User-Agent": "multi-agent-harness" };
        if (jenkinsToken) {
          headers["Authorization"] = `Bearer ${jenkinsToken}`;
        }
        const res = await fetch(logUrl, { headers });
        if (res.ok) return res.text();
        return `Jenkins log fetch failed (${res.status}). View build at: ${buildUrl}`;
      } catch (err) {
        return `Jenkins log fetch error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (buildUrl) {
      return `Build logs available at CI system: ${buildUrl}`;
    }
    return `Build key: ${buildId} — set TEAMCITY_URL or JENKINS_URL to enable log fetching`;
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
}
