import type Dockerode from "dockerode";
import { randomUUID } from "crypto";
import type { Project, Repository, AgentSession, PlanTask, PullRequest } from "../models/types.js";
import { getProject } from "../store/projects.js";
import { getRepository } from "../store/repositories.js";
import { insertAgentSession, updateAgentSession, getAgentSession } from "../store/agents.js";
import { insertPullRequest } from "../store/pullRequests.js";
import { getConnector, ConnectorError } from "../connectors/types.js";
import { createSubAgentContainer, startContainer, removeContainer, getContainerStatus } from "../orchestrator/containerManager.js";
import { config } from "../config.js";
import { tracer } from "../telemetry.js";
import { SpanStatusCode } from "@opentelemetry/api";

export interface TaskResult {
  taskId: string;
  success: boolean;
  agentSessionId?: string;
  pullRequestId?: string;
  error?: string;
}

/**
 * Build "Closes #N" lines from an array of GitHub issue refs.
 * Accepts "owner/repo#123", "#123", or plain "123" formats.
 */
export function buildClosingRefs(githubIssues: string[]): string {
  return githubIssues
    .map(issue => {
      const m = issue.match(/#(\d+)$/);
      return m ? `Closes #${m[1]}` : null;
    })
    .filter(Boolean)
    .join("\n");
}

export class TaskDispatcher {
  private activeTasks = new Map<string, Promise<TaskResult>>();

  private static readonly TASK_PREAMBLE = `You are a software engineering sub-agent. Follow this workflow exactly.

## Step 1 — Understand the Task
Read the task description below carefully. If a plan file exists in the repository
at docs/superpowers/plans/, read it to understand the full project context before
starting.

## Step 2 — Test-Driven Development
Follow strict TDD. For every behaviour you implement:
1. Write a failing test first. Run it and confirm it fails for the right reason.
2. Write the minimum code to make it pass. Run it and confirm it passes.
3. Refactor. Keep tests green.
Never write production code without a failing test first.

## Step 3 — Implement
Work through the task description step by step. Commit logical units of work with
clear messages. Do not make changes beyond the scope of the task.

## Step 4 — Systematic Debugging
If you encounter a bug or unexpected behaviour:
1. Reproduce it reliably first.
2. Form a hypothesis about the root cause.
3. Test the hypothesis before attempting a fix.
4. Fix only after confirming the root cause.
Never guess-and-check. Root cause first, always.

## Step 5 — Verify Before Finishing
Before considering the task done:
1. Run the full test suite. Show the command and its output.
2. Confirm every acceptance criterion in the task description is met.
3. Do not claim completion without fresh evidence.
If verification fails, go back and fix — do not push broken code.

## Step 6 — Commit and Push

You are already checked out on the correct feature branch. Do NOT run \`git checkout -b\`
or create a new branch. Stage and commit all changes with clear commit messages. The
harness opens the pull request automatically — do NOT run \`gh pr create\`.

---

## Your Task

`;

  public buildTaskPrompt(task: PlanTask): string {
    return TaskDispatcher.TASK_PREAMBLE + task.description;
  }

  /**
   * Run a single task: create container, run sub-agent, wait for completion.
   * On retry, pass `existingSessionId` to reuse the session record instead of creating a new one.
   */
  public async runTask(
    docker: Dockerode,
    project: Project,
    task: PlanTask,
    existingSessionId?: string,
  ): Promise<TaskResult> {
    const repository = getRepository(task.repositoryId);
    if (!repository) {
      return {
        taskId: task.id,
        success: false,
        error: `Repository not found: ${task.repositoryId}`,
      };
    }

    const sessionId = existingSessionId ?? randomUUID();
    const isRetry = !!existingSessionId;
    const isPrimaryRepo = repository.id === project.primaryRepositoryId;
    const branchName = isPrimaryRepo && project.planningBranch
      ? project.planningBranch
      : `feature/${project.name.toLowerCase().replace(/\s+/g, "-")}-${task.id.slice(0, 8)}`;
    console.log(`[taskDispatcher] Starting task ${task.id} for project ${project.id}, repo ${repository.id}, branch ${branchName}`);

    // Create or reset the agent session record (upsert: insert on first run, update on retry)
    const agentSession: AgentSession = {
      id: sessionId,
      projectId: project.id,
      type: "sub",
      repositoryId: repository.id,
      taskId: task.id,
      status: "starting",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (isRetry && getAgentSession(sessionId)) {
      updateAgentSession(sessionId, {
        status: "starting",
        containerId: undefined,
        updatedAt: new Date().toISOString(),
      });
    } else {
      insertAgentSession(agentSession);
    }

    return tracer.startActiveSpan("container.run", async (span) => {
      let containerId: string | undefined;

      try {
        // Create branch via VCS connector
        console.log(`[taskDispatcher] Creating branch ${branchName} in repo ${repository.id}`);
        await this.createBranch(repository, branchName);
        console.log(`[taskDispatcher] Branch created, spinning up container`);

        // Create container
        // Build authenticated push URL with token embedded; the sub-agent runner uses this
        // for clone/push and deletes it from env before starting the AI session.
        const ghToken = process.env.GITHUB_TOKEN;
        const gitPushUrl = ghToken && repository.cloneUrl.startsWith("https://github.com/")
          ? repository.cloneUrl.replace("https://github.com/", `https://x-access-token:${ghToken}@github.com/`)
          : repository.cloneUrl;

        containerId = await createSubAgentContainer(docker, {
          sessionId,
          repoCloneUrl: repository.cloneUrl,
          gitPushUrl,
          branchName,
          taskDescription: this.buildTaskPrompt(task),
          taskId: task.id,
        });

        // Update session with container ID and record span attributes
        updateAgentSession(sessionId, { containerId, status: "running" });
        span.setAttributes({
          "container.id": containerId,
          "branch.name": branchName,
          "session.id": sessionId,
        });

        // Start container
        console.log(`[taskDispatcher] Starting container ${containerId}`);
        await startContainer(docker, containerId);

        // Stream container logs to backend stdout for observability
        this.streamContainerLogs(docker, containerId, `task-${task.id.slice(0, 8)}`);

        // Wait for completion
        console.log(`[taskDispatcher] Waiting for container to complete (timeout: ${config.subAgentTimeoutMs}ms)`);
        const completed = await this.waitForCompletion(docker, sessionId, containerId);
        console.log(`[taskDispatcher] Container completed: ${completed}`);

        if (!completed) {
          throw new Error("Task timed out or container failed");
        }

        // Update session status
        updateAgentSession(sessionId, { status: "completed" });
        span.setStatus({ code: SpanStatusCode.OK });

        // Try to create PR — non-fatal since the branch might have no new commits
        try {
          const pr = await this.createPr(project, repository, agentSession, branchName, task.description);
          return {
            taskId: task.id,
            success: true,
            agentSessionId: sessionId,
            pullRequestId: pr.id,
          };
        } catch (prErr) {
          console.warn(`[taskDispatcher] PR creation failed for task ${task.id} (non-fatal):`, prErr instanceof Error ? prErr.message : String(prErr));
          return {
            taskId: task.id,
            success: true,
            agentSessionId: sessionId,
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[taskDispatcher] Task ${task.id} failed:`, errorMessage);
        updateAgentSession(sessionId, { status: "failed" });
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
        span.recordException(error instanceof Error ? error : new Error(errorMessage));

        return {
          taskId: task.id,
          success: false,
          agentSessionId: sessionId,
          error: errorMessage,
        };
      } finally {
        span.end();
        // Cleanup container
        if (containerId) {
          try {
            await removeContainer(docker, containerId);
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    });
  }

  /**
   * Create a branch in the repository.
   */
  private async createBranch(repository: Repository, branchName: string): Promise<void> {
    const connector = getConnector(repository.provider);
    await connector.createBranch(repository, branchName, repository.defaultBranch);
  }

  /**
   * Wait for container completion or timeout.
   * Polls container status and session updates.
   */
  private async waitForCompletion(
    docker: Dockerode,
    sessionId: string,
    containerId: string,
    timeoutMs = config.subAgentTimeoutMs
  ): Promise<boolean> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      const checkInterval = setInterval(async () => {
        const elapsedSec = Math.round((Date.now() - startTime) / 1000);

        // Check timeout
        if (Date.now() - startTime > timeoutMs) {
          console.warn(`[taskDispatcher] waitForCompletion: timeout after ${elapsedSec}s for container ${containerId}`);
          clearInterval(checkInterval);
          resolve(false);
          return;
        }

        // Check container status
        const status = await getContainerStatus(docker, containerId);
        console.log(`[taskDispatcher] waitForCompletion: elapsed=${elapsedSec}s container=${containerId} status=${status}`);

        if (status === "exited") {
          clearInterval(checkInterval);
          resolve(true);
          return;
        }

        if (status === "unknown" || status === "stopped") {
          clearInterval(checkInterval);
          resolve(false);
          return;
        }

        // Check if session has been marked as completed via bridge
        const session = await this.getSessionStatus(sessionId);
        if (session === "completed") {
          clearInterval(checkInterval);
          resolve(true);
          return;
        }
        if (session === "failed") {
          clearInterval(checkInterval);
          resolve(false);
          return;
        }
      }, 5000); // Check every 5 seconds
    });
  }

  /**
   * Get session status from store.
   */
  private async getSessionStatus(sessionId: string): Promise<AgentSession["status"] | null> {
    const { getAgentSession } = await import("../store/agents.js");
    const session = getAgentSession(sessionId);
    return session?.status ?? null;
  }

  /**
   * Create a PR via VCS connector after task completes.
   */
  private async createPr(
    project: Project,
    repository: Repository,
    agentSession: AgentSession,
    branchName: string,
    description: string
  ): Promise<PullRequest> {
    const connector = getConnector(repository.provider);

    const closingRefs = buildClosingRefs(project.source?.githubIssues ?? []);

    let prResult;
    try {
      prResult = await connector.createPullRequest(repository, {
        title: `[${project.name}] ${description.slice(0, 50)}${description.length > 50 ? "..." : ""}`,
        description: `Task: ${description}\n\nProject: ${project.name}\nAgent Session: ${agentSession.id}${closingRefs ? "\n\n" + closingRefs : ""}`,
        headBranch: branchName,
        baseBranch: repository.defaultBranch,
      });
    } catch (err) {
      // If a PR already exists for this branch (common when reusing the planning branch),
      // find and register the existing one instead of failing.
      if (err instanceof ConnectorError && err.message.toLowerCase().includes("already exists")) {
        const existing = await connector.findPullRequestByBranch(repository, branchName);
        if (existing) {
          console.log(`[taskDispatcher] PR already exists for branch ${branchName}, registering existing PR ${existing.id}`);
          prResult = existing;
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    const pullRequest: PullRequest = {
      id: randomUUID(),
      projectId: project.id,
      repositoryId: repository.id,
      agentSessionId: agentSession.id,
      provider: repository.provider,
      externalId: prResult.id,
      url: prResult.url,
      branch: branchName,
      status: "open",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    insertPullRequest(pullRequest);

    return pullRequest;
  }

  /**
   * Re-prompt sub-agent for batched review comments (fix-run).
   * This is called when review comments need to be addressed.
   */
  async runFixRun(
    docker: Dockerode,
    projectId: string,
    pullRequestId: string,
    comments: Array<{ body: string; filePath?: string; lineNumber?: number }>
  ): Promise<TaskResult> {
    const project = getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const { getPullRequest } = await import("../store/pullRequests.js");
    const pr = getPullRequest(pullRequestId);
    if (!pr) {
      throw new Error(`Pull request not found: ${pullRequestId}`);
    }

    const repository = getRepository(pr.repositoryId);
    if (!repository) {
      throw new Error(`Repository not found: ${pr.repositoryId}`);
    }

    // Format comments for the sub-agent
    const commentsText = comments
      .map(c => {
        let text = `- ${c.body}`;
        if (c.filePath) {
          text += ` (${c.filePath}${c.lineNumber ? `:${c.lineNumber}` : ""})`;
        }
        return text;
      })
      .join("\n");

    const sessionId = randomUUID();

    // Create agent session for fix-run
    const agentSession: AgentSession = {
      id: sessionId,
      projectId: project.id,
      type: "sub",
      repositoryId: repository.id,
      status: "starting",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    insertAgentSession(agentSession);

    let containerId: string | undefined;

    try {
      // Create container for fix-run (using existing branch)
      const taskDescription = `Address the following code review comments on the pull request branch "${pr.branch}":\n\n${commentsText}\n\nMake any necessary code changes and ensure the changes are committed.`;

      const ghToken = process.env.GITHUB_TOKEN;
      const fixGitPushUrl = ghToken && repository.cloneUrl.startsWith("https://github.com/")
        ? repository.cloneUrl.replace("https://github.com/", `https://x-access-token:${ghToken}@github.com/`)
        : repository.cloneUrl;

      containerId = await createSubAgentContainer(docker, {
        sessionId,
        repoCloneUrl: repository.cloneUrl,
        gitPushUrl: fixGitPushUrl,
        branchName: pr.branch,
        taskDescription,
        taskId: `fix-${sessionId.slice(0, 8)}`,
      });

      updateAgentSession(sessionId, { containerId, status: "running" });
      await startContainer(docker, containerId);

      // Stream container logs to backend stdout for observability
      this.streamContainerLogs(docker, containerId, `fix-${sessionId.slice(0, 8)}`);

      // Wait for completion
      const completed = await this.waitForCompletion(docker, sessionId, containerId);

      if (!completed) {
        throw new Error("Fix-run timed out or container failed");
      }

      updateAgentSession(sessionId, { status: "completed" });

      // Update PR with comment about fixes
      const connector = getConnector(repository.provider);
      await connector.addComment(repository, pr.externalId, "Addressed review comments");

      return {
        taskId: sessionId,
        success: true,
        agentSessionId: sessionId,
        pullRequestId: pr.id,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      updateAgentSession(sessionId, { status: "failed" });

      return {
        taskId: sessionId,
        success: false,
        agentSessionId: sessionId,
        error: errorMessage,
      };
    } finally {
      if (containerId) {
        try {
          await removeContainer(docker, containerId);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Stream container stdout/stderr to backend process stdout for observability.
   */
  private streamContainerLogs(docker: Dockerode, containerId: string, label: string): void {
    docker.getContainer(containerId).logs(
      { follow: true, stdout: true, stderr: true, timestamps: false },
      (err, stream) => {
        if (err || !stream) return;
        docker.modem.demuxStream(
          stream as NodeJS.ReadableStream,
          {
            write: (chunk: Buffer) => {
              for (const line of chunk.toString().split("\n")) {
                if (line.trim()) console.log(`[container:${label}] ${line}`);
              }
            },
          } as NodeJS.WritableStream,
          {
            write: (chunk: Buffer) => {
              for (const line of chunk.toString().split("\n")) {
                if (line.trim()) console.error(`[container:${label}] ${line}`);
              }
            },
          } as NodeJS.WritableStream
        );
      }
    );
  }

  /**
   * Get active task count.
   */
  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }
}
