FROM oven/bun:1 AS bun-binary

FROM node:20.18-slim AS builder
# Copy bun binary for lockfile-aware installs while keeping node for native module compilation
COPY --from=bun-binary /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy workspace config and lockfile from root context
COPY bun.lock package.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY e2e-tests/package.json ./e2e-tests/

# Install dependencies
WORKDIR /app
RUN bun install --frozen-lockfile

# Copy backend source and build
COPY backend/ ./backend/
WORKDIR /app/backend
RUN bun run build

FROM node:20.18-slim
WORKDIR /app
COPY --from=builder /app/backend/package.json ./package.json
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
RUN mkdir -p /app/data /pi-agent && chown -R node:node /app /pi-agent
ENV PI_CODING_AGENT_DIR=/pi-agent
USER node
CMD ["node", "dist/index.js"]
