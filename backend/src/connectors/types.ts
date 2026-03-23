import type { Repository, VcsComment } from "../models/types.js";
import { GitHubConnector } from "./github.js";
import { BitbucketConnector } from "./bitbucket.js";

export interface CreatePullRequestParams {
  title: string;
  description: string;
  headBranch: string;
  baseBranch: string;
}

export interface PullRequestResult {
  id: string;
  url: string;
}

export interface PullRequestInfo {
  status: "open" | "merged" | "declined";
  url: string;
}

export interface VcsConnector {
  /**
   * Create a new branch in the repository
   */
  createBranch(repo: Repository, branchName: string, fromRef: string): Promise<void>;

  /**
   * Create a pull request
   */
  createPullRequest(repo: Repository, params: CreatePullRequestParams): Promise<PullRequestResult>;

  /**
   * Get pull request information
   */
  getPullRequest(repo: Repository, prId: string): Promise<PullRequestInfo>;

  /**
   * Find an open pull request by head branch. Returns null if not found.
   */
  findPullRequestByBranch(repo: Repository, headBranch: string): Promise<PullRequestResult | null>;

  /**
   * Get review comments on a pull request
   * @param since - Optional ISO timestamp to filter comments since a specific time
   */
  getComments(repo: Repository, prId: string, since?: string): Promise<VcsComment[]>;

  /**
   * Add a comment to a pull request
   */
  addComment(repo: Repository, prId: string, body: string): Promise<void>;

  /**
   * Commit a file to a branch. Creates the branch from defaultBranch first
   * if createBranch is true.
   */
  commitFile(
    repo: Repository,
    branch: string,
    path: string,
    content: string,
    message: string,
    createBranch?: boolean
  ): Promise<void>;
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export function getConnector(provider: string): VcsConnector {
  switch (provider) {
    case "github":
      return new GitHubConnector();
    case "bitbucket-server":
      return new BitbucketConnector();
    default:
      throw new ConnectorError(`Unsupported provider: ${provider}`, provider);
  }
}
