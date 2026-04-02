FROM multi-agent-harness/agent-base:latest

COPY agents/copilot/mcp.json /app/mcp.json

COPY agents/prompts/planning/AGENTS.md /agent-data/planning/AGENTS.md
RUN mkdir -p /agent-data/planning && ln -sf /agent-data/planning/AGENTS.md /agent-data/planning/CLAUDE.md

COPY agents/prompts/implementation/AGENTS.md /agent-data/implementation/AGENTS.md
RUN mkdir -p /agent-data/implementation && ln -sf /agent-data/implementation/AGENTS.md /agent-data/implementation/CLAUDE.md

# Copilot CLI supports native ACP over TCP — no bridge needed
ENTRYPOINT ["copilot", "--acp", "--port", "3333"]
