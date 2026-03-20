import { Router } from "express";
import { JiraConnector } from "../connectors/jira.js";

export function createJiraRouter(): Router {
  const router = Router();
  const connector = new JiraConnector();

  // Search JIRA issues using JQL
  router.get("/search", async (req, res) => {
    const { jql, maxResults } = req.query;
    
    if (!jql || typeof jql !== "string") {
      res.status(400).json({ error: "Missing required parameter: jql" });
      return;
    }

    try {
      const results = await connector.searchIssues(
        jql,
        maxResults ? parseInt(maxResults as string, 10) : 50
      );
      res.json({ issues: results, total: results.length });
    } catch (error) {
      console.error("[jira] Search failed:", error);
      res.status(500).json({ 
        error: "Failed to search JIRA issues",
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Get a single JIRA issue by key
  router.get("/issue/:key", async (req, res) => {
    const { key } = req.params;
    
    if (!key) {
      res.status(400).json({ error: "Missing issue key" });
      return;
    }

    try {
      const issue = await connector.getIssue(key);
      res.json(issue);
    } catch (error) {
      console.error(`[jira] Get issue ${key} failed:`, error);
      res.status(500).json({ 
        error: "Failed to get JIRA issue",
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  return router;
}
