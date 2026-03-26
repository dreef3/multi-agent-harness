/**
 * Shared agent tools for the planning agent.
 * Re-exports web_fetch and provides createPlanningAgentGuardHook.
 *
 * NOTE: web_fetch implementation is duplicated from sub-agent/tools.mjs
 * because these are separate Docker images with no shared file system.
 */
import { spawnSync } from "node:child_process";
import { Type } from "@sinclair/typebox";

// Check once at module load whether RTK is runnable on this architecture
const isRtkAvailable = (() => {
  try {
    const result = spawnSync("/usr/local/bin/rtk", ["--version"], { timeout: 3000 });
    return result.status === 0;
  } catch {
    return false;
  }
})();

if (!isRtkAvailable) {
  console.warn("[tools] RTK not available — bash output will not be filtered");
}

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
    // No block matched — prepend rtk if available
    if (isRtkAvailable) {
      return { ...context, command: "rtk " + context.command };
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
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "0.0.0.0") return true;
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
        Type.Union([Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT")],
          { default: "GET" }
        )
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
