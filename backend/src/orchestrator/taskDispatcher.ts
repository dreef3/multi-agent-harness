import type Dockerode from "dockerode";
import { randomUUID } from "crypto";
import type { Project, Repository, AgentSession, PlanTask, PullRequest } from "../models/types.js";
import { getProject, updateProject } from "../store/projects.js";
import { getRepository } from "../store/repositories.js";
import { insertAgentSession, updateAgentSession } from "../store/agents.js";
import { insertPullRequest } from "../store/pullRequests.js";
import { getConnector } from "../connectors/types.js";
import { createSubAgentContainer, startContainer, removeContainer, getContainerStatus } from "../orchestrator/containerManager.js";
import { SubAgentBridge } from "../agents/subAgentBridge.js";
import { config } from "../config.js";

export interface TaskResult {
  taskId: string;
  success: boolean;
  agentSessionId?: string;
  pullRequestId?: string;
  error?: string;
}

export class TaskDispatcher {
  private activeTasks = new Map<string, Promise<TaskResult>>();

  /**
   * Dispatch all tasks from an approved plan for a project.
   * Launches all tasks in parallel.
   */
  async dispatchTasks(docker: Dockerode, projectId: string): Promise<TaskResult[]> {
    const project = getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (!project.plan || !project.plan.approved) {
      throw new Error(`Project ${projectId} does not have an approved plan`);
    }

    if (project.plan.tasks.length === 0) {
      return [];
    }

    // Launch all tasks in parallel
    const taskPromises = project.plan.tasks.map(task =>
      this.runTask(docker, project, task)
    );

    const results = await Promise.all(taskPromises);

    // Update project status if all tasks completed
    const allCompleted = results.every(r => r.success);
    if (allCompleted) {
      updateProject(projectId, { status: "completed" });
    } else if (results.some(r => !r.success)) {
      updateProject(projectId, { status: "failed" });
    }

    return results;
  }

  /**
   * Run a single task: create container, run sub-agent, wait for completion.
   */
  private async runTask(docker: Dockerode, project: Project, task: PlanTask): Promise<TaskResult> {
    const repository = getRepository(task.repositoryId);
    if (!repository) {
      return {
        taskId: task.id,
        success: false,
        error: `Repository not found: ${task.repositoryId}`,
      };
    }

    const sessionId = randomUUID();
    const branchName = `feature/${project.name.toLowerCase().replace(/\s+/g, "-")}-${task.id.slice(0, 8)}`;
    console.log(`[taskDispatcher] Starting task ${task.id} for project ${project.id}, repo ${repository.id}, branch ${branchName}`);

    // Create agent session record
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
    insertAgentSession(agentSession);

    let containerId: string | undefined;

    try {
      // Create branch via VCS connector
      console.log(`[taskDispatcher] Creating branch ${branchName} in repo ${repository.id}`);
      await this.createBranch(repository, branchName);
      console.log(`[taskDispatcher] Branch created, spinning up container`);

      // Create container
      containerId = await createSubAgentContainer(docker, {
        sessionId,
        repoCloneUrl: repository.cloneUrl,
        branchName,
        taskDescription: task.description,
      });

      // Update session with container ID
      updateAgentSession(sessionId, { containerId, status: "running" });

      // Start container
      console.log(`[taskDispatcher] Starting container ${containerId}`);
      await startContainer(docker, containerId);

      // Wait for completion
      console.log(`[taskDispatcher] Waiting for container to complete (timeout: ${config.subAgentTimeoutMs}ms)`);
      const completed = await this.waitForCompletion(docker, sessionId, containerId);
      console.log(`[taskDispatcher] Container completed: ${completed}`);

      if (!completed) {
        throw new Error("Task timed out or container failed");
      }

      // Update session status
      updateAgentSession(sessionId, { status: "completed" });

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

      return {
        taskId: task.id,
        success: false,
        agentSessionId: sessionId,
        error: errorMessage,
      };
    } finally {
      // Cleanup container
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
        // Check timeout
        if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          resolve(false);
          return;
        }

        // Check container status
        const status = await getContainerStatus(docker, containerId);

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

    const prResult = await connector.createPullRequest(repository, {
      title: `[${project.name}] ${description.slice(0, 50)}${description.length > 50 ? "..." : ""}`,
      description: `Task: ${description}\n\nProject: ${project.name}\nAgent Session: ${agentSession.id}`,
      headBranch: branchName,
      baseBranch: repository.defaultBranch,
    });

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
      containerId = await createSubAgentContainer(docker, {
        sessionId,
        repoCloneUrl: repository.cloneUrl,
        branchName: pr.branch,
      });

      updateAgentSession(sessionId, { containerId, status: "running" });
      await startContainer(docker, containerId);

      // Attach to container to send fix instructions
      const bridge = new SubAgentBridge();
      await bridge.attach(docker, containerId);

      // Send fix instructions
      bridge.send({
        type: "fix",
        comments: commentsText,
      });

      // Wait for completion
      const completed = await this.waitForCompletion(docker, sessionId, containerId);

      bridge.detach();

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
   * Get active task count.
   */
  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }
}
