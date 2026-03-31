/**
 * Bootstrap GitHub Copilot auth.json from a PAT.
 *
 * Reads COPILOT_GITHUB_TOKEN and writes it directly as the access token into
 * <piAgentDir>/auth.json so pi-coding-agent can use the github-copilot provider.
 *
 * Fine-grained PATs are used directly as Bearer tokens against
 * api.individual.githubcopilot.com — no token exchange is needed or attempted.
 * Expiry is set 1 year out so pi-ai never tries to auto-refresh during a run.
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
    const authPath = join(piAgentDir, "auth.json");
    let existing = {};
    try { existing = JSON.parse(readFileSync(authPath, "utf8")); } catch { /* ok */ }
    existing["github-copilot"] = {
      type: "oauth",
      refresh: token,
      access: token,
      expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    };
    mkdirSync(piAgentDir, { recursive: true });
    writeFileSync(authPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    console.error(`${label} Seeded Copilot auth from COPILOT_GITHUB_TOKEN`);
  } catch (err) {
    console.warn(`${label} Failed to bootstrap Copilot auth:`, err.message);
  }
}
