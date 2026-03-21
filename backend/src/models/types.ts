// All domain interfaces for the multi-agent harness

export interface Project {
  id: string;
  name: string;
  status:
    | "brainstorming"
    | "planning"
    | "awaiting_approval"
    | "executing"
    | "completed"
    | "failed"
    | "cancelled";
  source: {
    type: "jira" | "freeform" | "github";
    jiraTickets?: string[];
    githubIssues?: string[];          // e.g. ["owner/repo#123"]
    freeformDescription?: string;
  };
  repositoryIds: string[];
  plan?: Plan;
  masterSessionPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface Plan {
  id: string;
  projectId: string;
  content: string;
  tasks: PlanTask[];
  approved: boolean;
  approvedAt?: string;
}

export interface PlanTask {
  id: string;
  repositoryId: string;
  description: string;
  status: "pending" | "executing" | "completed" | "failed" | "cancelled";
  dependsOn?: string[]; // MVP: unused, all tasks execute in parallel
}

export interface Repository {
  id: string;
  name: string;
  cloneUrl: string;
  provider: "github" | "bitbucket-server";
  providerConfig: {
    owner?: string;        // GitHub
    repo?: string;         // GitHub
    projectKey?: string;   // Bitbucket Server
    repoSlug?: string;     // Bitbucket Server
    baseUrl?: string;      // Bitbucket Server
  };
  defaultBranch: string;
  // Auth resolved from env at runtime: GITHUB_TOKEN, BITBUCKET_TOKEN
  createdAt: string;
  updatedAt: string;
}

export interface AgentSession {
  id: string;
  projectId: string;
  type: "master" | "sub";
  repositoryId?: string;
  taskId?: string;
  containerId?: string;
  status: "starting" | "running" | "completed" | "failed" | "stopped";
  sessionPath?: string; // enables resume
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: string;
  projectId: string;
  repositoryId: string;
  agentSessionId: string;
  provider: "github" | "bitbucket-server";
  externalId: string;
  url: string;
  branch: string;
  status: "open" | "merged" | "declined";
  createdAt: string;
  updatedAt: string;
}

export interface ReviewComment {
  id: string;
  pullRequestId: string;
  externalId: string;
  author: string;
  body: string;
  filePath?: string;
  lineNumber?: number;
  status: "pending" | "batched" | "fixing" | "fixed" | "ignored";
  receivedAt: string;
  updatedAt: string;
}

export interface VcsComment {
  id: string;
  author: string;
  body: string;
  filePath?: string;
  lineNumber?: number;
  createdAt: string;
}

export interface DebounceConfig {
  strategy: "timer";
  delayMs: number; // default 600000 (10 minutes)
}
