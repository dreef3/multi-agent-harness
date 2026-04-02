FROM multi-agent-harness/agent-base:latest

RUN npm install -g @anthropic-ai/claude-code claude-agent-acp 2>/dev/null || true

COPY agents/claude/settings.json /root/.claude/settings.json

RUN printf '#!/bin/sh\n\
BLOCKED="git push --force|git push -f|git branch -D|git branch -d|gh pr create|gh repo delete|gh api"\n\
for pattern in $BLOCKED; do\n\
  case "$CLAUDE_TOOL_INPUT" in *"$pattern"*) echo "[GUARD] Blocked: $pattern" >&2; exit 2;; esac\n\
done\n\
exit 0\n' > /app/guard-hook.sh && chmod +x /app/guard-hook.sh

COPY agents/prompts/planning/AGENTS.md /agent-data/planning/AGENTS.md
RUN mkdir -p /agent-data/planning && ln -sf /agent-data/planning/AGENTS.md /agent-data/planning/CLAUDE.md

COPY agents/prompts/implementation/AGENTS.md /agent-data/implementation/AGENTS.md
RUN mkdir -p /agent-data/implementation && ln -sf /agent-data/implementation/AGENTS.md /agent-data/implementation/CLAUDE.md

ENTRYPOINT ["node", "/app/stdio-tcp-bridge.mjs", "claude-agent-acp"]
