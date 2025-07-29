# Dockerfile for Claude Code Slack Dispatcher
FROM oven/bun:1-alpine AS base

# Install system dependencies
RUN apk add --no-cache \
    git \
    curl \
    bash \
    jq

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json bun.lock ./
COPY packages/core-runner/package.json ./packages/core-runner/
COPY packages/dispatcher/package.json ./packages/dispatcher/
COPY packages/worker/package.json ./packages/worker/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY packages/core-runner/ ./packages/core-runner/
COPY packages/dispatcher/ ./packages/dispatcher/
COPY tsconfig.json ./

# Build the packages using Bun's transpiler
RUN bun build packages/core-runner/src/index.ts --outdir packages/core-runner/dist --target bun --splitting && \
    bun build packages/dispatcher/src/index.ts --outdir packages/dispatcher/dist --target bun --splitting

# Production stage
FROM oven/bun:1-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache \
    git \
    curl \
    bash \
    ca-certificates

# Create non-root user
RUN addgroup -g 1001 -S claude && \
    adduser -S claude -u 1001 -G claude

# Create app directory and set permissions
WORKDIR /app
RUN chown claude:claude /app

# Copy built application
COPY --from=base --chown=claude:claude /app/packages/core-runner/dist ./packages/core-runner/dist
COPY --from=base --chown=claude:claude /app/packages/dispatcher/dist ./packages/dispatcher/dist
COPY --from=base --chown=claude:claude /app/node_modules ./node_modules
COPY --from=base --chown=claude:claude /app/package.json ./

# Switch to non-root user
USER claude

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

# Expose port
EXPOSE 3000

# Set default environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV LOG_LEVEL=INFO

# Start the dispatcher
CMD ["bun", "run", "packages/dispatcher/dist/index.js"]