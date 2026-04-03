#!/bin/sh
BLOCKED="git push --force|git push -f|git branch -D|git branch -d|gh pr create|gh repo delete|gh api"
for pattern in $BLOCKED; do
  case "$CLAUDE_TOOL_INPUT" in *"$pattern"*) echo "[GUARD] Blocked: $pattern" >&2; exit 2;; esac
done
exit 0
