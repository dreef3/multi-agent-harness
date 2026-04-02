FROM multi-agent-harness/agent-base:latest

RUN curl -fsSL https://opencode.ai/install.sh | sh 2>/dev/null || true

RUN mkdir -p /root/.config/opencode

COPY agents/opencode/opencode.json /root/.config/opencode/config.json

COPY agents/prompts/planning/AGENTS.md /agent-data/planning/AGENTS.md
RUN mkdir -p /agent-data/planning && ln -sf /agent-data/planning/AGENTS.md /agent-data/planning/CLAUDE.md

COPY agents/prompts/implementation/AGENTS.md /agent-data/implementation/AGENTS.md
RUN mkdir -p /agent-data/implementation && ln -sf /agent-data/implementation/AGENTS.md /agent-data/implementation/CLAUDE.md

ENTRYPOINT ["node", "/app/stdio-tcp-bridge.mjs", "opencode", "acp"]
