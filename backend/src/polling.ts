import type Dockerode from "dockerode";
import { listPullRequestsByProject, upsertReviewComment } from "./store/pullRequests.js";
import { getRepository } from "./store/repositories.js";
import { getConnector } from "./connectors/types.js";
import { getDebounceEngine } from "./api/webhooks.js";
import { randomUUID } from "crypto";
import type { ReviewComment, PullRequest } from "./models/types.js";

interface PollState {
  lastPollAt: string;
}

const pollStates = new Map<string, PollState>(); // prId -> state
const POLL_INTERVAL_MS = 60 * 1000; // 1 minute

let isRunning = false;
let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Poll a single PR for new comments from Bitbucket Server
 */
async function pollPullRequest(
  docker: Dockerode,
  pr: PullRequest
): Promise<number> {
  const repository = getRepository(pr.repositoryId);
  if (!repository) {
    console.warn(`[polling] Repository not found for PR ${pr.id}`);
    return 0;
  }

  // Only poll Bitbucket Server PRs
  if (repository.provider !== "bitbucket-server") {
    return 0;
  }

  const state = pollStates.get(pr.id);
  const since = state?.lastPollAt;

  try {
    const connector = getConnector(repository.provider);
    const comments = await connector.getComments(repository, pr.externalId, since);

    let newComments = 0;
    for (const comment of comments) {
      const reviewComment: ReviewComment = {
        id: randomUUID(),
        pullRequestId: pr.id,
        externalId: comment.id,
        author: comment.author,
        body: comment.body,
        filePath: comment.filePath,
        lineNumber: comment.lineNumber,
        status: "pending",
        receivedAt: comment.createdAt,
        updatedAt: new Date().toISOString(),
      };

      upsertReviewComment(reviewComment);
      newComments++;
    }

    // Update poll state
    pollStates.set(pr.id, { lastPollAt: new Date().toISOString() });

    // Notify debounce engine of new activity
    if (newComments > 0) {
      const debounceEngine = getDebounceEngine();
      if (debounceEngine) {
        debounceEngine.notify(pr.id, async (prId) => {
          console.log(`[debounce] Timer fired for PR ${prId}, triggering fix run`);
          
          // Import here to avoid circular dependency
          const { getPullRequest, getPendingComments, markCommentsStatus } = await import("./store/pullRequests.js");
          const { TaskDispatcher } = await import("./orchestrator/taskDispatcher.js");
          
          const prToFix = getPullRequest(prId);
          if (!prToFix) {
            console.warn(`[debounce] PR ${prId} not found for fix run`);
            return;
          }

          const pendingComments = getPendingComments(prId);
          if (pendingComments.length === 0) {
            console.log(`[debounce] No pending comments for PR ${prId}`);
            return;
          }

          // Mark comments as fixing
          markCommentsStatus(prId, pendingComments.map(c => c.id), "fixing");

          const dispatcher = new TaskDispatcher();
          const result = await dispatcher.runFixRun(
            docker,
            prToFix.projectId,
            prId,
            pendingComments.map(c => ({
              body: c.body,
              filePath: c.filePath,
              lineNumber: c.lineNumber,
            }))
          );

          if (result.success) {
            markCommentsStatus(prId, pendingComments.map(c => c.id), "fixed");
            console.log(`[debounce] Fix run completed for PR ${prId}`);
          } else {
            markCommentsStatus(prId, pendingComments.map(c => c.id), "pending");
            console.error(`[debounce] Fix run failed for PR ${prId}:`, result.error);
          }
        });
      }
    }

    return newComments;
  } catch (error) {
    console.error(`[polling] Failed to poll PR ${pr.id}:`, error);
    return 0;
  }
}

// ── LGTM detection ────────────────────────────────────────────────────────────

export function detectLgtm(body: string): boolean {
  return /\bLGTM\b/i.test(body);
}

const lgtmPollStates = new Map<string, string>(); // projectId → lastSeenCommentAt

async function pollPlanningPrs(docker: Dockerode): Promise<void> {
  if (!isRunning) return;

  let projects: Awaited<ReturnType<typeof import("./store/projects.js").listProjectsAwaitingLgtm>>;
  try {
    const { listProjectsAwaitingLgtm } = await import("./store/projects.js");
    projects = listProjectsAwaitingLgtm();
  } catch (error) {
    console.error("[polling] Failed to list projects awaiting LGTM:", error);
    return;
  }

  console.log(`[polling] pollPlanningPrs: ${projects.length} project(s) awaiting LGTM`);
  for (const p of projects) {
    console.log(`[polling]   project id=${p.id} name="${p.name}" status=${p.status} planningPr=${p.planningPr?.number ?? "none"}`);
  }

  for (const project of projects) {
    if (!project.planningPr || !project.primaryRepositoryId) {
      console.warn(`[polling] project ${project.id} skipped — missing planningPr or primaryRepositoryId`);
      continue;
    }
    const repo = getRepository(project.primaryRepositoryId);
    if (!repo) continue;

    try {
      const connector = getConnector(repo.provider);

      // Check if the planning PR was closed before approval
      const prInfo = await connector.getPullRequest(repo, String(project.planningPr.number));
      if (prInfo.status !== "open") {
        console.log(`[polling] Planning PR closed for project ${project.id} — marking as failed`);
        const { updateProject } = await import("./store/projects.js");
        updateProject(project.id, { status: "failed" });
        lgtmPollStates.delete(project.id);
        const { getOrInitAgent } = await import("./api/websocket.js");
        const closedAgent = await getOrInitAgent(project.id);
        await closedAgent.prompt(
          "[SYSTEM] The planning PR was closed before approval. The project has been marked as failed. Let the user know."
        );
        continue;
      }

      const since = lgtmPollStates.get(project.id);
      const comments = await connector.getComments(repo, String(project.planningPr.number), since);

      // Update last seen timestamp
      if (comments.length > 0) {
        const latest = comments[comments.length - 1].createdAt;
        lgtmPollStates.set(project.id, latest);
      }

      console.log(`[polling] project ${project.id}: ${comments.length} new comment(s) since last poll`);
      const hasLgtm = comments.some(c => detectLgtm(c.body));
      console.log(`[polling] project ${project.id}: LGTM detected=${hasLgtm}`);
      if (!hasLgtm) continue;

      // Re-fetch to confirm status hasn't changed
      const { getProject: getFreshStatus } = await import("./store/projects.js");
      const currentProject = getFreshStatus(project.id);
      if (!currentProject || currentProject.status !== project.status) continue;

      console.log(`[polling] LGTM detected on planning PR for project ${project.id} (status: ${project.status})`);

      // Import here to avoid circular dependency
      const { getOrInitAgent } = await import("./api/websocket.js");
      const agent = await getOrInitAgent(project.id);

      if (project.status === "awaiting_spec_approval") {
        const { updateProject } = await import("./store/projects.js");
        updateProject(project.id, {
          planningPr: { ...project.planningPr, specApprovedAt: new Date().toISOString() },
          status: "plan_in_progress",
        });
        lgtmPollStates.delete(project.id);
        await agent.prompt(
          '[SYSTEM] The spec has been approved (LGTM received on the PR).\n' +
          'Write the implementation plan now using the write_planning_document tool with type "plan".\n' +
          'Then post the PR URL in chat and tell the user to add a LGTM comment when ready to start implementation.'
        );
      } else if (project.status === "awaiting_plan_approval") {
        // plan.content and tasks were stored by write_planning_document(type: "plan") tool handler
        const { updateProject, getProject: getFreshProject } = await import("./store/projects.js");

        updateProject(project.id, {
          planningPr: { ...project.planningPr, planApprovedAt: new Date().toISOString() },
          status: "executing",
        });
        lgtmPollStates.delete(project.id);

        // Create branches and commit plan file to non-primary repos
        const freshProject = getFreshProject(project.id);
        if (freshProject?.plan?.content && freshProject.planningBranch) {
          const { listRepositories } = await import("./store/repositories.js");
          const allRepos = listRepositories();
          const date = freshProject.createdAt.slice(0, 10);
          const { slugify, buildPlanningFilePath } = await import("./agents/planningTool.js");
          const slug = slugify(freshProject.name);
          const planFilePath = buildPlanningFilePath("plan", date, slug);

          for (const repoId of freshProject.repositoryIds) {
            if (repoId === freshProject.primaryRepositoryId) continue; // already committed
            const nonPrimaryRepo = allRepos.find(r => r.id === repoId);
            if (!nonPrimaryRepo) continue;
            try {
              const nonPrimaryConnector = getConnector(nonPrimaryRepo.provider);
              // createBranch=true creates the branch from defaultBranch
              await nonPrimaryConnector.commitFile(
                nonPrimaryRepo,
                freshProject.planningBranch,
                planFilePath,
                freshProject.plan.content,
                `docs: add implementation plan for ${freshProject.name}`,
                true // createBranch
              );
              console.log(`[polling] Plan committed to non-primary repo ${nonPrimaryRepo.name}`);
            } catch (err) {
              console.warn(`[polling] Failed to commit plan to non-primary repo ${repoId}:`, err);
            }
          }
        }

        await agent.prompt(
          '[SYSTEM] The implementation plan has been approved (LGTM received on the PR).\n' +
          'Tell the user that implementation is starting and the sub-agents will take it from here.'
        );

        const freshProject2 = getFreshProject(project.id);
        const taskCount = freshProject2?.plan?.tasks?.length ?? 0;
        console.log(`[polling] project ${project.id}: plan has ${taskCount} task(s) — starting dispatch`);

        const { getRecoveryService } = await import("./orchestrator/recoveryService.js");
        getRecoveryService().dispatchTasksForProject(project.id).catch(err => {
          console.error(`[polling] dispatchTasksForProject failed for project ${project.id}:`, err);
        });
      }
    } catch (error) {
      console.error(`[polling] Error processing LGTM for project ${project.id}:`, error);
    }
  }
}

/**
 * Poll all open PRs across all projects
 */
async function pollAllPullRequests(docker: Dockerode): Promise<void> {
  if (!isRunning) return;

  try {
    // Recover any stale sub-agent sessions
    const { getRecoveryService } = await import("./orchestrator/recoveryService.js");
    await getRecoveryService().recoverExecutingProjects();

    // Import here to avoid circular dependency issues
    const { listProjects } = await import("./store/projects.js");
    const projects = listProjects();

    let totalNewComments = 0;
    const openPrIds = new Set<string>();

    for (const project of projects) {
      const prs = listPullRequestsByProject(project.id);
      
      // Only poll open PRs
      const openPrs = prs.filter(pr => pr.status === "open");
      
      for (const pr of openPrs) {
        openPrIds.add(pr.id);
        try {
          const newComments = await pollPullRequest(docker, pr);
          totalNewComments += newComments;
        } catch (error) {
          console.error(`[polling] Error polling PR ${pr.id}:`, error);
        }
      }
    }

    // Clean up poll state for closed PRs
    for (const prId of pollStates.keys()) {
      if (!openPrIds.has(prId)) {
        pollStates.delete(prId);
        console.log(`[polling] Cleaned up poll state for closed PR ${prId}`);
      }
    }

    if (totalNewComments > 0) {
      console.log(`[polling] Found ${totalNewComments} new comments across all PRs`);
    }

    // Poll planning PRs for LGTM
    await pollPlanningPrs(docker);
  } catch (error) {
    console.error("[polling] Error during poll cycle:", error);
  }
}

/**
 * Start the polling service
 */
export function startPolling(docker: Dockerode): void {
  if (isRunning) {
    console.log("[polling] Already running");
    return;
  }

  isRunning = true;
  console.log(`[polling] Starting polling (interval: ${POLL_INTERVAL_MS}ms)`);

  // Run initial poll immediately
  void pollAllPullRequests(docker);

  // Schedule regular polls
  intervalId = setInterval(() => {
    void pollAllPullRequests(docker);
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the polling service
 */
export function stopPolling(): void {
  if (!isRunning) return;

  isRunning = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  console.log("[polling] Stopped");
}

/**
 * Get polling status
 */
export function getPollingStatus(): { isRunning: boolean; intervalMs: number; pollStateCount: number } {
  return {
    isRunning,
    intervalMs: POLL_INTERVAL_MS,
    pollStateCount: pollStates.size,
  };
}
