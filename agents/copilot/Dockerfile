ARG BASE_IMAGE=multi-agent-harness/agent-base:latest
FROM ${BASE_IMAGE}

WORKDIR /app

COPY agents/copilot/package.json /app/package.json
RUN npm install --production && \
    # GitHub Copilot rejects PATs for the "vscode-chat" integration ID.
    # "copilot-developer-cli" accepts both PATs and short-lived session tokens.
    find /app/node_modules -name "models.generated.js" -exec \
      sed -i 's/"Copilot-Integration-Id": "vscode-chat"/"Copilot-Integration-Id": "copilot-developer-cli"/g' {} +
ENV PI_ACP_PI_COMMAND=/app/node_modules/.bin/pi

COPY agents/copilot/mcp.json /app/mcp.json
COPY agents/copilot/start.sh /app/start.sh
RUN chmod +x /app/start.sh

COPY agents/prompts/planning/AGENTS.md /agent-data/planning/AGENTS.md
RUN mkdir -p /agent-data/planning && ln -sf /agent-data/planning/AGENTS.md /agent-data/planning/CLAUDE.md

COPY agents/prompts/implementation/AGENTS.md /agent-data/implementation/AGENTS.md
RUN mkdir -p /agent-data/implementation && ln -sf /agent-data/implementation/AGENTS.md /agent-data/implementation/CLAUDE.md

ENTRYPOINT ["/app/start.sh"]
