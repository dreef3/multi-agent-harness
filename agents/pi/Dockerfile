FROM multi-agent-harness/agent-base:latest AS base

WORKDIR /app

COPY agents/pi/package.json /app/package.json
RUN npm install --production
# pi-coding-agent is a local dep so /app/node_modules/.bin/pi is on PATH when npx runs
ENV PI_ACP_PI_COMMAND=/app/node_modules/.bin/pi

COPY agents/pi/guard-hook.mjs /app/guard-hook.mjs
COPY agents/pi/tools.mjs /app/tools.mjs
COPY agents/pi/start.sh /app/start.sh
RUN chmod +x /app/start.sh

COPY agents/prompts/planning/AGENTS.md /agent-data/planning/AGENTS.md
RUN mkdir -p /agent-data/planning && ln -sf /agent-data/planning/AGENTS.md /agent-data/planning/CLAUDE.md

COPY agents/prompts/implementation/AGENTS.md /agent-data/implementation/AGENTS.md
RUN mkdir -p /agent-data/implementation && ln -sf /agent-data/implementation/AGENTS.md /agent-data/implementation/CLAUDE.md

ENTRYPOINT ["/app/start.sh"]
