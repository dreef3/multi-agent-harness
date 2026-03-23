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
// New env vars injected by containerManager
const HARNESS_API_URL = process.env.HARNESS_API_URL ?? "";
const AGENT_SESSION_ID = process.env.AGENT_SESSION_ID ?? "";

// "pi" is the correct provider for pi-coding-agent SDK (maps to Claude models in config.ts)
const AGENT_PROVIDER = process.env.AGENT_PROVIDER ?? "pi";
const AGENT_MODEL = process.env.AGENT_MODEL ?? "minimax-m2.7";
const TASK_ID = process.env.TASK_ID ?? "unknown";
const BASE_BRANCH = process.env.BASE_BRANCH ?? "main";

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

// ── Sync base branch before work ─────────────────────────────────────────────
// Fetch via authenticated URL (before origin is stripped of credentials).
console.log(`[sub-agent] Syncing base branch: ${BASE_BRANCH}`);
try {
  git("fetch", GIT_PUSH_URL, BASE_BRANCH);
  git("merge", "--no-edit", "FETCH_HEAD");
  console.log("[sub-agent] Base branch merged successfully");
} catch (syncErr) {
  const conflictMsg = syncErr.message ?? String(syncErr);
  console.error("[sub-agent] Merge conflict during base-branch sync:", conflictMsg);
  await forwardEvent("sync_conflict", {
    baseBranch: BASE_BRANCH,
    branch: BRANCH_NAME,
    error: conflictMsg,
  });
  process.exit(1);
}

// Reset origin to non-authenticated URL so the AI agent cannot push directly via bash.
// The push_branch tool (below) uses the stored GIT_PUSH_URL via a JS closure.
git("remote", "set-url", "origin", REPO_CLONE_URL);

// Remove auth credentials from env before starting the AI agent
delete process.env.GIT_PUSH_URL;
delete process.env.GITHUB_TOKEN;

/** Fire-and-forget: POST an activity event to the harness. */
async function forwardEvent(type, payload) {
  if (!HARNESS_API_URL || !AGENT_SESSION_ID) return;
  try {
    await fetch(`${HARNESS_API_URL}/api/agents/${AGENT_SESSION_ID}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload, timestamp: new Date().toISOString() }),
    });
  } catch { /* fire-and-forget */ }
}

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

  const askPlanningAgentTool = {
    name: "ask_planning_agent",
    label: "Ask Planning Agent",
    description:
      "Ask the planning agent a clarifying question when you are blocked. " +
      "This call BLOCKS until a reply arrives (up to 5 minutes). " +
      "Use only when you cannot proceed without clarification.",
    parameters: Type.Object({
      question: Type.String({ description: "Your question for the planning agent" }),
    }),
    execute: async (_toolCallId, params) => {
      if (!HARNESS_API_URL || !AGENT_SESSION_ID) {
        return {
          content: [{ type: "text", text: "HARNESS_API_URL or AGENT_SESSION_ID not configured — cannot contact planning agent." }],
          details: {},
        };
      }
      try {
        const res = await fetch(
          `${HARNESS_API_URL}/api/agents/${AGENT_SESSION_ID}/message`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: params.question }),
          }
        );
        if (!res.ok) {
          return {
            content: [{ type: "text", text: `Error contacting planning agent: HTTP ${res.status}` }],
            details: {},
          };
        }
        const data = await res.json();
        return {
          content: [{ type: "text", text: data.reply ?? "No reply received." }],
          details: {},
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to reach planning agent: ${err.message}` }],
          details: {},
        };
      }
    },
  };

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
    customTools: [askPlanningAgentTool, pushBranchTool],
  });

  // Subscribe to session events for real-time forwarding before starting
  const unsubEvents = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      void forwardEvent("tool_call", { toolName: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_end") {
      void forwardEvent("tool_result", {
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      });
    } else if (event.type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (ae && ae.type === "text_delta" && ae.delta) {
        void forwardEvent("text", { text: ae.delta });
      }
    }
  });

  // Heartbeat every 2 minutes while agent runs
  let heartbeatInterval = null;
  if (HARNESS_API_URL && AGENT_SESSION_ID) {
    heartbeatInterval = setInterval(() => {
      fetch(`${HARNESS_API_URL}/api/agents/${AGENT_SESSION_ID}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }).catch(() => {});
    }, 2 * 60 * 1000);
  }

  try {
    await session.prompt(TASK_DESCRIPTION);
    aiSucceeded = true;
    console.log("[sub-agent] AI agent completed task");
  } finally {
    unsubEvents();
    if (heartbeatInterval) clearInterval(heartbeatInterval);
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
