export interface TraceRequirement {
  id: string;
  summary: string;
  section?: string;
}

export interface TraceToolCall {
  tool: string;
  file?: string;
  timestamp: string;
}

export interface TraceAttempt {
  attemptNumber: number;
  startedAt: string;
  completedAt?: string;
  toolCalls: TraceToolCall[];
  commits: Array<{ sha: string; message: string }>;
  ci?: {
    state: "pending" | "success" | "failure" | "error";
    checks: Array<{ name: string; state: string; url?: string }>;
  };
}

export interface TraceTask {
  id: string;
  requirementIds: string[];
  description: string;
  status: "pending" | "executing" | "completed" | "failed";
  attempts: TraceAttempt[];
}

export interface TracePullRequest {
  taskIds: string[];
  url: string;
  branch: string;
  state: "open" | "merged" | "declined";
}

export interface Trace {
  version: "1.0";
  project: {
    id: string;
    name: string;
    status: string;
    specApprovedAt?: string;
    specApprovedBy?: string;
    planApprovedAt?: string;
    planApprovedBy?: string;
  };
  requirements: TraceRequirement[];
  tasks: TraceTask[];
  planningPr?: { url: string; number: number };
  pullRequests: TracePullRequest[];
  createdAt: string;
  updatedAt: string;
}

export class TraceBuilder {
  private trace: Trace;

  constructor(projectId: string, projectName: string) {
    this.trace = {
      version: "1.0",
      project: { id: projectId, name: projectName, status: "brainstorming" },
      requirements: [],
      tasks: [],
      pullRequests: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  setProjectStatus(status: string): this {
    this.trace.project.status = status;
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  setSpecApproved(approvedAt: string, approvedBy?: string): this {
    this.trace.project.specApprovedAt = approvedAt;
    this.trace.project.specApprovedBy = approvedBy;
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  setPlanApproved(approvedAt: string, approvedBy?: string): this {
    this.trace.project.planApprovedAt = approvedAt;
    this.trace.project.planApprovedBy = approvedBy;
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  setRequirements(reqs: TraceRequirement[]): this {
    this.trace.requirements = reqs;
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  upsertTask(taskId: string, description: string, requirementIds: string[] = []): this {
    const existing = this.trace.tasks.find(t => t.id === taskId);
    if (!existing) {
      this.trace.tasks.push({
        id: taskId,
        description,
        requirementIds,
        status: "pending",
        attempts: [],
      });
    }
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  setTaskStatus(taskId: string, status: TraceTask["status"]): this {
    const task = this.trace.tasks.find(t => t.id === taskId);
    if (task) task.status = status;
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  recordTaskAttempt(taskId: string, attemptNumber: number): this {
    const task = this.trace.tasks.find(t => t.id === taskId);
    if (!task) return this;
    const existing = task.attempts.find(a => a.attemptNumber === attemptNumber);
    if (!existing) {
      task.attempts.push({
        attemptNumber,
        startedAt: new Date().toISOString(),
        toolCalls: [],
        commits: [],
      });
    }
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  recordTaskComplete(taskId: string): this {
    const task = this.trace.tasks.find(t => t.id === taskId);
    if (task) {
      task.status = "completed";
      const lastAttempt = task.attempts[task.attempts.length - 1];
      if (lastAttempt && !lastAttempt.completedAt) {
        lastAttempt.completedAt = new Date().toISOString();
      }
    }
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  recordTaskFailed(taskId: string): this {
    const task = this.trace.tasks.find(t => t.id === taskId);
    if (task) {
      task.status = "failed";
      const lastAttempt = task.attempts[task.attempts.length - 1];
      if (lastAttempt && !lastAttempt.completedAt) {
        lastAttempt.completedAt = new Date().toISOString();
      }
    }
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  setPlanningPr(url: string, number: number): this {
    this.trace.planningPr = { url, number };
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  recordCiResult(
    taskId: string,
    attemptNumber: number,
    ci: TraceAttempt["ci"]
  ): this {
    const task = this.trace.tasks.find(t => t.id === taskId);
    if (!task) return this;
    const attempt = task.attempts.find(a => a.attemptNumber === attemptNumber);
    if (attempt) attempt.ci = ci;
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  upsertPullRequest(pr: TracePullRequest): this {
    const existing = this.trace.pullRequests.find(p => p.url === pr.url);
    if (existing) {
      Object.assign(existing, pr);
    } else {
      this.trace.pullRequests.push(pr);
    }
    this.trace.updatedAt = new Date().toISOString();
    return this;
  }

  toJSON(): Trace {
    return structuredClone(this.trace);
  }
}

// ── In-memory registry — one TraceBuilder per project ───────────────────────

const traceRegistry = new Map<string, TraceBuilder>();

export function getOrCreateTrace(projectId: string, projectName: string): TraceBuilder {
  if (!traceRegistry.has(projectId)) {
    traceRegistry.set(projectId, new TraceBuilder(projectId, projectName));
  }
  return traceRegistry.get(projectId)!;
}

export function getTrace(projectId: string): TraceBuilder | undefined {
  return traceRegistry.get(projectId);
}

export function clearTrace(projectId: string): void {
  traceRegistry.delete(projectId);
}

/**
 * Persist the current trace as .harness/trace.json on the project's planning branch.
 * Non-fatal — trace persistence never blocks the main workflow.
 */
export async function persistTrace(
  projectId: string,
  projectName: string,
  planningBranch: string,
  connector: import("../connectors/types.js").VcsConnector,
  repo: import("../models/types.js").Repository,
): Promise<void> {
  const builder = getOrCreateTrace(projectId, projectName);
  const traceJson = JSON.stringify(builder.toJSON(), null, 2);
  try {
    await connector.commitFile(
      repo,
      planningBranch,
      ".harness/trace.json",
      traceJson,
      "chore: update harness trace",
    );
  } catch (err) {
    console.warn(`[traceBuilder] Failed to persist trace.json for project ${projectId}:`, err);
  }
}
