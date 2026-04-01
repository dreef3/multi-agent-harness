import { Router } from "express";
import { GitHubIssuesConnector } from "../connectors/githubIssues.js";
import { getRepository } from "../store/repositories.js";

export function createGitHubIssuesRouter(): Router {
  const router = Router();
  const connector = new GitHubIssuesConnector();

  // Search open GitHub issues by title across the given repositories
  // Query params: q (text, optional), repositoryIds (comma-separated, required), maxResults (optional)
  router.get("/search", async (req, res) => {
    const { q, repositoryIds, maxResults } = req.query;

    if (!repositoryIds || typeof repositoryIds !== "string") {
      res.status(400).json({ error: "Missing required parameter: repositoryIds" });
      return;
    }

    const ids = repositoryIds.split(",").map(id => id.trim()).filter(Boolean);
    const repoResults = await Promise.all(ids.map(id => getRepository(id)));
    const repos = repoResults.filter((r): r is NonNullable<typeof r> => r != null);

    if (repos.length === 0) {
      res.status(400).json({ error: "None of the provided repositoryIds were found" });
      return;
    }

    let limit = 20;
    if (maxResults !== undefined) {
      limit = parseInt(maxResults as string, 10);
      if (isNaN(limit) || limit < 1) {
        res.status(400).json({ error: "maxResults must be a positive integer" });
        return;
      }
    }

    try {
      const issues = await connector.searchIssues(
        repos,
        typeof q === "string" ? q : "",
        limit
      );
      res.json({ issues, total: issues.length });
    } catch (error) {
      console.error("[github-issues] Search failed:", error);
      res.status(500).json({
        error: "Failed to search GitHub issues",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Get a single issue by owner/repo/number
  router.get("/issue/:owner/:repo/:number", async (req, res) => {
    const { owner, repo, number } = req.params;
    const num = parseInt(number, 10);

    if (!owner || !repo || isNaN(num)) {
      res.status(400).json({ error: "Invalid issue reference" });
      return;
    }

    try {
      const issue = await connector.getIssue(owner, repo, num);
      res.json(issue);
    } catch (error) {
      console.error(`[github-issues] Get issue ${owner}/${repo}#${num} failed:`, error);
      res.status(500).json({
        error: "Failed to get GitHub issue",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
