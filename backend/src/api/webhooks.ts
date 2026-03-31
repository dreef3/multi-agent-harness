import { Router } from "express";
import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import { getPullRequest, getPullRequestByExternalId, upsertReviewComment } from "../store/pullRequests.js";
import { DebounceEngine } from "../debounce/engine.js";
import type { ReviewComment } from "../models/types.js";

interface GitHubWebhookPayload {
  action: string;
  pull_request?: {
    number: number;
    html_url: string;
    state?: string;
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

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const hmac = createHmac("sha256", secret);
  hmac.update(payload);
  const digest = "sha256=" + hmac.digest("hex");
  return timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
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
    const signature = req.headers["x-hub-signature-256"] as string;
    const payload: GitHubWebhookPayload = req.body;

    // Verify webhook signature
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!signature || !secret) {
      res.status(401).json({ error: "Missing signature or secret" });
      return;
    }

    const rawBody = (req as import("express").Request & { rawBody: Buffer }).rawBody?.toString("utf8")
      ?? JSON.stringify(req.body);
    if (!verifySignature(rawBody, signature, secret)) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    console.log(`[webhook] Received GitHub event: ${eventType}`);

    // Handle pull request review events
    if (eventType === "pull_request_review" && payload.action === "submitted") {
      const prNumber = payload.pull_request?.number;
      if (!prNumber) {
        res.status(400).json({ error: "Missing pull request number" });
        return;
      }

      const pr = getPullRequestByExternalId(prNumber.toString());
      if (!pr) {
        console.warn(`[webhook] PR #${prNumber} not found in database`);
        res.status(404).json({ error: "Pull request not found" });
        return;
      }

      console.log(`[webhook] PR review submitted for PR #${prNumber} (id: ${pr.id})`);

      // Insert review as a comment and notify debounce engine
      if (payload.review?.body) {
        insertCommentAndNotify(
          pr.id,
          payload.review.id.toString(),
          payload.review.user.login,
          payload.review.body
        );
      }

      // Trigger debounce engine for this PR
      if (debounceEngine) {
        debounceEngine.notify(pr.id, async (prId) => {
          console.log(`[webhook] Debounce timer fired for PR ${prId}`);
        });
      }
    }

    // Handle pull request review comment events
    if (eventType === "pull_request_review_comment") {
      if (!payload.comment || !payload.pull_request) {
        res.status(400).json({ error: "Missing comment or PR data" });
        return;
      }

      const prNumber = payload.pull_request.number;
      const pr = getPullRequestByExternalId(prNumber.toString());
      if (!pr) {
        console.warn(`[webhook] PR #${prNumber} not found in database`);
        res.status(404).json({ error: "Pull request not found" });
        return;
      }

      console.log(`[webhook] PR review comment received for PR #${prNumber} (id: ${pr.id})`);

      // Insert comment and notify debounce engine
      insertCommentAndNotify(
        pr.id,
        payload.comment.id.toString(),
        payload.comment.user.login,
        payload.comment.body,
        payload.comment.path,
        payload.comment.line
      );
    }

    // Handle PR state changes (closed/merged) - clean up timers
    if (eventType === "pull_request" && (payload.action === "closed" || payload.action === "merged")) {
      const prNumber = payload.pull_request?.number;
      if (prNumber) {
        const pr = getPullRequestByExternalId(prNumber.toString());
        if (pr && debounceEngine) {
          debounceEngine.cancel(pr.id);
          console.log(`[webhook] Cancelled debounce timer for closed PR #${prNumber}`);
        }
      }
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
