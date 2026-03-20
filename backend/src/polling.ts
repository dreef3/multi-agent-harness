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

/**
 * Clean up poll state for PRs that are no longer open
 */
function cleanupClosedPrs(): void {
  // Get all PR IDs from all projects
  const { listProjects } = require("./store/projects.js");
  const projects = listProjects();
  const openPrIds = new Set<string>();

  for (const project of projects) {
    const prs = listPullRequestsByProject(project.id);
    for (const pr of prs) {
      if (pr.status === "open") {
        openPrIds.add(pr.id);
      }
    }
  }

  // Remove poll state for closed PRs
  for (const prId of pollStates.keys()) {
    if (!openPrIds.has(prId)) {
      pollStates.delete(prId);
      console.log(`[polling] Cleaned up poll state for closed PR ${prId}`);
    }
  }
}

/**
 * Poll all open PRs across all projects
 */
async function pollAllPullRequests(docker: Dockerode): Promise<void> {
  if (!isRunning) return;

  try {
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
  console.log(`[polling] Starting Bitbucket Server polling (interval: ${POLL_INTERVAL_MS}ms)`);

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
