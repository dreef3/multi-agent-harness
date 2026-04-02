import { Router } from "express";
import type Dockerode from "dockerode";
import { randomUUID } from "crypto";
import {
  listPullRequestsByProject,
  getPullRequest,
  insertPullRequest,
  getPendingComments,
  upsertReviewComment,
  markCommentsStatus
} from "../store/pullRequests.js";
import { getRepository } from "../store/repositories.js";
import { getConnector } from "../connectors/types.js";
import { TaskDispatcher } from "../orchestrator/taskDispatcher.js";
import type { ContainerRuntime } from "../orchestrator/containerRuntime.js";
import type { ReviewComment } from "../models/types.js";

export function createPullRequestsRouter(docker: Dockerode, containerRuntime?: ContainerRuntime): Router {
  const router = Router();
  const taskDispatcher = containerRuntime ? new TaskDispatcher(containerRuntime) : null;

  // Register a PR record (used by tests and webhook ingestion)
  router.post("/", async (req, res) => {
    const { repositoryId, projectId, branch, externalId, url, provider } = req.body;
    if (!repositoryId || !branch) {
      res.status(400).json({ error: "repositoryId and branch are required" });
      return;
    }
    const repo = await getRepository(repositoryId);
    if (!repo) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    const pr = {
      id: randomUUID(),
      projectId: projectId ?? randomUUID(),
      repositoryId,
      agentSessionId: randomUUID(),
      provider: (provider ?? repo.provider) as "github" | "bitbucket-server",
      externalId: externalId ?? branch,
      url: url ?? "",
      branch,
      status: "open" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await insertPullRequest(pr);
    res.status(201).json(pr);
  });

  // List all PRs for a project
  router.get("/project/:projectId", async (req, res) => {
    const { projectId } = req.params;
    const prs = await listPullRequestsByProject(projectId);
    res.json(prs);
  });

  // Get a single PR with its comments
  router.get("/:id", async (req, res) => {
    const pr = await getPullRequest(req.params.id);
    if (!pr) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }

    const comments = await getPendingComments(req.params.id);
    res.json({ ...pr, comments });
  });

  // Get comments for a PR
  router.get("/:id/comments", async (req, res) => {
    const pr = await getPullRequest(req.params.id);
    if (!pr) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }

    const comments = await getPendingComments(req.params.id);
    res.json(comments);
  });

  // Sync comments from VCS provider
  router.post("/:id/sync", async (req, res) => {
    const pr = await getPullRequest(req.params.id);
    if (!pr) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }

    const repository = await getRepository(pr.repositoryId);
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
        await upsertReviewComment(reviewComment);
      }

      const pendingComments = await getPendingComments(pr.id);
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
    const pr = await getPullRequest(req.params.id);
    if (!pr) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }

    const { commentIds } = req.body;
    const allPending = await getPendingComments(pr.id);
    const commentsToFix = commentIds
      ? allPending.filter(c => commentIds.includes(c.id))
      : allPending;

    if (commentsToFix.length === 0) {
      res.status(400).json({ error: "No pending comments to fix" });
      return;
    }

    try {
      // Mark comments as fixing
      await markCommentsStatus(pr.id, commentsToFix.map(c => c.id), "fixing");

      if (!taskDispatcher) {
        res.status(503).json({ error: "Container runtime not available" });
        return;
      }

      // Run fix via task dispatcher
      const result = await taskDispatcher.runFixRun(
        pr.projectId,
        pr.id,
        commentsToFix.map(c => ({
          body: c.body,
          filePath: c.filePath,
          lineNumber: c.lineNumber,
        }))
      );

      if (result.success) {
        await markCommentsStatus(pr.id, commentsToFix.map(c => c.id), "fixed");
        res.json({ success: true, fixed: commentsToFix.length });
      } else {
        await markCommentsStatus(pr.id, commentsToFix.map(c => c.id), "pending");
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
  router.patch("/:id/comments/:commentId", async (req, res) => {
    const { id, commentId } = req.params;
    const { status } = req.body;

    if (!status || !["pending", "batched", "fixing", "fixed", "ignored"].includes(status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }

    const pr = await getPullRequest(id);
    if (!pr) {
      res.status(404).json({ error: "Pull request not found" });
      return;
    }

    try {
      await markCommentsStatus(id, [commentId], status as ReviewComment["status"]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: "Failed to update comment status",
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // GET /api/pull-requests/:id/build-status
  router.get("/:id/build-status", async (req, res) => {
    try {
      const pr = await getPullRequest(req.params.id);
      if (!pr) {
        res.status(404).json({ error: "Pull request not found" });
        return;
      }

      const repo = await getRepository(pr.repositoryId);
      if (!repo) {
        res.status(404).json({ error: "Repository not found" });
        return;
      }

      const connector = getConnector(repo.provider);
      const status = await connector.getBuildStatus(repo, pr.branch);
      res.json(status);
    } catch (err) {
      console.error("[api] getBuildStatus error:", err);
      res.status(500).json({ error: "Failed to fetch build status" });
    }
  });

  // GET /api/pull-requests/:id/build-logs/:buildId
  router.get("/:id/build-logs/:buildId", async (req, res) => {
    try {
      const pr = await getPullRequest(req.params.id);
      if (!pr) {
        res.status(404).json({ error: "Pull request not found" });
        return;
      }

      const repo = await getRepository(pr.repositoryId);
      if (!repo) {
        res.status(404).json({ error: "Repository not found" });
        return;
      }

      const connector = getConnector(repo.provider);
      const logs = await connector.getBuildLogs(repo, req.params.buildId);
      res.json({ logs });
    } catch (err) {
      console.error("[api] getBuildLogs error:", err);
      res.status(500).json({ error: "Failed to fetch build logs" });
    }
  });

  // GET /api/pull-requests/:id/approvals
  router.get("/:id/approvals", async (req, res) => {
    try {
      const pr = await getPullRequest(req.params.id);
      if (!pr) {
        res.status(404).json({ error: "Pull request not found" });
        return;
      }

      const repo = await getRepository(pr.repositoryId);
      if (!repo) {
        res.status(404).json({ error: "Repository not found" });
        return;
      }

      const connector = getConnector(repo.provider);
      const approvals = await connector.getPrApprovals(repo, pr.externalId ?? req.params.id);
      res.json({ approvals });
    } catch (err) {
      console.error("[api] getPrApprovals error:", err);
      res.status(500).json({ error: "Failed to fetch PR approvals" });
    }
  });

  return router;
}
