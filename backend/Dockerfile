FROM oven/bun:1 AS bun-binary

FROM node:24-slim AS builder
# Copy bun binary for lockfile-aware installs while keeping node for native module compilation
COPY --from=bun-binary /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install
COPY . .
RUN bun run build

FROM node:24-slim
WORKDIR /app
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
RUN mkdir -p /app/data /pi-agent && chown -R node:node /app /pi-agent
ENV PI_CODING_AGENT_DIR=/pi-agent
USER node
CMD ["node", "dist/index.js"]
