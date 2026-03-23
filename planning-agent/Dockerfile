FROM node:22-slim

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

COPY package.json .
RUN npm install

RUN mkdir -p /workspace /pi-agent && chown node:node /workspace /pi-agent

ENV PI_CODING_AGENT_DIR=/pi-agent

COPY --chown=node:node runner.mjs .
COPY --chown=node:node tools.mjs .
COPY --chown=node:node system-prompt.md .

USER node

ENTRYPOINT ["node", "/app/runner.mjs"]
