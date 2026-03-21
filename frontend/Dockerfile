# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy workspace config and lockfile from root context
COPY bun.lock package.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY e2e-tests/package.json ./e2e-tests/

# Install dependencies
WORKDIR /app
RUN bun install --frozen-lockfile

# Copy frontend source and build
COPY frontend/ ./frontend/
WORKDIR /app/frontend
RUN bun run build

# Production stage
FROM nginx:alpine

# Copy built assets from builder stage
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

# Copy nginx configuration
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Expose port
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
