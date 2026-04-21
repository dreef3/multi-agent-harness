FROM node:24-bookworm

SHELL ["/bin/bash", "-c"]

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates jq python3 python3-yaml unzip \
    && rm -rf /var/lib/apt/lists/*

# Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
      https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Claude Code + OpenCode CLIs
RUN npm install -g @anthropic-ai/claude-code opencode-ai

# node:24-bookworm ships a 'node' user at UID 1000; rename it to 'dev'
RUN usermod -l dev -d /home/dev -m node \
    && groupmod -n dev node \
    && mkdir -p /workspace \
    && chown dev:dev /workspace
ENV PATH="/home/dev/.bun/bin:$PATH"

USER dev
WORKDIR /workspace
