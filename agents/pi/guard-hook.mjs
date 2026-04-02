// Pi agent guard hook (BashSpawnHook compatible)
const BLOCKED_PATTERNS = [
  ["git", "push", "--force"],
  ["git", "push", "-f"],
  ["git", "branch", "-D"],
  ["git", "branch", "-d"],
  ["git", "branch", "--delete"],
  ["gh", "pr", "create"],
  ["gh", "repo", "delete"],
  ["gh", "repo", "edit"],
  ["gh", "api"],
  ["curl"],
  ["wget"],
];

export function createGuardHook() {
  return function guardHook(context) {
    const tokens = context.command.split(/\s+/);
    if (tokens.some(t => /(?:^|\/)\.harness(?:\/|$)/.test(t))) {
      return { ...context, command: `printf '[GUARD] .harness/ access blocked\\n' >&2; exit 1` };
    }
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.every((p, i) => tokens[i] === p)) {
        return { ...context, command: `printf '[GUARD] Command blocked: ${pattern.join(" ")}\\n' >&2; exit 1` };
      }
    }
    return context;
  };
}
