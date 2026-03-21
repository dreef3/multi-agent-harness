# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy only frontend package.json and lockfile
COPY frontend/package.json ./package.json
# Create a minimal bun.lock for the frontend only
RUN bun install

# Copy frontend source and build
COPY frontend/ ./
RUN bun run build

# Production stage
FROM nginx:alpine

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx configuration
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Expose port
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
