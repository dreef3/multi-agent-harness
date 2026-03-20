import { Router } from "express";
import { randomUUID } from "crypto";
import { getPullRequest, upsertReviewComment } from "../store/pullRequests.js";
import { DebounceEngine } from "../debounce/engine.js";
import type { ReviewComment } from "../models/types.js";

interface GitHubWebhookPayload {
  action: string;
  pull_request?: {
    number: number;
    html_url: string;
  };
  comment?: {
    id: number;
    user: { login: string };
    body: string;
    path?: string;
    line?: number;
    created_at: string;
  };
  review?: {
    id: number;
    user: { login: string };
    body: string;
  };
}

// Global debounce engine instance (shared with polling)
let debounceEngine: DebounceEngine | null = null;

export function setDebounceEngine(engine: DebounceEngine): void {
  debounceEngine = engine;
}

export function getDebounceEngine(): DebounceEngine | null {
  return debounceEngine;
}

export function createWebhooksRouter(): Router {
  const router = Router();

  // GitHub webhook handler
  router.post("/github", async (req, res) => {
    const eventType = req.headers["x-github-event"] as string;
    const payload: GitHubWebhookPayload = req.body;

    console.log(`[webhook] Received GitHub event: ${eventType}`);

    // Handle pull request review events
    if (eventType === "pull_request_review" && payload.action === "submitted") {
      // Extract PR info from the payload
      const prNumber = payload.pull_request?.number;
      if (!prNumber) {
        res.status(400).json({ error: "Missing pull request number" });
        return;
      }

      // Find the PR in our database by external ID
      // Note: We need to search by external_id, but we don't have that function
      // For now, we'll queue the event for processing
      console.log(`[webhook] PR review submitted for PR #${prNumber}`);
      
      // Trigger debounce if engine is available
      if (debounceEngine) {
        // We need to find the PR ID first - this will be handled by the polling mechanism
        console.log(`[webhook] Debounce engine available, will process via polling`);
      }
    }

    // Handle pull request review comment events
    if (eventType === "pull_request_review_comment") {
      if (!payload.comment || !payload.pull_request) {
        res.status(400).json({ error: "Missing comment or PR data" });
        return;
      }

      console.log(`[webhook] PR review comment received for PR #${payload.pull_request.number}`);
      
      // The comment will be picked up by polling and processed through debounce engine
    }

    // Always return 200 to acknowledge receipt
    res.json({ received: true, event: eventType });
  });

  // Generic webhook handler for testing
  router.post("/test", (req, res) => {
    console.log("[webhook] Test webhook received:", req.body);
    res.json({ received: true, timestamp: new Date().toISOString() });
  });

  return router;
}

// Helper to insert a comment from webhook/polling and trigger debounce
export function insertCommentAndNotify(
  pullRequestId: string,
  externalCommentId: string,
  author: string,
  body: string,
  filePath?: string,
  lineNumber?: number
): void {
  const comment: ReviewComment = {
    id: randomUUID(),
    pullRequestId,
    externalId: externalCommentId,
    author,
    body,
    filePath,
    lineNumber,
    status: "pending",
    receivedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  upsertReviewComment(comment);

  // Notify debounce engine
  if (debounceEngine) {
    debounceEngine.notify(pullRequestId, async (prId) => {
      console.log(`[debounce] Triggering fix run for PR ${prId}`);
      // The actual fix run will be triggered by the polling mechanism
      // or can be called here if we have access to the docker instance
    });
  }
}
