/**
 * CI tool descriptions injected into the planning agent's system context.
 *
 * These tools are available via the harness backend HTTP API.
 * The planning agent calls them using its WebFetch tool.
 */

/**
 * Build the CI tools section for the master agent context.
 * @param harnessApiUrl - The base URL of the harness backend (e.g. http://localhost:3000)
 */
export function buildCiToolsDescription(harnessApiUrl: string): string {
  return `
## CI Integration Tools

You have access to CI build status and logs via the harness backend API.
Use these tools to verify implementation quality before approving PRs.

---

### get_build_status

Fetch the CI build status for a pull request's source branch.

**Request:**
\`\`\`
GET ${harnessApiUrl}/api/pull-requests/{pullRequestId}/build-status
\`\`\`

**Response:**
\`\`\`json
{
  "state": "success" | "failure" | "pending" | "unknown",
  "checks": [
    {
      "name": "CI / test-backend",
      "status": "success" | "failure" | "pending" | "skipped",
      "url": "https://github.com/...",
      "buildId": "12345678",
      "startedAt": "2026-03-28T10:00:00Z",
      "completedAt": "2026-03-28T10:05:00Z"
    }
  ]
}
\`\`\`

**When to use:**
- After a sub-agent completes a task and opens a PR, check CI status before approving the PR
- If \`state\` is \`"failure"\`, read the logs and decide whether to re-dispatch a fix
- If \`state\` is \`"pending"\`, wait 60 seconds and poll again (up to 10 minutes)
- If \`state\` is \`"unknown"\` with empty \`checks\`, CI is not configured — treat as passing

---

### get_build_logs

Fetch the raw logs for a specific CI check run.

**Request:**
\`\`\`
GET ${harnessApiUrl}/api/pull-requests/{pullRequestId}/build-logs/{buildId}
\`\`\`

Use the \`buildId\` field from a failing check in the \`get_build_status\` response.

**Response:**
\`\`\`json
{
  "logs": "...raw log text or URL..."
}
\`\`\`

**When to use:**
- When \`get_build_status\` returns \`state: "failure"\`, fetch logs for each failing check
- Analyze the logs to understand what went wrong
- Include the relevant error excerpt in the dispatch message when re-running the sub-agent
- Do not fetch logs for successful checks — this wastes API quota

---

### Workflow example

\`\`\`
1. Sub-agent completes and opens PR #42
2. Call: GET ${harnessApiUrl}/api/pull-requests/42/build-status
3. If state == "pending": wait 60s, retry up to 10 times
4. If state == "failure":
   a. Identify failing checks (status == "failure")
   b. For each: GET ${harnessApiUrl}/api/pull-requests/42/build-logs/{buildId}
   c. Extract error message from logs
   d. Re-dispatch sub-agent with context: "CI failed with: <error>"
5. If state == "success": proceed to PR approval
\`\`\`
`;
}
