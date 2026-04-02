import { Octokit } from "@octokit/rest";
import type { Repository, VcsComment } from "../models/types.js";
import type { VcsConnector, CreatePullRequestParams, PullRequestResult, PullRequestInfo, PrApproval, BuildStatus, BuildCheckRun } from "./types.js";
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

      try {
        await octokit.git.createRef({
          owner,
          repo: repoName,
          ref: `refs/heads/${branchName}`,
          sha: refData.object.sha,
        });
      } catch (refErr: unknown) {
        const msg = refErr instanceof Error ? refErr.message : String(refErr);
        if (!msg.includes("Reference already exists")) {
          throw new ConnectorError(`Failed to create branch: ${msg}`, "github", refErr);
        }
        // Branch already exists — that's fine for idempotent calls
      }
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
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

  async findPullRequestByBranch(repo: Repository, headBranch: string): Promise<PullRequestResult | null> {
    const octokit = this.getOctokit();
    const { owner, repoName } = this.getOwnerRepo(repo);
    try {
      const { data } = await octokit.pulls.list({
        owner,
        repo: repoName,
        head: `${owner}:${headBranch}`,
        state: "open",
      });
      if (data.length === 0) return null;
      return { id: String(data[0].number), url: data[0].html_url };
    } catch {
      return null;
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

  async getPrApprovals(repo: Repository, prId: string): Promise<PrApproval[]> {
    const octokit = this.getOctokit();
    const { owner, repoName } = this.getOwnerRepo(repo);

    try {
      const { data } = await octokit.pulls.listReviews({
        owner,
        repo: repoName,
        pull_number: parseInt(prId, 10),
      });
      return data.map(r => ({
        userId: r.user?.login ?? "",
        state: r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "changes_requested" : "pending",
        submittedAt: r.submitted_at ?? new Date().toISOString(),
      }));
    } catch (error) {
      throw new ConnectorError(
        `Failed to get PR approvals: ${error instanceof Error ? error.message : String(error)}`,
        "github",
        error
      );
    }
  }

  async getBuildStatus(repo: Repository, ref: string): Promise<BuildStatus> {
    const octokit = this.getOctokit();
    const { owner, repoName } = this.getOwnerRepo(repo);

    const { data } = await octokit.checks.listForRef({
      owner,
      repo: repoName,
      ref,
      per_page: 100,
    });

    const checks: BuildCheckRun[] = data.check_runs.map((run) => ({
      name: run.name,
      status:
        run.conclusion === "success" ? "success"
        : run.conclusion === "failure" || run.conclusion === "timed_out"
          ? "failure"
        : run.conclusion === "skipped" || run.conclusion === "neutral"
          ? "skipped"
        : "pending",
      url: run.html_url ?? "",
      buildId: String(run.id),
      startedAt: run.started_at ?? undefined,
      completedAt: run.completed_at ?? undefined,
    }));

    const overallState: BuildStatus["state"] =
      checks.some((c) => c.status === "failure") ? "failure"
      : checks.some((c) => c.status === "pending") ? "pending"
      : checks.length > 0 &&
        checks.every((c) => c.status === "success" || c.status === "skipped")
      ? "success"
      : "unknown";

    return { state: overallState, checks };
  }

  async getBuildLogs(repo: Repository, buildId: string, buildUrl?: string): Promise<string> {
    const { owner, repoName } = this.getOwnerRepo(repo);
    const token = this.getToken();

    // --- Jenkins: if the check run URL points to a Jenkins instance, fetch console output ---
    const jenkinsBase = process.env.JENKINS_URL?.replace(/\/$/, "");
    const jenkinsToken = process.env.JENKINS_TOKEN;
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

    // --- GitHub Actions: fetch job logs via Actions API ---
    try {
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/actions/jobs/${buildId}/logs`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
          },
          redirect: "follow",
        }
      );
      if (response.ok) {
        return await response.text();
      }
    } catch {
      // fall through to URL fallback
    }

    // Fallback: return the check run details URL
    try {
      const octokit = this.getOctokit();
      const { data } = await octokit.checks.get({
        owner,
        repo: repoName,
        check_run_id: parseInt(buildId, 10),
      });
      return `Logs available at: ${data.details_url ?? data.html_url}`;
    } catch {
      return `Logs not available for check run ${buildId}`;
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
    const octokit = this.getOctokit();
    const { owner, repoName } = this.getOwnerRepo(repo);
    const authorName = process.env.GIT_COMMIT_AUTHOR_NAME ?? "Harness Bot";
    const authorEmail = process.env.GIT_COMMIT_AUTHOR_EMAIL ?? "harness@noreply";

    try {
      if (createBranch) {
        await this.createBranch(repo, branch, repo.defaultBranch);
      }

      // Get existing file SHA if the file already exists (needed for update)
      let fileSha: string | undefined;
      try {
        const { data } = await octokit.repos.getContent({ owner, repo: repoName, path, ref: branch });
        if (!Array.isArray(data) && data.type === "file") {
          fileSha = data.sha;
        }
      } catch {
        // File does not exist yet — that's fine for a create
      }

      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo: repoName,
        path,
        message,
        content: Buffer.from(content, "utf-8").toString("base64"),
        branch,
        ...(fileSha ? { sha: fileSha } : {}),
        author: { name: authorName, email: authorEmail },
        committer: { name: authorName, email: authorEmail },
      });
    } catch (error) {
      throw new ConnectorError(
        `Failed to commit file: ${error instanceof Error ? error.message : String(error)}`,
        "github",
        error
      );
    }
  }
}
