# Build stage
FROM oven/bun:1 AS builder
ARG CUSTOM_CA_BUNDLE=""
RUN if [ -n "$CUSTOM_CA_BUNDLE" ]; then \
      printf "%s\n" "$CUSTOM_CA_BUNDLE" >> /etc/ssl/certs/ca-certificates.crt && \
      update-ca-certificates 2>/dev/null || true; \
    fi

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install

# Copy source code
COPY . .

# Build the application
RUN bun run build

# Production stage
FROM nginx:alpine

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
