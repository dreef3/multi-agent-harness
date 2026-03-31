/**
 * Sub-agent runner: clones repo, runs AI coding task, commits and pushes.
 * Runs as the entrypoint of the sub-agent Docker container.
 */
import {
  createAgentSession,
  createCodingTools,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  ModelRegistry,
  AuthStorage,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync, execFileSync } from "node:child_process";
import { appendFileSync, existsSync as fsExistsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createGuardHook, createWebFetchTool } from "./tools.mjs";
import { createOutputFilterExtension } from '/app/shared/extensions/output-filter.mjs';
import { setupCopilotAuth } from '/app/shared/extensions/copilot-auth.mjs';

const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? "/pi-agent";

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

// GIT_PUSH_URL is the authenticated push URL — consumed here and cleared from env
// before the AI agent starts so the agent cannot use it for direct GitHub API calls.
const GIT_PUSH_URL = process.env.GIT_PUSH_URL || REPO_CLONE_URL;

// Repo cache dir — mounted from harness-repo-cache volume by containerManager.
// Empty string means caching is disabled; fall back to regular git clone.
const REPO_CACHE_DIR = process.env.REPO_CACHE_DIR ?? "";

// Use a session-unique worktree path so that parallel containers don't conflict
// on the same path in the shared bare-clone worktree registry.
// Each container's /workspace is an isolated overlay, but the bare clone at
// /cache/xyz/worktrees/ is shared — two containers using identical paths would
// overwrite each other's HEAD reference.
const worktreePath = AGENT_SESSION_ID
  ? `/workspace/repo-${AGENT_SESSION_ID.slice(0, 8)}`
  : `/workspace/repo`;

/** Configure git credential store and gh auth using the token in GIT_PUSH_URL. */
function setupCredentials() {
  let token, hostname;
  try {
    const parsed = new URL(GIT_PUSH_URL);
    token = parsed.password;
    hostname = parsed.hostname;
  } catch (err) {
    throw new Error(`[sub-agent] Cannot parse GIT_PUSH_URL: ${err.message}`);
  }
  if (!token) throw new Error("[sub-agent] GIT_PUSH_URL contains no password/token");

  // Git credential store
  execFileSync("git", ["config", "--global", "credential.helper", "store"], { stdio: "inherit" });
  const credLine = `https://x-access-token:${token}@${hostname}\n`;
  try {
    appendFileSync(join(homedir(), ".git-credentials"), credLine);
  } catch (err) {
    throw new Error(`[sub-agent] Failed to write ~/.git-credentials: ${err.message}`);
  }

  // gh auth (non-fatal)
  try {
    execFileSync("gh", ["auth", "login", "--with-token"], {
      input: Buffer.from(token + "\n"),
      stdio: ["pipe", "inherit", "inherit"],
    });
  } catch (err) {
    console.warn("[sub-agent] gh auth login failed (gh may not be available):", err.message);
  }
}

/** Run git with explicit args array (safe against special chars in args). */
function git(...args) {
  console.log("[sub-agent] $ git", args.map(a => (GIT_PUSH_URL && a === GIT_PUSH_URL ? "***" : a)).join(" "));
  return execFileSync("git", args, { stdio: "inherit" });
}

// ── Credential setup — must happen before clone ───────────────────────────────
setupCredentials();
delete process.env.GIT_PUSH_URL;
delete process.env.GITHUB_TOKEN;

// ── Git setup ─────────────────────────────────────────────────────────────────
const GIT_AUTHOR_NAME = process.env.GIT_COMMIT_AUTHOR_NAME ?? "Harness Bot";
const GIT_AUTHOR_EMAIL = process.env.GIT_COMMIT_AUTHOR_EMAIL ?? "harness@noreply";
git("config", "--global", "user.email", GIT_AUTHOR_EMAIL);
git("config", "--global", "user.name", GIT_AUTHOR_NAME);

// ── Clone & checkout (cache-aware) ───────────────────────────────────────────
// Sanitise clone URL to a filesystem-safe directory name for the bare repo.
const repoId = REPO_CLONE_URL.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
const cacheDir = REPO_CACHE_DIR ? `${REPO_CACHE_DIR}/${repoId}` : "";

if (cacheDir && fsExistsSync(`${cacheDir}/HEAD`)) {
  // Cache hit — fetch latest and create a worktree.
  // Use --no-prune to avoid deleting remote-tracking refs that parallel containers
  // may have checked out (prune runs on the shared bare clone and can't see other
  // containers' overlay filesystems).
  console.log("[sub-agent] Cache hit — fetching latest refs from origin...");
  execFileSync("git", ["-C", cacheDir, "fetch", "origin"], { stdio: "inherit" });

  // Use --force so we can check out a branch even if another (possibly dead) worktree
  // still has it registered. Never run `git worktree prune` here — it would cross-
  // contaminate parallel containers by removing their live worktree registrations.
  execFileSync("git", ["-C", cacheDir, "worktree", "add", "--force", worktreePath, BRANCH_NAME],
    { stdio: "inherit" }
  );
  console.log("[sub-agent] Worktree created at", worktreePath, "for branch:", BRANCH_NAME);
} else if (cacheDir) {
  // Cache miss — bare clone, then create a worktree
  console.log("[sub-agent] Cache miss — bare cloning into cache...");
  execFileSync("git", ["clone", "--bare", REPO_CLONE_URL, cacheDir], { stdio: "inherit" });
  execFileSync("git", ["-C", cacheDir, "worktree", "add", "--force", worktreePath, BRANCH_NAME],
    { stdio: "inherit" }
  );
  console.log("[sub-agent] Bare clone cached and worktree created at", worktreePath);
} else {
  // No cache configured — fallback to regular clone
  console.log("[sub-agent] No cache configured — cloning repository, branch:", BRANCH_NAME);
  git("clone", REPO_CLONE_URL, worktreePath);   // credential store handles auth
  process.chdir(worktreePath);
  git("checkout", BRANCH_NAME);
}

// When using a worktree the chdir must happen after worktree creation
if (cacheDir) process.chdir(worktreePath);

// ── Copilot auth bootstrap (PAT → auth.json) ──────────────────────────────────
await setupCopilotAuth(PI_AGENT_DIR, "[sub-agent]");

// ── Run AI agent ─────────────────────────────────────────────────────────────
console.log("[sub-agent] Running task:", TASK_DESCRIPTION);
const sessionDir = PI_AGENT_DIR;
let aiSucceeded = false;

try {
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    settingsManager,
    extensionFactories: [createOutputFilterExtension],  // replaces noExtensions: true
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
    // pi-ai hardcodes "vscode-chat" as Copilot-Integration-Id, but GitHub Copilot
    // rejects PATs for that integration ("Personal Access Tokens are not supported").
    // "copilot-developer-cli" accepts both PATs and short-lived copilot tokens.
    if (model?.provider === "github-copilot" && model.headers?.["Copilot-Integration-Id"] === "vscode-chat") {
      model = { ...model, headers: { ...model.headers, "Copilot-Integration-Id": "copilot-developer-cli" } };
    }
  } catch {
    console.warn("[sub-agent] Could not find model", AGENT_PROVIDER, AGENT_MODEL, "- using default");
  }

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

  const { session } = await createAgentSession({
    sessionManager: SessionManager.create(sessionDir, sessionDir),
    settingsManager,
    resourceLoader,
    modelRegistry,
    ...(model ? { model } : {}),
    tools: createCodingTools(worktreePath, { bash: { spawnHook: createGuardHook() } }),
    customTools: [createWebFetchTool(), askPlanningAgentTool],
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
    // Legacy log commits removed — structured tracing handled by backend TraceBuilder.
    // No file changes and no fallback log needed; exitCode remains aiSucceeded ? 0 : 1.
    console.log("[sub-agent] No file changes to commit.");
  }
  const finalDiff = execSync("git diff --cached --stat").toString().trim();
  if (finalDiff) {
    git("commit", "-m", `feat: ${TASK_DESCRIPTION.slice(0, 60)}`);
    execFileSync("git", ["push", "origin", `HEAD:${BRANCH_NAME}`], { stdio: "inherit" });
    console.log("[sub-agent] Changes pushed to branch:", BRANCH_NAME);
  } else {
    console.log("[sub-agent] No changes to commit");
  }
} catch (commitErr) {
  console.warn("[sub-agent] Commit/push failed:", commitErr.message);
  exitCode = 1;
}

// Legacy log commits removed — structured tracing handled by backend TraceBuilder.

// ── Worktree cleanup ──────────────────────────────────────────────────────────
if (cacheDir && fsExistsSync(`${cacheDir}/HEAD`)) {
  try {
    // Remove only this container's worktree — never run `git worktree prune` here
    // because prune would delete other parallel containers' live registrations
    // (their /workspace paths are invisible from this container's overlay).
    execFileSync("git", ["-C", cacheDir, "worktree", "remove", "--force", worktreePath],
      { stdio: "inherit" }
    );
    console.log("[sub-agent] Worktree removed from cache for task:", TASK_ID);
  } catch (wtErr) {
    // Non-fatal — container is about to exit anyway; the next run will handle a stale entry
    console.warn("[sub-agent] Failed to remove worktree (non-fatal):", wtErr.message);
  }
}

console.log("[sub-agent] Done, exit code:", exitCode);
process.exit(exitCode);
