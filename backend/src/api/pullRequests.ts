import { Router } from "express";
import type Dockerode from "dockerode";
import { randomUUID } from "crypto";
import { 
  listPullRequestsByProject, 
  getPullRequest,
  getPendingComments,
  upsertReviewComment,
  markCommentsStatus
} from "../store/pullRequests.js";
import { getRepository } from "../store/repositories.js";
import { getConnector } from "../connectors/types.js";
import { TaskDispatcher } from "../orchestrator/taskDispatcher.js";
import type { ReviewComment } from "../models/types.js";

export function createPullRequestsRouter(docker: Dockerode): Router {
  const router = Router();
  const taskDispatcher = new TaskDispatcher();

  // List all PRs for a project
  router.get("/project/:projectId", (req, res) => {
    const { projectId } = req.params;
    const prs = listPullRequestsByProject(projectId);
    res.json(prs);
  });

  // Get a single PR with its comments
  router.get("/:id", (req, res) => {
    const pr = getPullRequest(req.params.id);
    if (!pr) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }

    const comments = getPendingComments(req.params.id);
    res.json({ ...pr, comments });
  });

  // Get comments for a PR
  router.get("/:id/comments", (req, res) => {
    const pr = getPullRequest(req.params.id);
    if (!pr) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }

    const comments = getPendingComments(req.params.id);
    res.json(comments);
  });

  // Sync comments from VCS provider
  router.post("/:id/sync", async (req, res) => {
    const pr = getPullRequest(req.params.id);
    if (!pr) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }

    const repository = getRepository(pr.repositoryId);
    if (!repository) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }

    try {
      const connector = getConnector(repository.provider);
      const comments = await connector.getComments(repository, pr.externalId);

      // Insert/update comments in database
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
      }

      const pendingComments = getPendingComments(pr.id);
      res.json({ 
        success: true, 
        synced: comments.length,
        pending: pendingComments.length 
      });
    } catch (error) {
      console.error(`[pullRequests] Sync failed for ${req.params.id}:`, error);
      res.status(500).json({ 
        error: "Failed to sync comments",
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Trigger manual fix run for a PR
  router.post("/:id/fix", async (req, res) => {
    const pr = getPullRequest(req.params.id);
    if (!pr) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }

    const { commentIds } = req.body;
    const commentsToFix = commentIds 
      ? getPendingComments(pr.id).filter(c => commentIds.includes(c.id))
      : getPendingComments(pr.id);

    if (commentsToFix.length === 0) {
      res.status(400).json({ error: "No pending comments to fix" });
      return;
    }

    try {
      // Mark comments as fixing
      markCommentsStatus(pr.id, commentsToFix.map(c => c.id), "fixing");

      // Run fix via task dispatcher
      const result = await taskDispatcher.runFixRun(
        docker,
        pr.projectId,
        pr.id,
        commentsToFix.map(c => ({
          body: c.body,
          filePath: c.filePath,
          lineNumber: c.lineNumber,
        }))
      );

      if (result.success) {
        markCommentsStatus(pr.id, commentsToFix.map(c => c.id), "fixed");
        res.json({ success: true, fixed: commentsToFix.length });
      } else {
        markCommentsStatus(pr.id, commentsToFix.map(c => c.id), "pending");
        res.status(500).json({ 
          error: "Fix run failed",
          details: result.error 
        });
      }
    } catch (error) {
      console.error(`[pullRequests] Fix run failed for ${req.params.id}:`, error);
      res.status(500).json({ 
        error: "Failed to run fix",
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Update comment status (ignore, pending, etc.)
  router.patch("/:id/comments/:commentId", (req, res) => {
    const { id, commentId } = req.params;
    const { status } = req.body;

    if (!status || !["pending", "batched", "fixing", "fixed", "ignored"].includes(status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }

    const pr = getPullRequest(id);
    if (!pr) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }

    try {
      markCommentsStatus(id, [commentId], status as ReviewComment["status"]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ 
        error: "Failed to update comment status",
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  return router;
}
