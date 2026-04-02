FROM node:22-slim
ARG CUSTOM_CA_BUNDLE=""
RUN if [ -n "$CUSTOM_CA_BUNDLE" ]; then \
      printf "%s\n" "$CUSTOM_CA_BUNDLE" >> /etc/ssl/certs/ca-certificates.crt && \
      update-ca-certificates 2>/dev/null || true; \
    fi

RUN apt-get update && apt-get install -y \
    git \
    curl \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       | tee /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY planning-agent/package.json .
RUN npm install

# NOTE (2026-03-28): Extension pre-initialization was investigated.
# DefaultResourceLoader.reload() could not be measured in this environment
# (Docker images not pre-built). Investigation should be re-run with the
# built image to determine if a pre-init RUN step would reduce startup time.
# SDK version is pinned to 0.61.1 (see package.json) for reproducible builds.

RUN mkdir -p /workspace /pi-agent && chown node:node /workspace /pi-agent

ENV PI_CODING_AGENT_DIR=/pi-agent

COPY --chown=node:node planning-agent/runner.mjs .
COPY --chown=node:node planning-agent/tools.mjs .
COPY --chown=node:node planning-agent/system-prompt.md .

COPY shared/bin/rtk /usr/local/bin/rtk
RUN chmod +x /usr/local/bin/rtk && \
    /usr/local/bin/rtk --version || echo "[warn] rtk not runnable on this arch"
RUN mkdir -p /home/node/.config/rtk
COPY shared/config/rtk-config.toml /home/node/.config/rtk/config.toml
COPY shared/extensions/ /app/shared/extensions/

USER node

ENTRYPOINT ["node", "/app/runner.mjs"]
