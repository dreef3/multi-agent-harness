/**
 * Bootstrap GitHub Copilot auth.json from a PAT.
 *
 * Reads COPILOT_GITHUB_TOKEN, exchanges it for a
 * short-lived Copilot access token via the GitHub API, and writes the result into
 * <piAgentDir>/auth.json so pi-coding-agent can use the github-copilot provider.
 *
 * @param {string} piAgentDir  Path to the pi-agent directory (e.g. /pi-agent)
 * @param {string} label       Log prefix (e.g. "[planning-agent]" or "[sub-agent]")
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export async function setupCopilotAuth(piAgentDir, label) {
  const token = process.env.COPILOT_GITHUB_TOKEN;
  if (!token) return;
  delete process.env.COPILOT_GITHUB_TOKEN;

  try {
    const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
        "User-Agent": "GitHubCopilotChat/0.35.0",
        "Editor-Version": "vscode/1.107.0",
        "Editor-Plugin-Version": "copilot-chat/0.35.0",
        "Copilot-Integration-Id": "vscode-chat",
      },
    });
    if (!res.ok) {
      console.warn(`${label} Copilot token exchange failed: HTTP ${res.status}`);
      return;
    }
    const ct = await res.json();
    if (!ct.token) {
      console.warn(`${label} Copilot token exchange returned no token`);
      return;
    }
    const authPath = join(piAgentDir, "auth.json");
    let existing = {};
    try { existing = JSON.parse(readFileSync(authPath, "utf8")); } catch { /* ok */ }
    existing["github-copilot"] = {
      type: "oauth",
      refresh: token,
      access: ct.token,
      expires: ct.expires_at * 1000 - 5 * 60 * 1000,
    };
    mkdirSync(piAgentDir, { recursive: true });
    writeFileSync(authPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    console.error(`${label} Seeded Copilot auth from COPILOT_GITHUB_TOKEN`);
  } catch (err) {
    console.warn(`${label} Failed to bootstrap Copilot auth:`, err.message);
  }
}
