/**
 * Planning agent runner: clones project repos, creates a pi session
 * with custom backend tools, and runs in JSON-RPC mode for the backend
 * to communicate over stdin/stdout.
 */
import {
  createAgentSession,
  createCodingTools,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  ModelRegistry,
  AuthStorage,
  runRpcMode,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { createPlanningAgentGuardHook, createWebFetchTool } from "./tools.mjs";

const PROJECT_ID = process.env.PROJECT_ID ?? "unknown";
const BACKEND_URL = process.env.BACKEND_URL ?? "http://backend:3000";
const GIT_CLONE_URLS = process.env.GIT_CLONE_URLS ?? "[]";
// Note: GITHUB_TOKEN is NOT captured here — it is consumed and deleted in setupCredentials()
const AGENT_PROVIDER = process.env.AGENT_PROVIDER ?? "opencode-go";
const AGENT_MODEL = process.env.AGENT_MODEL;
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? "/pi-agent";

function git(...args) {
  return execFileSync("git", args, { stdio: "inherit" });
}

/** Configure git credential store and gh auth using GITHUB_TOKEN. Deletes the env var. */
function setupCredentials() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("[planning-agent] GITHUB_TOKEN not set — git/gh auth may fail");
    return;
  }

  execFileSync("git", ["config", "--global", "credential.helper", "store"], { stdio: "inherit" });
  const credLine = `https://x-access-token:${token}@github.com\n`;
  try {
    appendFileSync(join(homedir(), ".git-credentials"), credLine);
  } catch (err) {
    throw new Error(`[planning-agent] Failed to write ~/.git-credentials: ${err.message}`);
  }

  try {
    execFileSync("gh", ["auth", "login", "--with-token"], {
      input: Buffer.from(token + "\n"),
      stdio: ["pipe", "inherit", "inherit"],
    });
  } catch (err) {
    console.warn("[planning-agent] gh auth login failed (non-fatal):", err.message);
  }

  delete process.env.GITHUB_TOKEN;
}

// ── Credential setup — must happen before clone ───────────────────────────────
setupCredentials();

// ── Git setup ─────────────────────────────────────────────────────────────────
git("config", "--global", "user.email", process.env.GIT_COMMIT_AUTHOR_EMAIL ?? "harness@noreply");
git("config", "--global", "user.name", process.env.GIT_COMMIT_AUTHOR_NAME ?? "Harness Bot");

// ── Clone all project repos ───────────────────────────────────────────────────
const repos = JSON.parse(GIT_CLONE_URLS);
for (const { name, url } of repos) {
  const dest = `/workspace/${name}`;
  if (!existsSync(join(dest, ".git"))) {
    console.log(`[planning-agent] cloning ${name}...`);
    git("clone", url, dest);   // credential store handles auth
  } else {
    console.log(`[planning-agent] ${name} already cloned, fetching...`);
    execFileSync("git", ["fetch", "--all"], { cwd: dest, stdio: "inherit" });
  }
}

// ── Custom tools ──────────────────────────────────────────────────────────────

const availableReposDesc = repos.length > 0
  ? `Available repositories: ${repos.map(r => `${r.name} (id: ${r.id ?? r.name})`).join(", ")}`
  : "No repositories configured.";

const dispatchTasksTool = {
  name: "dispatch_tasks",
  label: "Dispatch Tasks",
  description: `Submit new tasks or re-dispatch failed tasks for implementation sub-agents. Provide \`id\` to re-submit an existing task (resets it to pending), or omit \`id\` for new tasks. ${availableReposDesc}`,
  parameters: Type.Object({
    tasks: Type.Array(Type.Object({
      id: Type.Optional(Type.String({ description: "Omit for new tasks; provide to re-dispatch a failed task" })),
      repositoryId: Type.String({ description: `Repository ID where this task should run. ${availableReposDesc}` }),
      description: Type.String({ description: "Full self-contained task description for the sub-agent" }),
    })),
  }),
  execute: async (_toolCallId, params) => {
    const res = await fetch(`${BACKEND_URL}/api/projects/${PROJECT_ID}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks: params.tasks }),
    });
    if (!res.ok) {
      return { content: [{ type: "text", text: `Error: backend returned ${res.status} ${res.statusText}` }], details: {} };
    }
    const data = await res.json();
    return {
      content: [{ type: "text", text: `Dispatched ${data.dispatched} task(s). Sub-agents are running.` }],
      details: {},
    };
  },
};

const writePlanningDocumentTool = {
  name: "write_planning_document",
  label: "Write Planning Document",
  description:
    'Write a planning document to the project\'s planning branch in the primary repository. ' +
    'Call with type "spec" first to write the design spec and open the PR. ' +
    'Call with type "plan" after spec is approved (LGTM received) to write the implementation plan. ' +
    'Returns the PR URL. Use this tool to create planning PRs. To create other PRs, use `gh pr create` directly.',
  parameters: Type.Object({
    type: Type.Union([Type.Literal("spec"), Type.Literal("plan")], { description: '"spec" or "plan"' }),
    content: Type.String({ description: "Full Markdown content of the document" }),
  }),
  execute: async (_toolCallId, params) => {
    const res = await fetch(`${BACKEND_URL}/api/projects/${PROJECT_ID}/planning-document`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: params.type, content: params.content }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status} ${res.statusText}` }));
      return { content: [{ type: "text", text: `Error: ${err.error ?? JSON.stringify(err)}` }], details: {} };
    }
    const data = await res.json();
    return {
      content: [{ type: "text", text: `PR created/updated at: ${data.prUrl}` }],
      details: {},
    };
  },
};

const getTaskStatusTool = {
  name: "get_task_status",
  label: "Get Task Status",
  description: "Get the current status of all tasks for this project, including error messages for failed tasks.",
  parameters: Type.Object({}),
  execute: async () => {
    const res = await fetch(`${BACKEND_URL}/api/projects/${PROJECT_ID}/tasks`);
    if (!res.ok) {
      return { content: [{ type: "text", text: `Error: backend returned ${res.status} ${res.statusText}` }], details: {} };
    }
    const data = await res.json();
    const summary = data.tasks.map(t =>
      `- [${t.status}] ${t.id}: ${t.description.slice(0, 60)}${t.errorMessage ? ` — ERROR: ${t.errorMessage}` : ""}`
    ).join("\n") || "(no tasks)";
    return {
      content: [{ type: "text", text: `Tasks:\n${summary}` }],
      details: {},
    };
  },
};

const getPullRequestsTool = {
  name: "get_pull_requests",
  label: "Get Pull Requests",
  description: "List pull requests created by implementation sub-agents for this project.",
  parameters: Type.Object({}),
  execute: async () => {
    const res = await fetch(`${BACKEND_URL}/api/pull-requests/project/${PROJECT_ID}`);
    if (!res.ok) {
      return { content: [{ type: "text", text: `Error: backend returned ${res.status} ${res.statusText}` }], details: {} };
    }
    const data = await res.json();
    const prs = Array.isArray(data) ? data : data.pullRequests ?? [];
    const summary = prs.map(pr =>
      `- [${pr.status}] ${pr.title ?? pr.branch}: ${pr.url}`
    ).join("\n") || "(no pull requests yet)";
    return {
      content: [{ type: "text", text: `Pull Requests:\n${summary}` }],
      details: {},
    };
  },
};

const replyToSubagentTool = {
  name: "reply_to_subagent",
  label: "Reply to Sub-agent",
  description:
    'Reply to a sub-agent that is waiting for clarification. ' +
    'Copy the msgId EXACTLY from the system message that delivered the question ' +
    '(it appears as "[msgId: abc-123-...]"). ' +
    'Try to answer autonomously first; only ask the human user if you truly lack the information.',
  parameters: Type.Object({
    msgId: Type.String({ description: "The UUID from [msgId: ...] in the injected message — copy it exactly" }),
    sessionId: Type.String({ description: "The sub-agent session ID from the injected message" }),
    reply: Type.String({ description: "Your answer to the sub-agent's question" }),
  }),
  execute: async (_toolCallId, params) => {
    const res = await fetch(
      `${BACKEND_URL}/api/agents/${params.sessionId}/message/${params.msgId}/reply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: params.reply }),
      }
    );
    if (!res.ok) {
      return {
        content: [{ type: "text", text: `Error delivering reply: ${res.status} ${res.statusText}` }],
        details: {},
      };
    }
    return {
      content: [{ type: "text", text: "Reply delivered. Sub-agent will continue." }],
      details: {},
    };
  },
};

// ── Catch unhandled errors globally ───────────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("[planning-agent] uncaughtException:", err?.message ?? err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[planning-agent] unhandledRejection:", reason instanceof Error ? reason.message : reason);
  process.exit(1);
});

// ── Session setup ─────────────────────────────────────────────────────────────
console.error(`[planning-agent] initialising session — provider=${AGENT_PROVIDER} model=${AGENT_MODEL ?? "(default)"}`);

const sessionDir = join(PI_AGENT_DIR, "sessions");
mkdirSync(sessionDir, { recursive: true });
const sessionPath = join(sessionDir, `planning-${PROJECT_ID}.jsonl`);

const settingsManager = SettingsManager.inMemory();

const systemPromptTemplate = readFileSync("/app/system-prompt.md", "utf8");
const systemPrompt = systemPromptTemplate.replace("{{PROJECT_ID}}", PROJECT_ID);

const resourceLoader = new DefaultResourceLoader({
  settingsManager,
  noExtensions: true,
  noPromptTemplates: true,
  noThemes: true,
  systemPrompt,
});
console.error("[planning-agent] loading resources...");
await resourceLoader.reload();
console.error("[planning-agent] resources loaded");

const authStorage = AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);

let model;
if (AGENT_MODEL) {
  try {
    model = modelRegistry.find(AGENT_PROVIDER, AGENT_MODEL);
    console.error(`[planning-agent] model resolved: ${model?.id ?? "(unknown)"}`);
  } catch (err) {
    console.error(`[planning-agent] modelRegistry.find failed (using default):`, err?.message ?? err);
  }
}

const sessionManager = existsSync(sessionPath)
  ? SessionManager.open(sessionPath)
  : SessionManager.create(PI_AGENT_DIR, sessionDir);

console.error("[planning-agent] creating agent session...");
let session;
try {
  const result = await createAgentSession({
    sessionManager,
    settingsManager,
    resourceLoader,
    modelRegistry,
    authStorage,
    cwd: "/workspace",
    ...(model ? { model } : {}),
    tools: createCodingTools("/workspace", { bash: { spawnHook: createPlanningAgentGuardHook() } }),
    customTools: [createWebFetchTool(), writePlanningDocumentTool, dispatchTasksTool, getTaskStatusTool, getPullRequestsTool, replyToSubagentTool],
  });
  session = result.session;
} catch (err) {
  console.error("[planning-agent] createAgentSession failed:", err?.message ?? err, err?.stack ?? "");
  process.exit(1);
}

console.error(`[planning-agent] session ready for project ${PROJECT_ID}`);

// ── TCP RPC bridge ─────────────────────────────────────────────────────────────
// Docker attach stdin writes don't reliably reach the container through haproxy-based
// socket proxies. Instead we expose a TCP server on port 3333 so the backend can
// connect directly over the Docker network, bypassing the proxy entirely.
const TCP_RPC_PORT = 3333;

// PassThrough that acts as the RPC stdin; runRpcMode will read from process.stdin,
// so we redirect process.stdin to this stream.
const stdinProxy = new PassThrough();
Object.defineProperty(process, "stdin", { get: () => stdinProxy, configurable: true });

// Track connected sockets; we forward RPC output to all of them.
const rpcSockets = new Set();

// runRpcMode captures process.stdout.write at startup as rawStdoutWrite, then
// redirects process.stdout.write to stderr. By replacing it here first, rawStdoutWrite
// will point to our socket broadcaster, so all JSON RPC output goes to connected clients.
process.stdout.write = function (chunk, encoding, callback) {
  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8");
  for (const socket of rpcSockets) {
    if (!socket.destroyed) socket.write(data);
  }
  if (typeof encoding === "function") encoding(null);
  else if (typeof callback === "function") callback(null);
  return true;
};

const tcpServer = createServer((socket) => {
  console.error(`[planning-agent] RPC client connected`);
  rpcSockets.add(socket);
  socket.on("data", (chunk) => stdinProxy.write(chunk));
  socket.on("close", () => { rpcSockets.delete(socket); console.error("[planning-agent] RPC client disconnected"); });
  socket.on("error", (err) => { rpcSockets.delete(socket); console.error("[planning-agent] RPC socket error:", err.message); });
});

await new Promise((resolve) => tcpServer.listen(TCP_RPC_PORT, "0.0.0.0", () => {
  console.error(`[planning-agent] TCP RPC server listening on port ${TCP_RPC_PORT}`);
  resolve();
}));

await runRpcMode(session);
