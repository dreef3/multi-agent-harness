FROM multi-agent-harness/agent-base:latest

RUN npm install -g @google/gemini-cli 2>/dev/null || true

COPY agents/gemini/.gemini /root/.gemini

COPY agents/prompts/planning/AGENTS.md /agent-data/planning/AGENTS.md
RUN mkdir -p /agent-data/planning && ln -sf /agent-data/planning/AGENTS.md /agent-data/planning/CLAUDE.md

COPY agents/prompts/implementation/AGENTS.md /agent-data/implementation/AGENTS.md
RUN mkdir -p /agent-data/implementation && ln -sf /agent-data/implementation/AGENTS.md /agent-data/implementation/CLAUDE.md

ENTRYPOINT ["/app/startup.sh", "node", "/app/stdio-tcp-bridge.mjs", "gemini", "--acp"]
