FROM oven/bun:1

RUN apt-get update && apt-get install -y \
    git \
    default-jdk \
    maven \
    build-essential \
    python3 \
    curl \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       | tee /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install pi-coding-agent as a local dependency so runner.mjs can import it
COPY sub-agent/package.json .
RUN bun install

RUN mkdir -p /workspace /pi-agent && chown bun:bun /workspace /pi-agent

ENV PI_CODING_AGENT_DIR=/pi-agent

COPY --chown=bun:bun sub-agent/runner.mjs .
COPY --chown=bun:bun sub-agent/tools.mjs .

# shared/ is at repo root; build context must be repo root (see docker-compose / build docs)
COPY shared/bin/rtk /usr/local/bin/rtk
RUN chmod +x /usr/local/bin/rtk && \
    /usr/local/bin/rtk --version || echo "[warn] rtk not runnable on this arch; bash output unfiltered"
COPY shared/extensions/ /app/shared/extensions/
RUN mkdir -p /home/bun/.config/rtk
COPY shared/config/rtk-config.toml /home/bun/.config/rtk/config.toml

USER bun

ENTRYPOINT ["bun", "/app/runner.mjs"]
