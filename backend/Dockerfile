FROM oven/bun:1 AS bun-binary

FROM node:24-slim AS builder
# Copy bun binary for lockfile-aware installs while keeping node for native module compilation
COPY --from=bun-binary /usr/local/bin/bun /usr/local/bin/bun
ARG CUSTOM_CA_BUNDLE=""
RUN if [ -n "$CUSTOM_CA_BUNDLE" ]; then \
      printf "%s\n" "$CUSTOM_CA_BUNDLE" >> /etc/ssl/certs/ca-certificates.crt && \
      update-ca-certificates 2>/dev/null || true; \
    fi
WORKDIR /app

# Install build dependencies for native modules (including node-gyp for better-sqlite3)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g node-gyp

COPY package.json bun.lock ./
# Skip lifecycle scripts to avoid bun cache issues with native modules in Docker;
# rebuild better-sqlite3 explicitly using node-gyp after packages are extracted.
RUN bun install --ignore-scripts
COPY scripts ./scripts
RUN bash scripts/rebuild-sqlite3.sh
COPY . .
RUN bun run build

FROM node:24-slim
ARG CUSTOM_CA_BUNDLE=""
RUN if [ -n "$CUSTOM_CA_BUNDLE" ]; then \
      printf "%s\n" "$CUSTOM_CA_BUNDLE" >> /etc/ssl/certs/ca-certificates.crt && \
      update-ca-certificates 2>/dev/null || true; \
    fi
WORKDIR /app
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
RUN mkdir -p /app/data /pi-agent && chown -R node:node /app /pi-agent
ENV PI_CODING_AGENT_DIR=/pi-agent
USER node
CMD ["node", "dist/index.js"]
