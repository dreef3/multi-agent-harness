/**
 * Guard hooks for harness agents.
 * Imported by isolation tests via `docker exec … node -e "import('/app/tools.mjs').then(…)"`.
 *
 * createGuardHook()              — implementation (sub) agent: blocks destructive ops,
 *                                  tells the agent the harness handles PRs.
 * createPlanningAgentGuardHook() — planning agent: same blocks but redirects gh pr create
 *                                  to write_planning_document instead.
 */
import { spawnSync } from "node:child_process";

const isRtkAvailable = (() => {
  try {
    const r = spawnSync("/usr/local/bin/rtk", ["--version"], { timeout: 3000 });
    return r.status === 0;
  } catch {
    return false;
  }
})();

const BASE_BLOCKED = [
  [["git", "push", "--force"],            "Force push is blocked. Use regular git push."],
  [["git", "push", "-f"],                 "Force push is blocked. Use regular git push."],
  [["git", "push", "--force-with-lease"], "Force push is blocked. Use regular git push."],
  [["git", "push", "--delete"],           "Deleting remote refs via push is blocked."],
  [["git", "push", "-d"],                 "Deleting remote refs via push is blocked."],
  [["git", "branch", "-D"],               "Branch deletion is blocked."],
  [["git", "branch", "--delete"],         "Branch deletion is blocked."],
  [["git", "branch", "-d"],               "Branch deletion is blocked."],
  [["gh", "pr", "create"],                "The harness creates the pull request automatically. Do not create PRs manually."],
  [["gh", "repo", "delete"],              "Repository deletion is blocked."],
  [["gh", "repo", "edit"],                "Repository settings changes are blocked."],
  [["gh", "api"],                         "Direct gh API calls are blocked."],
  [["curl"],                              "Use the web_fetch tool instead of curl."],
  [["wget"],                              "Use the web_fetch tool instead of wget."],
];

const PLANNING_EXTRA = [
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
    if (isRtkAvailable) {
      return { ...context, command: "rtk " + context.command };
    }
    return context;
  };
}

/** Guard hook for the implementation (sub) agent. */
export function createGuardHook(extraBlocked = []) {
  return makeGuardHook([...BASE_BLOCKED, ...extraBlocked]);
}

/** Guard hook for the planning agent — redirects gh pr create to write_planning_document. */
export function createPlanningAgentGuardHook() {
  const planningPatterns = [
    ...BASE_BLOCKED.filter(([p]) => !(p[0] === "gh" && p[1] === "pr" && p[2] === "create")),
    ...PLANNING_EXTRA,
  ];
  return makeGuardHook(planningPatterns);
}
