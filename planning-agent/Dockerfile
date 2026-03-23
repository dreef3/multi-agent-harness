FROM node:22-slim

RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install

RUN mkdir -p /workspace /pi-agent && chown node:node /workspace /pi-agent

ENV PI_CODING_AGENT_DIR=/pi-agent

COPY --chown=node:node runner.mjs .
COPY --chown=node:node system-prompt.md .

USER node

ENTRYPOINT ["node", "/app/runner.mjs"]
