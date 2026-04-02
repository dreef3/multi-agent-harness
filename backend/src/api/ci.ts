import { Router } from "express";

/**
 * Standalone CI log fetching endpoint.
 *
 * GET /api/ci/logs?buildUrl=<url>
 *
 * Fetches raw log text from a CI build URL.  The request is routed to the
 * correct CI backend based on environment variables:
 *   - JENKINS_URL / JENKINS_TOKEN  → Jenkins console output
 *   - TEAMCITY_URL / TEAMCITY_TOKEN → TeamCity REST log API
 *
 * This endpoint is useful when the caller already knows the build URL (e.g.
 * from a CI status notification) and doesn't need to look up a PR record.
 * It is also used by E2E tests to verify Jenkins/TeamCity log fetching without
 * requiring a full agent task flow.
 */
export function createCiRouter(): Router {
  const router = Router();

  router.get("/logs", async (req, res) => {
    const buildUrl = typeof req.query.buildUrl === "string" ? req.query.buildUrl : "";
    if (!buildUrl) {
      res.status(400).json({ error: "buildUrl query parameter is required" });
      return;
    }

    try {
      const logs = await fetchCiLogs(buildUrl);
      res.json({ logs });
    } catch (err) {
      console.error("[api/ci] fetchCiLogs error:", err);
      res.status(500).json({ error: "Failed to fetch CI logs", details: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

export async function fetchCiLogs(buildUrl: string): Promise<string> {
  const jenkinsBase = process.env.JENKINS_URL?.replace(/\/$/, "");
  const jenkinsToken = process.env.JENKINS_TOKEN;
  const teamcityBase = process.env.TEAMCITY_URL?.replace(/\/$/, "");
  const teamcityToken = process.env.TEAMCITY_TOKEN;

  // --- Jenkins ---
  if (jenkinsBase && buildUrl.startsWith(jenkinsBase)) {
    const logUrl = buildUrl.replace(/\/?$/, "/") + "consoleText";
    const headers: Record<string, string> = { "User-Agent": "multi-agent-harness" };
    if (jenkinsToken) {
      // Jenkins accepts "user:apiToken" as Basic auth
      if (jenkinsToken.includes(":")) {
        headers["Authorization"] = "Basic " + Buffer.from(jenkinsToken).toString("base64");
      } else {
        headers["Authorization"] = `Bearer ${jenkinsToken}`;
      }
    }
    const res = await fetch(logUrl, { headers });
    if (res.ok) return res.text();
    throw new Error(`Jenkins returned HTTP ${res.status} for ${logUrl}`);
  }

  // --- TeamCity ---
  if (teamcityBase && buildUrl.startsWith(teamcityBase)) {
    const tcBuildId = extractTeamCityBuildId(buildUrl);
    if (!tcBuildId) throw new Error(`Could not extract TeamCity build ID from URL: ${buildUrl}`);
    const logUrl = `${teamcityBase}/app/rest/builds/id:${tcBuildId}/log`;
    const headers: Record<string, string> = {
      Accept: "text/plain",
      "User-Agent": "multi-agent-harness",
    };
    if (teamcityToken) headers["Authorization"] = `Bearer ${teamcityToken}`;
    const res = await fetch(logUrl, { headers });
    if (res.ok) return res.text();
    throw new Error(`TeamCity returned HTTP ${res.status} for ${logUrl}`);
  }

  throw new Error(`No CI backend configured for URL: ${buildUrl}. Set JENKINS_URL or TEAMCITY_URL.`);
}

function extractTeamCityBuildId(url: string): string | null {
  const m1 = url.match(/[?&]buildId=(\d+)/);
  if (m1) return m1[1];
  const m2 = url.match(/\/(?:buildConfiguration\/[^/?]+|build)\/(\d+)/);
  if (m2) return m2[1];
  return null;
}
