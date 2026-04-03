#!/bin/sh
# Block native web access tools (use MCP web_fetch instead)
case "$CLAUDE_TOOL_NAME" in WebSearch|WebFetch) echo "[GUARD] Blocked tool: $CLAUDE_TOOL_NAME" >&2; exit 2;; esac

BLOCKED="git push --force|git push -f|git branch -D|git branch -d|gh pr create|gh repo delete|gh api"
for pattern in $BLOCKED; do
  case "$CLAUDE_TOOL_INPUT" in *"$pattern"*) echo "[GUARD] Blocked: $pattern" >&2; exit 2;; esac
done
exit 0
