# Agent Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the auth-token-stripping / custom-tool-substitution approach with credential pre-configuration, `BashSpawnHook` command blocking, and a safe `web_fetch` tool in both agent containers.

**Architecture:** Extract shared tool logic (guard hook + web_fetch) into `tools.mjs` within each agent package so it can be unit-tested independently. Runners import from `./tools.mjs` and wire everything into `createAgentSession`. Dockerfiles gain `gh` CLI and a `COPY tools.mjs` line.

**Tech Stack:** Node.js ESM, `@mariozechner/pi-coding-agent` (`createCodingTools`, `BashSpawnHook`), `@sinclair/typebox`, `node:test` (built-in test runner), `node:fs`, `node:os`, `node:child_process`

**Spec:** `docs/superpowers/specs/2026-03-23-agent-security-hardening-design.md`

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `sub-agent/tools.mjs` | **Create** | Guard hook + web_fetch tool for sub-agent |
| `sub-agent/tools.test.mjs` | **Create** | Unit tests for sub-agent tools.mjs |
| `sub-agent/runner.mjs` | **Modify** | Credential setup, import tools, remove push_branch |
| `sub-agent/Dockerfile` | **Modify** | Install gh CLI, add `COPY tools.mjs` |
| `planning-agent/tools.mjs` | **Create** | Guard hook (+ gh pr create block) + web_fetch tool |
| `planning-agent/tools.test.mjs` | **Create** | Unit tests for planning-agent tools.mjs |
| `planning-agent/runner.mjs` | **Modify** | Credential setup before clone, import tools, simplify clone |
| `planning-agent/Dockerfile` | **Modify** | Install gh CLI, add `COPY tools.mjs` |

---

## Task 1: Create and test `sub-agent/tools.mjs`

**Files:**
- Create: `sub-agent/tools.mjs`
- Create: `sub-agent/tools.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `sub-agent/tools.test.mjs`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGuardHook } from "./tools.mjs";

describe("createGuardHook", () => {
  const hook = createGuardHook();

  function run(command) {
    const result = hook({ command, cwd: "/tmp", env: {} });
    const blocked = result.command.includes("Blocked:");
    return { blocked, command: result.command };
  }

  // ── Allowed ──────────────────────────────────────────────────────────────────
  test("allows normal git push", () => assert.equal(run("git push origin main").blocked, false));
  test("allows git commit", () => assert.equal(run("git commit -m 'feat: x'").blocked, false));
  test("allows gh pr view", () => assert.equal(run("gh pr view 42").blocked, false));
  test("allows gh pr edit", () => assert.equal(run("gh pr edit 42 --title x").blocked, false));
  test("allows gh pr list", () => assert.equal(run("gh pr list").blocked, false));
  test("does not block echo of blocked string", () =>
    assert.equal(run("echo 'do not git push --force'").blocked, false));

  // ── Blocked: destructive git ──────────────────────────────────────────────────
  test("blocks git push --force", () => assert.equal(run("git push --force origin main").blocked, true));
  test("blocks git push -f", () => assert.equal(run("git push -f origin main").blocked, true));
  test("blocks git push --force-with-lease", () =>
    assert.equal(run("git push --force-with-lease origin main").blocked, true));
  test("blocks git push --delete", () => assert.equal(run("git push --delete origin branch").blocked, true));
  test("blocks git push -d", () => assert.equal(run("git push -d origin branch").blocked, true));
  test("blocks git push with embedded token", () =>
    assert.equal(run("git push https://x-access-token:ghp_abc@github.com/org/repo main").blocked, true));
  test("blocks git branch -D", () => assert.equal(run("git branch -D my-branch").blocked, true));
  test("blocks git branch --delete", () => assert.equal(run("git branch --delete my-branch").blocked, true));
  test("blocks git branch -d", () => assert.equal(run("git branch -d my-branch").blocked, true));

  // ── Blocked: destructive gh ───────────────────────────────────────────────────
  test("blocks gh repo delete", () => assert.equal(run("gh repo delete org/repo").blocked, true));
  test("blocks gh repo edit", () => assert.equal(run("gh repo edit --visibility private").blocked, true));
  test("blocks gh api", () => assert.equal(run("gh api repos/org/repo -X DELETE").blocked, true));

  // ── Blocked: network tools ────────────────────────────────────────────────────
  test("blocks curl", () => assert.equal(run("curl https://example.com").blocked, true));
  test("blocks wget", () => assert.equal(run("wget https://example.com").blocked, true));
  test("blocks http (httpie)", () => assert.equal(run("http GET https://example.com").blocked, true));

  // ── Extra patterns ────────────────────────────────────────────────────────────
  test("allows gh pr create when no extra patterns", () =>
    assert.equal(run("gh pr create --title x").blocked, false));
  test("blocks extra pattern when provided", () => {
    const hookWithExtra = createGuardHook([
      [["gh", "pr", "create"], "Use write_planning_document instead."],
    ]);
    assert.equal(hookWithExtra({ command: "gh pr create --title x", cwd: "/tmp", env: {} })
      .command.includes("Blocked:"), true);
  });
});

describe("createWebFetchTool (SSRF block)", async () => {
  // Import dynamically so guard tests run even if web_fetch has issues
  const { createWebFetchTool } = await import("./tools.mjs");
  const tool = createWebFetchTool();

  async function fetch_(url) {
    return tool.execute("id", { url });
  }

  test("blocks localhost", async () => {
    const r = await fetch_("http://localhost/foo");
    assert.match(r.content[0].text, /Blocked/);
  });
  test("blocks 127.0.0.1", async () => {
    const r = await fetch_("http://127.0.0.1/foo");
    assert.match(r.content[0].text, /Blocked/);
  });
  test("blocks 10.x range", async () => {
    const r = await fetch_("http://10.0.0.1/foo");
    assert.match(r.content[0].text, /Blocked/);
  });
  test("blocks 169.254.169.254 (metadata)", async () => {
    const r = await fetch_("http://169.254.169.254/latest/meta-data");
    assert.match(r.content[0].text, /Blocked/);
  });
  test("returns error for invalid URL", async () => {
    const r = await fetch_("not-a-url");
    assert.match(r.content[0].text, /invalid URL/i);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/ae/multi-agent-harness
node --test sub-agent/tools.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` or similar — `tools.mjs` does not exist yet.

- [ ] **Step 3: Create `sub-agent/tools.mjs`**

```js
/**
 * Shared agent tools: guard hook (BashSpawnHook) and web_fetch custom tool.
 * Imported by runner.mjs. Extracted for testability.
 */
import { Type } from "@sinclair/typebox";

// ── Guard hook ────────────────────────────────────────────────────────────────

/**
 * Patterns blocked in all agents.
 * Each entry: [tokenSequence, userFacingMessage]
 */
const BASE_BLOCKED = [
  [["git", "push", "--force"],            "Force push is blocked. Use regular git push."],
  [["git", "push", "-f"],                 "Force push is blocked. Use regular git push."],
  [["git", "push", "--force-with-lease"], "Force push is blocked. Use regular git push."],
  [["git", "push", "--delete"],           "Deleting remote refs via push is blocked."],
  [["git", "push", "-d"],                 "Deleting remote refs via push is blocked."],
  [["git", "branch", "-D"],               "Branch deletion is blocked."],
  [["git", "branch", "--delete"],         "Branch deletion is blocked."],
  [["git", "branch", "-d"],               "Branch deletion is blocked."],
  [["gh", "repo", "delete"],              "Repository deletion is blocked."],
  [["gh", "repo", "edit"],                "Repository settings changes are blocked."],
  [["gh", "api"],                         "Direct gh API calls are blocked."],
  [["curl"],                              "Use the web_fetch tool instead of curl."],
  [["wget"],                              "Use the web_fetch tool instead of wget."],
  [["http"],                              "Use the web_fetch tool instead of http/httpie."],
];

function hasEmbeddedTokenUrl(tokens) {
  return (
    tokens[0] === "git" &&
    tokens[1] === "push" &&
    tokens.slice(2).some(t => t.startsWith("https://") && t.includes("@"))
  );
}

/**
 * Create a BashSpawnHook that blocks destructive commands.
 *
 * @param {Array<[string[], string]>} extraBlocked  Additional [tokenPattern, message] pairs.
 *   Example: [[["gh", "pr", "create"], "Use write_planning_document instead."]]
 */
export function createGuardHook(extraBlocked = []) {
  const patterns = [...BASE_BLOCKED, ...extraBlocked];

  return function guardHook(context) {
    try {
      const tokens = context.command.trimStart().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return context;

      if (hasEmbeddedTokenUrl(tokens)) {
        return {
          ...context,
          command: `printf 'Blocked: git push with an embedded credential URL is not allowed.\\n' >&2; exit 1`,
        };
      }

      for (const [pattern, message] of patterns) {
        if (tokens.length < pattern.length) continue;
        if (pattern.every((tok, i) => tokens[i] === tok)) {
          const safe = message.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
          return {
            ...context,
            command: `printf 'Blocked: ${safe}\\n' >&2; exit 1`,
          };
        }
      }
    } catch (err) {
      console.warn("[guard] hook error, allowing command through:", err?.message ?? err);
    }
    return context;
  };
}

// ── web_fetch tool ────────────────────────────────────────────────────────────

const PRIVATE_IP_RE = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,   // link-local + cloud metadata (169.254.169.254)
];

function isPrivateHost(hostname) {
  if (hostname === "localhost") return true;
  return PRIVATE_IP_RE.some(re => re.test(hostname));
}

const MAX_RESPONSE_BYTES = 200 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Create the web_fetch custom tool.
 * Blocks private/metadata IP ranges, enforces 30s timeout and 200 KB cap.
 */
export function createWebFetchTool() {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch the content of a URL. Use this instead of curl or wget. " +
      "Private IPs and localhost are blocked.",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
      method: Type.Optional(
        Type.Union([Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT")]),
        { default: "GET" }
      ),
      body: Type.Optional(Type.String({ description: "Request body for POST/PUT" })),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Request headers as key-value pairs",
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      let hostname;
      try {
        hostname = new URL(params.url).hostname;
      } catch {
        return { content: [{ type: "text", text: "Error: invalid URL" }], details: {} };
      }

      if (isPrivateHost(hostname)) {
        return {
          content: [{ type: "text", text: `Blocked: requests to ${hostname} are not allowed.` }],
          details: {},
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const res = await fetch(params.url, {
          method: params.method ?? "GET",
          headers: params.headers ?? {},
          body: params.body,
          signal: controller.signal,
        });
        clearTimeout(timer);

        const buf = await res.arrayBuffer();
        const truncated = buf.byteLength > MAX_RESPONSE_BYTES;
        let text = new TextDecoder().decode(
          truncated ? buf.slice(0, MAX_RESPONSE_BYTES) : buf
        );
        if (truncated) text += `\n\n[Response truncated at ${MAX_RESPONSE_BYTES} bytes]`;

        if (!res.ok) {
          return {
            content: [{ type: "text", text: `Error: HTTP ${res.status} ${res.statusText}\n${text}` }],
            details: {},
          };
        }
        return { content: [{ type: "text", text }], details: {} };
      } catch (err) {
        clearTimeout(timer);
        return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {} };
      }
    },
  };
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
node --test sub-agent/tools.test.mjs
```

Expected: all tests pass. SSRF tests pass without a real network call.

- [ ] **Step 5: Commit**

```bash
git add sub-agent/tools.mjs sub-agent/tools.test.mjs
git commit -m "feat(sub-agent): add guard hook and web_fetch tool"
```

---

## Task 2: Create and test `planning-agent/tools.mjs`

**Files:**
- Create: `planning-agent/tools.mjs`
- Create: `planning-agent/tools.test.mjs`

The planning-agent version is identical to sub-agent except `createGuardHook` is pre-called with the `gh pr create` extra block and exported as `createPlanningAgentGuardHook`.

- [ ] **Step 1: Write the failing tests**

Create `planning-agent/tools.test.mjs`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createPlanningAgentGuardHook } from "./tools.mjs";

describe("createPlanningAgentGuardHook", () => {
  const hook = createPlanningAgentGuardHook();

  function blocked(command) {
    return hook({ command, cwd: "/tmp", env: {} }).command.includes("Blocked:");
  }

  // Inherits all base blocks
  test("blocks git push --force", () => assert.equal(blocked("git push --force"), true));
  test("blocks curl", () => assert.equal(blocked("curl https://x.com"), true));
  test("blocks gh api", () => assert.equal(blocked("gh api repos/x -X DELETE"), true));

  // Planning-agent-specific block
  test("blocks gh pr create", () => assert.equal(blocked("gh pr create --title x"), true));
  test("gh pr create block message mentions write_planning_document", () => {
    const result = hook({ command: "gh pr create --title x", cwd: "/tmp", env: {} });
    assert.match(result.command, /write_planning_document/);
  });

  // gh pr edit is allowed
  test("allows gh pr edit", () => assert.equal(blocked("gh pr edit 42 --title x"), false));
  test("allows gh pr list", () => assert.equal(blocked("gh pr list"), false));
  test("allows normal git push", () => assert.equal(blocked("git push origin main"), false));
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test planning-agent/tools.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` — `planning-agent/tools.mjs` does not exist yet.

- [ ] **Step 3: Create `planning-agent/tools.mjs`**

```js
/**
 * Shared agent tools for the planning agent.
 * Re-exports web_fetch and provides createPlanningAgentGuardHook.
 *
 * NOTE: web_fetch implementation is duplicated from sub-agent/tools.mjs
 * because these are separate Docker images with no shared file system.
 */
import { Type } from "@sinclair/typebox";

// ── Guard hook ────────────────────────────────────────────────────────────────

const BASE_BLOCKED = [
  [["git", "push", "--force"],            "Force push is blocked. Use regular git push."],
  [["git", "push", "-f"],                 "Force push is blocked. Use regular git push."],
  [["git", "push", "--force-with-lease"], "Force push is blocked. Use regular git push."],
  [["git", "push", "--delete"],           "Deleting remote refs via push is blocked."],
  [["git", "push", "-d"],                 "Deleting remote refs via push is blocked."],
  [["git", "branch", "-D"],               "Branch deletion is blocked."],
  [["git", "branch", "--delete"],         "Branch deletion is blocked."],
  [["git", "branch", "-d"],               "Branch deletion is blocked."],
  [["gh", "repo", "delete"],              "Repository deletion is blocked."],
  [["gh", "repo", "edit"],                "Repository settings changes are blocked."],
  [["gh", "api"],                         "Direct gh API calls are blocked."],
  [["curl"],                              "Use the web_fetch tool instead of curl."],
  [["wget"],                              "Use the web_fetch tool instead of wget."],
  [["http"],                              "Use the web_fetch tool instead of http/httpie."],
];

const PLANNING_AGENT_EXTRA = [
  [["gh", "pr", "create"], "Use the write_planning_document tool to create planning PRs."],
];

function hasEmbeddedTokenUrl(tokens) {
  return (
    tokens[0] === "git" &&
    tokens[1] === "push" &&
    tokens.slice(2).some(t => t.startsWith("https://") && t.includes("@"))
  );
}

function makeGuardHook(patterns) {
  return function guardHook(context) {
    try {
      const tokens = context.command.trimStart().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return context;

      if (hasEmbeddedTokenUrl(tokens)) {
        return {
          ...context,
          command: `printf 'Blocked: git push with an embedded credential URL is not allowed.\\n' >&2; exit 1`,
        };
      }

      for (const [pattern, message] of patterns) {
        if (tokens.length < pattern.length) continue;
        if (pattern.every((tok, i) => tokens[i] === tok)) {
          const safe = message.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
          return {
            ...context,
            command: `printf 'Blocked: ${safe}\\n' >&2; exit 1`,
          };
        }
      }
    } catch (err) {
      console.warn("[guard] hook error, allowing command through:", err?.message ?? err);
    }
    return context;
  };
}

/** Guard hook with planning-agent-specific blocks (includes gh pr create). */
export function createPlanningAgentGuardHook() {
  return makeGuardHook([...BASE_BLOCKED, ...PLANNING_AGENT_EXTRA]);
}

// ── web_fetch tool ────────────────────────────────────────────────────────────
// Identical to sub-agent/tools.mjs — duplicated because these are separate Docker images.

const PRIVATE_IP_RE = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
];

function isPrivateHost(hostname) {
  if (hostname === "localhost") return true;
  return PRIVATE_IP_RE.some(re => re.test(hostname));
}

const MAX_RESPONSE_BYTES = 200 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export function createWebFetchTool() {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch the content of a URL. Use this instead of curl or wget. " +
      "Private IPs and localhost are blocked.",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
      method: Type.Optional(
        Type.Union([Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT")]),
        { default: "GET" }
      ),
      body: Type.Optional(Type.String({ description: "Request body for POST/PUT" })),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Request headers as key-value pairs",
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      let hostname;
      try {
        hostname = new URL(params.url).hostname;
      } catch {
        return { content: [{ type: "text", text: "Error: invalid URL" }], details: {} };
      }

      if (isPrivateHost(hostname)) {
        return {
          content: [{ type: "text", text: `Blocked: requests to ${hostname} are not allowed.` }],
          details: {},
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const res = await fetch(params.url, {
          method: params.method ?? "GET",
          headers: params.headers ?? {},
          body: params.body,
          signal: controller.signal,
        });
        clearTimeout(timer);

        const buf = await res.arrayBuffer();
        const truncated = buf.byteLength > MAX_RESPONSE_BYTES;
        let text = new TextDecoder().decode(
          truncated ? buf.slice(0, MAX_RESPONSE_BYTES) : buf
        );
        if (truncated) text += `\n\n[Response truncated at ${MAX_RESPONSE_BYTES} bytes]`;

        if (!res.ok) {
          return {
            content: [{ type: "text", text: `Error: HTTP ${res.status} ${res.statusText}\n${text}` }],
            details: {},
          };
        }
        return { content: [{ type: "text", text }], details: {} };
      } catch (err) {
        clearTimeout(timer);
        return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {} };
      }
    },
  };
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
node --test planning-agent/tools.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add planning-agent/tools.mjs planning-agent/tools.test.mjs
git commit -m "feat(planning-agent): add guard hook and web_fetch tool"
```

---

## Task 3: Update `sub-agent/runner.mjs` and Dockerfile

**Files:**
- Modify: `sub-agent/runner.mjs`
- Modify: `sub-agent/Dockerfile`

### 3a — Dockerfile

- [ ] **Step 1: Add `gh` CLI install and `COPY tools.mjs` to `sub-agent/Dockerfile`**

Current `sub-agent/Dockerfile` `RUN apt-get` block ends at the `nodejs` install. Add `gh` installation using the official apt source. Replace the existing `RUN apt-get` block with:

```dockerfile
RUN apt-get update && apt-get install -y \
    git \
    default-jdk \
    maven \
    build-essential \
    python3 \
    curl \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       | tee /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
```

Also add `COPY --chown=bun:bun tools.mjs .` immediately after the existing `COPY --chown=bun:bun runner.mjs .` line.

The bottom of the Dockerfile should become:

```dockerfile
COPY --chown=bun:bun runner.mjs .
COPY --chown=bun:bun tools.mjs .
```

- [ ] **Step 2: Verify Dockerfile parses (no Docker build needed — just visual check)**

Read `sub-agent/Dockerfile` and confirm it looks correct.

### 3b — runner.mjs

- [ ] **Step 3: Update imports at the top of `sub-agent/runner.mjs`**

Add `createCodingTools` to the pi-coding-agent import and add new Node.js imports. Change:

```js
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
```

To:

```js
import {
  createAgentSession,
  createCodingTools,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  ModelRegistry,
  AuthStorage,
} from "@mariozechner/pi-coding-agent";
import { execSync, execFileSync } from "node:child_process";
import { writeFileSync, appendFileSync, mkdirSync, copyFileSync, existsSync as fsExistsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createGuardHook, createWebFetchTool } from "./tools.mjs";
```

Note: `Type` from `@sinclair/typebox` is no longer needed (tools are in tools.mjs).

- [ ] **Step 4: Add `setupCredentials()` function after the env var declarations (after line ~34)**

Insert this function after the `const GIT_PUSH_URL = ...` line and before the `git()` helper:

```js
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
```

- [ ] **Step 5: Replace the Git setup / clone / credential-deletion block**

Find and replace the current block (lines ~42–60):

```js
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
```

With:

```js
// ── Credential setup — must happen before clone ───────────────────────────────
setupCredentials();
delete process.env.GIT_PUSH_URL;
delete process.env.GITHUB_TOKEN;

// ── Git setup ─────────────────────────────────────────────────────────────────
const GIT_AUTHOR_NAME = process.env.GIT_COMMIT_AUTHOR_NAME ?? "Harness Bot";
const GIT_AUTHOR_EMAIL = process.env.GIT_COMMIT_AUTHOR_EMAIL ?? "harness@noreply";
git("config", "--global", "user.email", GIT_AUTHOR_EMAIL);
git("config", "--global", "user.name", GIT_AUTHOR_NAME);

// ── Clone & checkout ──────────────────────────────────────────────────────────
console.log("[sub-agent] Cloning repository, branch:", BRANCH_NAME);
git("clone", REPO_CLONE_URL, "/workspace/repo");   // credential store handles auth
process.chdir("/workspace/repo");
git("checkout", BRANCH_NAME);
```

- [ ] **Step 6: Remove `pushBranchTool` and update `createAgentSession` call**

Find and delete the entire `pushBranchTool` object definition (lines ~148–161 in the original):

```js
  // push_branch tool — uses the authenticated GIT_PUSH_URL from the JS closure.
  // The agent MUST use this tool to push; direct `git push` will fail (origin has no auth).
  const pushBranchTool = {
    name: "push_branch",
    ...
  };
```

Delete it entirely.

Then find the `createAgentSession` call and update `customTools`:

Change:
```js
    customTools: [askPlanningAgentTool, pushBranchTool],
```

To:
```js
    tools: createCodingTools("/workspace/repo", { bash: { spawnHook: createGuardHook() } }),
    customTools: [createWebFetchTool(), askPlanningAgentTool],
```

- [ ] **Step 7: Update the two post-session push calls**

Find:
```js
    execFileSync("git", ["push", GIT_PUSH_URL, `HEAD:${BRANCH_NAME}`], { stdio: "inherit" });
```

Both occurrences exist: one in the commit block (~line 233) and one in the session log block (~line 256). Replace both with:

```js
    execFileSync("git", ["push", "origin", `HEAD:${BRANCH_NAME}`], { stdio: "inherit" });
```

- [ ] **Step 8: Verify runner.mjs reads correctly**

Read `sub-agent/runner.mjs` in full and confirm:
- No remaining reference to `GIT_PUSH_URL` in push calls
- No `pushBranchTool`
- No `git remote set-url origin` call
- `createCodingTools` imported and used
- `createGuardHook` and `createWebFetchTool` imported from `./tools.mjs`
- `Type` from `@sinclair/typebox` removed (no longer needed)

- [ ] **Step 9: Commit**

```bash
git add sub-agent/runner.mjs sub-agent/Dockerfile
git commit -m "feat(sub-agent): credential pre-config, guard hook, web_fetch, remove push_branch"
```

---

## Task 4: Update `planning-agent/runner.mjs` and Dockerfile

**Files:**
- Modify: `planning-agent/runner.mjs`
- Modify: `planning-agent/Dockerfile`

### 4a — Dockerfile

- [ ] **Step 1: Add `gh` CLI install and `COPY tools.mjs` to `planning-agent/Dockerfile`**

Replace the existing `RUN apt-get` block:

```dockerfile
RUN apt-get update && apt-get install -y \
    git \
    curl \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       | tee /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*
```

Add `COPY --chown=node:node tools.mjs .` after the existing `COPY --chown=node:node runner.mjs .`:

```dockerfile
COPY --chown=node:node runner.mjs .
COPY --chown=node:node tools.mjs .
COPY --chown=node:node system-prompt.md .
```

### 4b — runner.mjs

- [ ] **Step 2: Update imports at the top of `planning-agent/runner.mjs`**

Add `createCodingTools` to the pi-coding-agent import, add `appendFileSync` and `homedir`, import from tools.mjs, and remove the top-level `GITHUB_TOKEN` variable capture.

Change the top of the file from:
```js
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  ModelRegistry,
  AuthStorage,
  runRpcMode,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";

const PROJECT_ID = process.env.PROJECT_ID ?? "unknown";
const BACKEND_URL = process.env.BACKEND_URL ?? "http://backend:3000";
const GIT_CLONE_URLS = process.env.GIT_CLONE_URLS ?? "[]";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
```

To:

```js
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
```

- [ ] **Step 3: Add `setupCredentials()` function and call it before the clone loop**

Insert after the env var declarations, before the `git()` helper:

```js
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
```

Call it immediately before the clone loop. Find:

```js
// ── Git setup ─────────────────────────────────────────────────────────────────
git("config", "--global", "user.email", process.env.GIT_COMMIT_AUTHOR_EMAIL ?? "harness@noreply");
git("config", "--global", "user.name", process.env.GIT_COMMIT_AUTHOR_NAME ?? "Harness Bot");

// ── Clone all project repos ───────────────────────────────────────────────────
const repos = JSON.parse(GIT_CLONE_URLS);
```

And prepend:

```js
// ── Credential setup — must happen before clone ───────────────────────────────
setupCredentials();

// ── Git setup ─────────────────────────────────────────────────────────────────
git("config", "--global", "user.email", process.env.GIT_COMMIT_AUTHOR_EMAIL ?? "harness@noreply");
git("config", "--global", "user.name", process.env.GIT_COMMIT_AUTHOR_NAME ?? "Harness Bot");

// ── Clone all project repos ───────────────────────────────────────────────────
const repos = JSON.parse(GIT_CLONE_URLS);
```

- [ ] **Step 4: Simplify the clone loop to use non-auth URL**

Find the clone loop body:

```js
for (const { name, url } of repos) {
  const dest = `/workspace/${name}`;
  if (!existsSync(join(dest, ".git"))) {
    let cloneUrl = url;
    if (GITHUB_TOKEN && cloneUrl.startsWith("https://github.com/")) {
      cloneUrl = `https://x-access-token:${GITHUB_TOKEN}@github.com/${cloneUrl.slice("https://github.com/".length)}`;
    }
    console.log(`[planning-agent] cloning ${name}...`);
    git("clone", cloneUrl, dest);
  } else {
```

Replace with:

```js
for (const { name, url } of repos) {
  const dest = `/workspace/${name}`;
  if (!existsSync(join(dest, ".git"))) {
    console.log(`[planning-agent] cloning ${name}...`);
    git("clone", url, dest);   // credential store handles auth
  } else {
```

- [ ] **Step 5: Remove the existing `delete process.env.GITHUB_TOKEN` line**

Find and delete:

```js
// Remove GITHUB_TOKEN from env before starting the AI session — the planning agent
// must use the write_planning_document tool (which calls the backend) instead of
// directly calling the GitHub API via bash/curl.
delete process.env.GITHUB_TOKEN;
```

(This deletion now happens inside `setupCredentials()`.)

- [ ] **Step 6: Update `write_planning_document` description and add tools to `createAgentSession`**

Find the `write_planning_document` tool description (in `writePlanningDocumentTool` or `createWritePlanningDocumentTool`). Change the description from:

```js
  'Write a planning document to the project\'s planning branch in the primary repository. ' +
  'Call with type "spec" first to write the design spec and open the PR. ' +
  'Call with type "plan" after spec is approved (LGTM received) to write the implementation plan. ' +
  'Returns the PR URL. You MUST call this instead of using bash/git/curl to create PRs.',
```

To:

```js
  'Write a planning document to the project\'s planning branch in the primary repository. ' +
  'Call with type "spec" first to write the design spec and open the PR. ' +
  'Call with type "plan" after spec is approved (LGTM received) to write the implementation plan. ' +
  'Returns the PR URL. Use this tool to create planning PRs. To create other PRs, use `gh pr create` directly.',
```

Then find the `createAgentSession` call and add `tools` and `createWebFetchTool()` to `customTools`:

```js
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
```

- [ ] **Step 7: Verify runner.mjs reads correctly**

Read `planning-agent/runner.mjs` in full and confirm:
- No remaining `const GITHUB_TOKEN = ...` at module scope
- No `if (GITHUB_TOKEN && ...)` in clone loop
- `setupCredentials()` called before git config and clone loop
- `delete process.env.GITHUB_TOKEN` only inside `setupCredentials()`
- `createCodingTools` and `createPlanningAgentGuardHook` imported and used
- `createWebFetchTool` in customTools
- `Type` from `@sinclair/typebox` removed from imports if no longer used elsewhere

- [ ] **Step 8: Commit**

```bash
git add planning-agent/runner.mjs planning-agent/Dockerfile
git commit -m "feat(planning-agent): credential pre-config, guard hook, web_fetch, simplify clone"
```

---

## Task 5: Final verification

- [ ] **Step 1: Run all unit tests**

```bash
node --test sub-agent/tools.test.mjs
node --test planning-agent/tools.test.mjs
```

Expected: all tests pass in both.

- [ ] **Step 2: Run backend unit tests**

```bash
bun run --cwd backend test
```

Expected: no regressions.

- [ ] **Step 3: Lint check — confirm no leftover references**

```bash
grep "GIT_PUSH_URL" sub-agent/runner.mjs
grep "push_branch" sub-agent/runner.mjs
grep "git remote set-url" sub-agent/runner.mjs
grep "x-access-token.*\${GITHUB_TOKEN}" planning-agent/runner.mjs
grep "const GITHUB_TOKEN" planning-agent/runner.mjs
```

Expected:
- `GIT_PUSH_URL` — only in `const GIT_PUSH_URL = process.env...` and the `git()` log-redaction helper (both are fine to keep). Must NOT appear in any `git push` call.
- `push_branch` — no matches
- `git remote set-url` — no matches
- `x-access-token.*${GITHUB_TOKEN}` — no matches (clone URL no longer uses the variable)
- `const GITHUB_TOKEN` — no matches (module-scope capture removed)

- [ ] **Step 4: Commit if any final adjustments were needed, then push**

```bash
git push origin feat/planning-agent-superpowers-integration
```
