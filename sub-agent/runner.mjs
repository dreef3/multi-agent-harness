/**
 * Sub-agent runner: clones repo, runs AI coding task, commits and pushes.
 * Runs as the entrypoint of the sub-agent Docker container.
 */
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  ModelRegistry,
  AuthStorage,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync, execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, copyFileSync, existsSync as fsExistsSync } from "node:fs";
import { join } from "node:path";

const REPO_CLONE_URL = process.env.REPO_CLONE_URL ?? "";
const BRANCH_NAME = process.env.BRANCH_NAME ?? "";
const TASK_DESCRIPTION =
  process.env.TASK_DESCRIPTION ??
  "Create a file called task-complete.md with the content '# Task Complete'";
const AGENT_PROVIDER = process.env.AGENT_PROVIDER ?? "opencode-go";
const AGENT_MODEL = process.env.AGENT_MODEL ?? "minimax-m2.7";
const TASK_ID = process.env.TASK_ID ?? "unknown";

// GIT_PUSH_URL is the authenticated push URL — consumed here and cleared from env
// before the AI agent starts so the agent cannot use it for direct GitHub API calls.
const GIT_PUSH_URL = process.env.GIT_PUSH_URL || REPO_CLONE_URL;

/** Run git with explicit args array (safe against special chars in args). */
function git(...args) {
  console.log("[sub-agent] $ git", args.map(a => (GIT_PUSH_URL && a === GIT_PUSH_URL ? "***" : a)).join(" "));
  return execFileSync("git", args, { stdio: "inherit" });
}

// ── Git setup ────────────────────────────────────────────────────────────────
const GIT_AUTHOR_NAME = process.env.GIT_COMMIT_AUTHOR_NAME ?? "Harness Bot";
const GIT_AUTHOR_EMAIL = process.env.GIT_COMMIT_AUTHOR_EMAIL ?? "harness@noreply";
git("config", "--global", "user.email", GIT_AUTHOR_EMAIL);
git("config", "--global", "user.name", GIT_AUTHOR_NAME);

// ── Clone & checkout ─────────────────────────────────────────────────────────
console.log("[sub-agent] Cloning repository, branch:", BRANCH_NAME);
git("clone", GIT_PUSH_URL, "/workspace/repo");
process.chdir("/workspace/repo");
git("checkout", BRANCH_NAME);

// Reset origin to non-authenticated URL so the AI agent cannot push directly via bash.
// The push_branch tool (below) uses the stored GIT_PUSH_URL via a JS closure.
git("remote", "set-url", "origin", REPO_CLONE_URL);

// Remove auth credentials from env before starting the AI agent
delete process.env.GIT_PUSH_URL;
delete process.env.GITHUB_TOKEN;

// ── Run AI agent ─────────────────────────────────────────────────────────────
console.log("[sub-agent] Running task:", TASK_DESCRIPTION);
const sessionDir = process.env.PI_CODING_AGENT_DIR ?? "/pi-agent";
let aiSucceeded = false;

try {
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await resourceLoader.reload();

  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  let model;
  try {
    model = modelRegistry.find(AGENT_PROVIDER, AGENT_MODEL);
  } catch {
    console.warn("[sub-agent] Could not find model", AGENT_PROVIDER, AGENT_MODEL, "- using default");
  }

  // push_branch tool — uses the authenticated GIT_PUSH_URL from the JS closure.
  // The agent MUST use this tool to push; direct `git push` will fail (origin has no auth).
  const pushBranchTool = {
    name: "push_branch",
    label: "Push Branch",
    description: `Push committed changes to the remote branch (${BRANCH_NAME}). Call this after committing your changes. Do NOT use git push directly — it will fail. Use this tool instead.`,
    parameters: Type.Object({}),
    execute: async () => {
      try {
        execFileSync("git", ["push", GIT_PUSH_URL, `HEAD:${BRANCH_NAME}`], { stdio: "pipe" });
        return { content: [{ type: "text", text: `Changes pushed to ${BRANCH_NAME}` }], details: {} };
      } catch (err) {
        return { content: [{ type: "text", text: `Push failed: ${err.message}` }], details: {} };
      }
    },
  };

  const { session } = await createAgentSession({
    sessionManager: SessionManager.create(sessionDir, sessionDir),
    settingsManager,
    resourceLoader,
    modelRegistry,
    ...(model ? { model } : {}),
    customTools: [pushBranchTool],
  });

  try {
    await session.prompt(TASK_DESCRIPTION);
    aiSucceeded = true;
    console.log("[sub-agent] AI agent completed task");
  } finally {
    session.dispose();
  }
} catch (err) {
  console.error("[sub-agent] AI agent error:", err.message);
}

// ── Commit & push ─────────────────────────────────────────────────────────────
let exitCode = aiSucceeded ? 0 : 1;

try {
  git("add", "-A");
  const diff = execSync("git diff --cached --stat").toString().trim();
  if (!diff) {
    const note = aiSucceeded
      ? "AI agent completed but made no file changes."
      : "AI agent unavailable; placeholder created.";
    writeFileSync(
      "task-output.md",
      `# Task Output\n\nTask: ${TASK_DESCRIPTION}\n\nNote: ${note}\nCompleted at: ${new Date().toISOString()}\n`
    );
    git("add", "-A");
  }
  const finalDiff = execSync("git diff --cached --stat").toString().trim();
  if (finalDiff) {
    git("commit", "-m", `feat: ${TASK_DESCRIPTION.slice(0, 60)}`);
    execFileSync("git", ["push", GIT_PUSH_URL, `HEAD:${BRANCH_NAME}`], { stdio: "inherit" });
    console.log("[sub-agent] Changes pushed to branch:", BRANCH_NAME);
  } else {
    console.log("[sub-agent] No changes to commit");
  }
} catch (commitErr) {
  console.warn("[sub-agent] Commit/push failed:", commitErr.message);
  exitCode = 1;
}

// ── Commit session log ────────────────────────────────────────────────────────
try {
  const sessionJsonl = join(sessionDir, "session.jsonl");
  const logDir = `.harness/logs/sub-agents/${TASK_ID}`;
  const logDest = `${logDir}/session.jsonl`;

  if (fsExistsSync(sessionJsonl)) {
    mkdirSync(logDir, { recursive: true });
    copyFileSync(sessionJsonl, logDest);
    git("add", logDest);
    const logDiff = execSync("git diff --cached --stat").toString().trim();
    if (logDiff) {
      git("commit", "-m", `chore: add agent log for task ${TASK_ID}`);
      execFileSync("git", ["push", GIT_PUSH_URL, `HEAD:${BRANCH_NAME}`], { stdio: "inherit" });
      console.log("[sub-agent] Session log committed for task:", TASK_ID);
    }
  } else {
    console.warn("[sub-agent] No session.jsonl found at:", sessionJsonl);
  }
} catch (logErr) {
  // Best-effort — do not change exit code
  console.warn("[sub-agent] Failed to commit session log:", logErr.message);
}

console.log("[sub-agent] Done, exit code:", exitCode);
process.exit(exitCode);
