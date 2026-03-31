import type Dockerode from "dockerode";
import { listPullRequestsByProject, upsertReviewComment, updatePullRequest, getPullRequest, getPendingComments, markCommentsStatus } from "./store/pullRequests.js";
import { getRepository, listRepositories } from "./store/repositories.js";
import { listProjects, listProjectsAwaitingLgtm, updateProject, getProject } from "./store/projects.js";
import { getConnector } from "./connectors/types.js";
import { getOrCreateTrace } from "./orchestrator/traceBuilder.js";
import { getDebounceEngine } from "./api/webhooks.js";
import { getRecoveryService } from "./orchestrator/recoveryService.js";
import { getPlanningAgentManager } from "./orchestrator/planningAgentManager.js";
import { TaskDispatcher } from "./orchestrator/taskDispatcher.js";
import { slugify, buildPlanningFilePath } from "./agents/planningTool.js";
import { randomUUID } from "crypto";
import type { ReviewComment, PullRequest, Project } from "./models/types.js";

interface PollState {
  lastPollAt: string;
}

const pollStates = new Map<string, PollState>(); // prId -> state
const POLL_INTERVAL_MS = 60 * 1000; // 1 minute

let isRunning = false;
let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Poll a single PR for new comments (works for GitHub and Bitbucket Server).
 * Exported for unit testing.
 */
export async function pollPullRequest(
  docker: Dockerode,
  pr: PullRequest
): Promise<number> {
  const repository = getRepository(pr.repositoryId);
  if (!repository) {
    console.warn(`[polling] Repository not found for PR ${pr.id}`);
    return 0;
  }

  const state = pollStates.get(pr.id);
  const since = state?.lastPollAt;

  try {
    const connector = getConnector(repository.provider);

    // Sync the live PR status — implementation PRs never get updated locally when merged.
    const prInfo = await connector.getPullRequest(repository, pr.externalId);
    if (prInfo.status !== "open") {
      updatePullRequest(pr.id, { status: prInfo.status });
      console.log(`[polling] PR ${pr.id} is ${prInfo.status} on remote — updated local status, skipping comment poll`);

      // When a PR is merged, check if all project PRs are now terminal → mark project completed
      if (prInfo.status === "merged") {
        const project = getProject(pr.projectId);
        if (project && project.status !== "completed" && project.status !== "cancelled") {
          const allPrs = listPullRequestsByProject(pr.projectId);
          const allTerminal = allPrs.length > 0 && allPrs.every(p => p.status === "merged" || p.status === "declined");
          if (allTerminal) {
            updateProject(pr.projectId, { status: "completed" });
            console.log(`[polling] All PRs for project ${pr.projectId} are terminal — marking project completed`);
          }
        }
      }

      pollStates.delete(pr.id);
      return 0;
    }

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

      const isNew = upsertReviewComment(reviewComment);
      if (isNew) newComments++;
    }

    // Update poll state
    pollStates.set(pr.id, { lastPollAt: new Date().toISOString() });

    // Notify debounce engine of new activity
    if (newComments > 0) {
      const debounceEngine = getDebounceEngine();
      if (debounceEngine) {
        debounceEngine.notify(pr.id, async (prId) => {
          console.log(`[debounce] Timer fired for PR ${prId}, triggering fix run`);

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

/**
 * @deprecated Use getPrApprovals() via a VcsConnector instead.
 * Kept for backward compatibility.
 */
export function detectLgtm(body: string): boolean {
  return /\bLGTM\b/i.test(body);
}

const approvalPollStates = new Map<string, string>(); // projectId → lastSeenCommentAt

async function pollPlanningPrs(docker: Dockerode): Promise<void> {
  if (!isRunning) return;
  console.log(`[polling] Checking projects for LGTM...`);

  let projects: Project[];
  try {
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
        updateProject(project.id, { status: "failed" });
        approvalPollStates.delete(project.id);
        await getPlanningAgentManager().sendPrompt(
          project.id,
          "[SYSTEM] The planning PR was closed before approval. The project has been marked as failed. Let the user know."
        );
        continue;
      }

      const approvals = await connector.getPrApprovals(repo, String(project.planningPr.number));
      const hasApproval = approvals.some(a => a.state === "approved");
      console.log(`[polling] project ${project.id}: approval detected=${hasApproval}`);
      if (!hasApproval) continue;

      // Re-fetch to confirm status hasn't changed
      const currentProject = getProject(project.id);
      if (!currentProject || currentProject.status !== project.status) continue;

      console.log(`[polling] LGTM detected on planning PR for project ${project.id} (status: ${project.status})`);

      const planningManager = getPlanningAgentManager();

      if (project.status === "awaiting_spec_approval") {
        const specApprovedAt = new Date().toISOString();
        updateProject(project.id, {
          planningPr: { ...project.planningPr, specApprovedAt },
          status: "plan_in_progress",
        });
        getOrCreateTrace(project.id, project.name).setSpecApproved(specApprovedAt);
        await planningManager.sendPrompt(
          project.id,
          '[SYSTEM] The spec has been approved (LGTM received on the PR).\n' +
          'Write the implementation plan now using the write_planning_document tool with type "plan".\n' +
          'Then post the PR URL in chat and tell the user to add a LGTM comment when ready to start implementation.'
        );
      } else if (project.status === "awaiting_plan_approval") {
        const planApprovedAt = new Date().toISOString();
        updateProject(project.id, {
          planningPr: { ...project.planningPr, planApprovedAt },
          status: "executing",
        });
        getOrCreateTrace(project.id, project.name).setPlanApproved(planApprovedAt);
        approvalPollStates.delete(project.id);

        // Commit plan file to non-primary repos (primary repo was committed by write_planning_document)
        const freshProject = getProject(project.id);
        if (freshProject?.plan?.content && freshProject.planningBranch) {
          const allRepos = listRepositories();
          const date = freshProject.createdAt.slice(0, 10);
          const slug = slugify(freshProject.name);
          const planFilePath = buildPlanningFilePath("plan", date, slug);

          for (const repoId of freshProject.repositoryIds) {
            if (repoId === freshProject.primaryRepositoryId) continue; // already committed
            const nonPrimaryRepo = allRepos.find(r => r.id === repoId);
            if (!nonPrimaryRepo) continue;
            try {
              const nonPrimaryConnector = getConnector(nonPrimaryRepo.provider);
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

        // Notify the planning agent — it will call dispatch_tasks to start sub-agents
        await planningManager.sendPrompt(
          project.id,
          '[SYSTEM] The implementation plan has been approved (LGTM received on the PR).\n' +
          'Call dispatch_tasks now to submit the implementation tasks to sub-agents, then inform the user that implementation is starting.'
        );
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
  console.log(`[polling] Starting poll cycle`);

  try {
    // Recover any stale sub-agent sessions
    await getRecoveryService().recoverExecutingProjects();

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
