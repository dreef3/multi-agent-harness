FROM multi-agent-harness/agent-base:latest

WORKDIR /app

COPY agents/copilot/package.json /app/package.json
RUN npm install --production && npm install -g @mariozechner/pi-coding-agent

COPY agents/copilot/mcp.json /app/mcp.json
COPY agents/copilot/start.sh /app/start.sh
RUN chmod +x /app/start.sh

COPY agents/prompts/planning/AGENTS.md /agent-data/planning/AGENTS.md
RUN mkdir -p /agent-data/planning && ln -sf /agent-data/planning/AGENTS.md /agent-data/planning/CLAUDE.md

COPY agents/prompts/implementation/AGENTS.md /agent-data/implementation/AGENTS.md
RUN mkdir -p /agent-data/implementation && ln -sf /agent-data/implementation/AGENTS.md /agent-data/implementation/CLAUDE.md

ENTRYPOINT ["/app/start.sh"]
