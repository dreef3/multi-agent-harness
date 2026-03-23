FROM oven/bun:1

RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN bun install

RUN mkdir -p /workspace /pi-agent && chown bun:bun /workspace /pi-agent

ENV PI_CODING_AGENT_DIR=/pi-agent

COPY --chown=bun:bun runner.mjs .
COPY --chown=bun:bun system-prompt.md .

USER bun

ENTRYPOINT ["bun", "/app/runner.mjs"]
