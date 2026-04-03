FROM multi-agent-harness/agent-base:latest

RUN npm install -g @anthropic-ai/claude-code claude-agent-acp 2>/dev/null || true

COPY agents/claude/settings.json /root/.claude/settings.json

COPY agents/claude/guard-hook.sh /app/guard-hook.sh
RUN chmod +x /app/guard-hook.sh

COPY agents/prompts/planning/AGENTS.md /agent-data/planning/AGENTS.md
RUN mkdir -p /agent-data/planning && ln -sf /agent-data/planning/AGENTS.md /agent-data/planning/CLAUDE.md

COPY agents/prompts/implementation/AGENTS.md /agent-data/implementation/AGENTS.md
RUN mkdir -p /agent-data/implementation && ln -sf /agent-data/implementation/AGENTS.md /agent-data/implementation/CLAUDE.md

ENTRYPOINT ["node", "/app/stdio-tcp-bridge.mjs", "claude-agent-acp"]
