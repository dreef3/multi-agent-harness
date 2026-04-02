import { randomUUID } from "crypto";
import type { Project, Repository, AgentSession, PlanTask, PullRequest } from "../models/types.js";
import { getProject } from "../store/projects.js";
import { getRepository } from "../store/repositories.js";
import { insertAgentSession, updateAgentSession, getAgentSession } from "../store/agents.js";
import { insertPullRequest } from "../store/pullRequests.js";
import { getConnector, ConnectorError } from "../connectors/types.js";
import type { BuildStatus } from "../connectors/types.js";
import { getOrCreateTrace } from "./traceBuilder.js";
import type { ContainerRuntime } from "./containerRuntime.js";
import { config } from "../config.js";
import { tracer } from "../telemetry.js";
import { SpanStatusCode } from "@opentelemetry/api";

// All provider API key env vars supported by pi-coding-agent
const PROVIDER_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "OPENCODE_API_KEY",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  // Git / VCS credentials intentionally excluded — sub-agent gets GIT_PUSH_URL instead
  // Cloud providers
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
];

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
  private readonly runtime: ContainerRuntime;

  constructor(containerRuntime: ContainerRuntime) {
    this.runtime = containerRuntime;
  }

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
    project: Project,
    task: PlanTask,
    existingSessionId?: string,
  ): Promise<TaskResult> {
    const repository = await getRepository(task.repositoryId);
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
    if (isRetry && await getAgentSession(sessionId)) {
      await updateAgentSession(sessionId, {
        status: "starting",
        containerId: undefined,
        updatedAt: new Date().toISOString(),
      });
    } else {
      await insertAgentSession(agentSession);
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

        const taskName = task.description
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 30)
          .replace(/-+$/g, "");

        const nameSuffix = taskName
          ? `${taskName}-${(task.id ?? sessionId).slice(0, 8)}`
          : (task.id ?? sessionId).slice(0, 16);
        const containerName = `sub-${nameSuffix}`;

        const agentProvider = config.agentProvider;
        const agentModel = config.implementationModel;
        const providerEnv = PROVIDER_ENV_VARS
          .filter(name => process.env[name])
          .map(name => `${name}=${process.env[name]}`);
        const taskEnv = [
          `TASK_DESCRIPTION=${this.buildTaskPrompt(task)}`,
          `TASK_COMMIT_MSG=feat: ${task.description.slice(0, 60)}`,
          ...(gitPushUrl ? [`GIT_PUSH_URL=${gitPushUrl}`] : []),
          `AGENT_PROVIDER=${agentProvider}`,
          `AGENT_MODEL=${agentModel}`,
          `TASK_ID=${task.id ?? ""}`,
          `HARNESS_API_URL=${config.harnessApiUrl}`,
          `AGENT_SESSION_ID=${sessionId}`,
          ...(config.repoCacheVolume ? [`REPO_CACHE_DIR=/cache`] : []),
        ];

        const presentProviderKeys = PROVIDER_ENV_VARS.filter(name => process.env[name]);
        console.log(`[taskDispatcher] Creating container for session=${sessionId} taskId=${task.id ?? "n/a"}`);
        console.log(`[taskDispatcher]   image=${config.subAgentImage}`);
        console.log(`[taskDispatcher]   network=${config.subAgentNetwork}`);
        console.log(`[taskDispatcher]   branch=${branchName}`);
        console.log(`[taskDispatcher]   agentProvider=${agentProvider} agentModel=${agentModel}`);
        console.log(`[taskDispatcher]   providerEnvVars present: [${presentProviderKeys.join(", ")}]`);
        console.log(`[taskDispatcher]   memory=${config.subAgentMemoryBytes} cpuCount=${config.subAgentCpuCount}`);

        containerId = await this.runtime.createContainer({
          sessionId,
          image: config.subAgentImage,
          name: containerName,
          env: [
            `REPO_CLONE_URL=${repository.cloneUrl}`,
            `BRANCH_NAME=${branchName}`,
            ...taskEnv,
            ...providerEnv,
          ],
          // On Docker: host path is a named volume or absolute path.
          // On Kubernetes (CONTAINER_RUNTIME=kubernetes): host path is treated as a PVC claim name.
          binds: [
            `${config.piAgentVolume}:/pi-agent`,
            ...(config.repoCacheVolume ? [`${config.repoCacheVolume}:/cache`] : []),
          ],
          memoryBytes: config.subAgentMemoryBytes,
          nanoCpus: config.subAgentCpuCount * 1_000_000_000,
          // On Docker: used to attach container to the harness bridge network.
          // On Kubernetes: ignored — pods communicate via cluster networking (Pod IPs).
          // Getting the planning agent's Pod IP for pod-to-pod comms is a follow-up task.
          networkMode: config.subAgentNetwork,
          capDrop: ["ALL"],
          securityOpt: ["no-new-privileges:true"],
          readonlyRootfs: config.subAgentReadOnlyRootfs ?? false,
          tmpfs: config.subAgentReadOnlyRootfs
            ? { "/tmp": "rw,noexec,nosuid,size=128m", "/run": "rw,noexec,nosuid,size=32m" }
            : undefined,
          workingDir: "/workspace",
        });

        // Update session with container ID and record span attributes
        await updateAgentSession(sessionId, { containerId, status: "running" });
        span.setAttributes({
          "container.id": containerId,
          "branch.name": branchName,
          "session.id": sessionId,
        });

        // Start container
        console.log(`[taskDispatcher] Starting container ${containerId}`);
        await this.runtime.startContainer(containerId);

        // Stream container logs to backend stdout for observability
        this.streamContainerLogs(containerId, `sub-${task.id.slice(0, 8)}`);

        // Wait for completion
        console.log(`[taskDispatcher] Waiting for container to complete (timeout: ${config.subAgentTimeoutMs}ms)`);
        const completed = await this.waitForCompletion(sessionId, containerId);
        console.log(`[taskDispatcher] Container completed: ${completed}`);

        if (!completed) {
          throw new Error("Task timed out or container failed");
        }

        // Update session status
        await updateAgentSession(sessionId, { status: "completed" });
        span.setStatus({ code: SpanStatusCode.OK });

        // ── CI-aware completion ───────────────────────────────────────────────
        if (config.waitForCi) {
          console.log(
            `[taskDispatcher] WAIT_FOR_CI=true — polling CI for branch ${branchName}`
          );

          const { passed, status: ciStatus } = await this.waitForPrCi(
            repository,
            branchName
          );

          this.recordCiResultInTrace(project, task, 1, passed, ciStatus);

          if (!passed) {
            await updateAgentSession(sessionId, { status: "failed" });
            throw new Error(
              `CI checks failed on branch ${branchName}: ${
                ciStatus.checks
                  .filter((c) => c.status === "failure")
                  .map((c) => c.name)
                  .join(", ") || "timeout or unknown"
              }`
            );
          }

          console.log(
            `[taskDispatcher] CI passed for branch ${branchName} — proceeding with PR`
          );
        }
        // ── End CI-aware completion ───────────────────────────────────────────

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
        await updateAgentSession(sessionId, { status: "failed" });
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
            await this.runtime.removeContainer(containerId);
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    });
  }

  /**
   * Polls the CI build status for the given branch until it resolves to
   * success or failure, or until the timeout is reached.
   */
  private async waitForPrCi(
    repository: Repository,
    branchName: string,
    timeoutMs: number = config.ciWaitTimeoutMs
  ): Promise<{ passed: boolean; status: BuildStatus }> {
    const connector = getConnector(repository.provider);
    const startTime = Date.now();
    let lastStatus: BuildStatus = { state: "unknown", checks: [] };

    while (Date.now() - startTime < timeoutMs) {
      try {
        lastStatus = await connector.getBuildStatus(repository, branchName);
      } catch (err) {
        console.warn(`[taskDispatcher] getBuildStatus error for branch ${branchName}:`, err);
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        continue;
      }

      if (lastStatus.state === "success") {
        console.log(`[taskDispatcher] CI passed for branch ${branchName}`);
        return { passed: true, status: lastStatus };
      }

      if (lastStatus.state === "failure") {
        const failedChecks = lastStatus.checks
          .filter((c) => c.status === "failure")
          .map((c) => c.name)
          .join(", ");
        console.warn(
          `[taskDispatcher] CI failed for branch ${branchName}. Failing checks: ${failedChecks}`
        );
        return { passed: false, status: lastStatus };
      }

      if (lastStatus.state === "unknown" && lastStatus.checks.length === 0) {
        // No CI checks configured for this repo/branch — treat as passing
        console.log(
          `[taskDispatcher] No CI checks found for branch ${branchName} — assuming pass`
        );
        return { passed: true, status: lastStatus };
      }

      // state === "pending" — wait and retry
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(
        `[taskDispatcher] CI pending for branch ${branchName} (${elapsed}s elapsed), waiting 30s...`
      );
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }

    // Timeout
    console.warn(
      `[taskDispatcher] CI wait timeout after ${timeoutMs}ms for branch ${branchName}. Treating as failure.`
    );
    return { passed: false, status: lastStatus };
  }

  private recordCiResultInTrace(
    project: Project,
    task: PlanTask,
    attemptNumber: number,
    passed: boolean,
    status: BuildStatus
  ): void {
    try {
      const trace = getOrCreateTrace(project.id, project.name);
      trace.recordCiResult(task.id, attemptNumber, {
        state: passed ? "success" : (status.state === "failure" ? "failure" : "error"),
        checks: status.checks.map((c) => ({
          name: c.name,
          state: c.status,
          url: c.url,
        })),
      });
      // Note: full persistTrace (commit to VCS) happens during PR creation.
      // CI result is recorded in-memory here so it's included when that persist runs.
    } catch (err) {
      console.warn("[taskDispatcher] Failed to record CI result in trace:", err);
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
    sessionId: string,
    containerId: string,
    timeoutMs = config.subAgentTimeoutMs
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        clearInterval(sessionPoll);
        resolve(result);
      };

      // Hard timeout fallback
      const timeoutHandle = setTimeout(() => {
        console.warn(
          `[taskDispatcher] waitForCompletion: timeout after ${timeoutMs}ms for container ${containerId}`
        );
        settle(false);
      }, timeoutMs);

      // Container exit event fires immediately when the container process exits
      void this.runtime.watchExit(
        containerId,
        (exitCode) => {
          console.log(`[taskDispatcher] Container ${containerId} exited with code ${exitCode}`);
          settle(exitCode === 0);
        }
      ).catch((_err) => {
        // Stream error — fall back to session poll and timeout; do not settle here
        console.warn(
          `[taskDispatcher] watchExit error for ${containerId}, relying on session poll`
        );
      });

      // Session-status poll at 2-second cadence
      // Handles bridge-based completion (sub-agent calls /api/sessions/:id/status)
      // and acts as fallback if Docker events are unavailable
      const sessionPoll = setInterval(() => {
        void this.getSessionStatus(sessionId).then(status => {
          if (status === "completed") { settle(true); }
          else if (status === "failed") { settle(false); }
        });
      }, 2000);
    });
  }

  /**
   * Get session status from store.
   */
  private async getSessionStatus(sessionId: string): Promise<AgentSession["status"] | null> {
    const session = await getAgentSession(sessionId);
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

    await insertPullRequest(pullRequest);

    return pullRequest;
  }

  /**
   * Re-prompt sub-agent for batched review comments (fix-run).
   * This is called when review comments need to be addressed.
   */
  async runFixRun(
    projectId: string,
    pullRequestId: string,
    comments: Array<{ body: string; filePath?: string; lineNumber?: number }>
  ): Promise<TaskResult> {
    const project = await getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const { getPullRequest } = await import("../store/pullRequests.js");
    const pr = await getPullRequest(pullRequestId);
    if (!pr) {
      throw new Error(`Pull request not found: ${pullRequestId}`);
    }

    const repository = await getRepository(pr.repositoryId);
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
    await insertAgentSession(agentSession);

    let containerId: string | undefined;

    try {
      // Create container for fix-run (using existing branch)
      // Include the standard workflow preamble so the agent follows commit/push steps.
      // Also give an explicit hint to inspect changed files before addressing comments.
      const taskDescription = TaskDispatcher.TASK_PREAMBLE
        + `You are addressing code review comments for the pull request on branch "${pr.branch}".\n\n`
        + `First, identify the files changed in this branch by running:\n`
        + `  git diff origin/main...HEAD --name-only\n\n`
        + `Then address each of the following review comments by editing the relevant files:\n\n`
        + commentsText
        + `\n\nAfter making changes, stage and commit them. Do NOT create a new branch.`;

      const ghToken = process.env.GITHUB_TOKEN;
      const fixGitPushUrl = ghToken && repository.cloneUrl.startsWith("https://github.com/")
        ? repository.cloneUrl.replace("https://github.com/", `https://x-access-token:${ghToken}@github.com/`)
        : repository.cloneUrl;

      const fixTaskId = `fix-${sessionId.slice(0, 8)}`;
      const agentProvider = config.agentProvider;
      const agentModel = config.implementationModel;
      const providerEnv = PROVIDER_ENV_VARS
        .filter(name => process.env[name])
        .map(name => `${name}=${process.env[name]}`);

      containerId = await this.runtime.createContainer({
        sessionId,
        image: config.subAgentImage,
        name: `sub-${fixTaskId}`,
        env: [
          `REPO_CLONE_URL=${repository.cloneUrl}`,
          `BRANCH_NAME=${pr.branch}`,
          `TASK_DESCRIPTION=${taskDescription}`,
          `TASK_COMMIT_MSG=fix: address review comments on ${pr.branch}`,
          ...(fixGitPushUrl ? [`GIT_PUSH_URL=${fixGitPushUrl}`] : []),
          `AGENT_PROVIDER=${agentProvider}`,
          `AGENT_MODEL=${agentModel}`,
          `TASK_ID=${fixTaskId}`,
          `HARNESS_API_URL=${config.harnessApiUrl}`,
          `AGENT_SESSION_ID=${sessionId}`,
          ...(config.repoCacheVolume ? [`REPO_CACHE_DIR=/cache`] : []),
          ...providerEnv,
        ],
        // On Docker: host path is a named volume or absolute path.
        // On Kubernetes (CONTAINER_RUNTIME=kubernetes): host path is treated as a PVC claim name.
        binds: [
          `${config.piAgentVolume}:/pi-agent`,
          ...(config.repoCacheVolume ? [`${config.repoCacheVolume}:/cache`] : []),
        ],
        memoryBytes: config.subAgentMemoryBytes,
        nanoCpus: config.subAgentCpuCount * 1_000_000_000,
        // On Docker: used to attach container to the harness bridge network.
        // On Kubernetes: ignored — pods communicate via cluster networking (Pod IPs).
        // Getting the planning agent's Pod IP for pod-to-pod comms is a follow-up task.
        networkMode: config.subAgentNetwork,
        capDrop: ["ALL"],
        securityOpt: ["no-new-privileges:true"],
        readonlyRootfs: config.subAgentReadOnlyRootfs ?? false,
        tmpfs: config.subAgentReadOnlyRootfs
          ? { "/tmp": "rw,noexec,nosuid,size=128m", "/run": "rw,noexec,nosuid,size=32m" }
          : undefined,
        workingDir: "/workspace",
      });

      await updateAgentSession(sessionId, { containerId, status: "running" });
      await this.runtime.startContainer(containerId);

      // Stream container logs to backend stdout for observability
      this.streamContainerLogs(containerId, fixTaskId);

      // Wait for completion
      const completed = await this.waitForCompletion(sessionId, containerId);

      if (!completed) {
        throw new Error("Fix-run timed out or container failed");
      }

      await updateAgentSession(sessionId, { status: "completed" });

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
      await updateAgentSession(sessionId, { status: "failed" });

      return {
        taskId: sessionId,
        success: false,
        agentSessionId: sessionId,
        error: errorMessage,
      };
    } finally {
      if (containerId) {
        try {
          await this.runtime.removeContainer(containerId);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Stream container stdout/stderr to backend process stdout for observability.
   */
  private streamContainerLogs(containerId: string, label: string): void {
    void this.runtime.streamLogs(
      containerId,
      (line, isError) => {
        if (line.trim()) {
          if (isError) {
            console.error(`[container:${label}] ${line}`);
          } else {
            console.log(`[container:${label}] ${line}`);
          }
        }
      },
      true
    ).catch(() => { /* ignore log stream errors */ });
  }

}
