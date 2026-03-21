FROM oven/bun:1

RUN apt-get update && apt-get install -y \
    git \
    default-jdk \
    maven \
    build-essential \
    python3 \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install pi-coding-agent as a local dependency so runner.mjs can import it
COPY package.json .
RUN bun install

RUN mkdir -p /workspace /pi-agent && chown bun:bun /workspace /pi-agent

ENV PI_CODING_AGENT_DIR=/pi-agent

COPY --chown=bun:bun runner.mjs .

USER bun

ENTRYPOINT ["bun", "/app/runner.mjs"]
