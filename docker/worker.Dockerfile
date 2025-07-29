# Dockerfile for Claude Code Worker
FROM oven/bun:1-alpine AS base

# Install system dependencies including Claude CLI
RUN apk add --no-cache \
    git \
    curl \
    bash \
    jq \
    python3 \
    py3-pip \
    build-base \
    ca-certificates \
    openssh-client

# Claude CLI installation will be handled by worker at runtime
# The worker will install/update Claude CLI as needed

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
COPY packages/worker/ ./packages/worker/
COPY tsconfig.json ./

# Build the packages using Bun's transpiler
RUN bun build packages/core-runner/src/index.ts --outdir packages/core-runner/dist --target bun --splitting && \
    bun build packages/worker/src/index.ts --outdir packages/worker/dist --target bun --splitting

# Production stage
FROM oven/bun:1-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache \
    git \
    curl \
    bash \
    jq \
    python3 \
    ca-certificates \
    openssh-client

# Claude CLI installation will be handled by worker at runtime
# The worker will install/update Claude CLI as needed

# Create non-root user
RUN addgroup -g 1001 -S claude && \
    adduser -S claude -u 1001 -G claude

# Create app and workspace directories
WORKDIR /app
RUN mkdir -p /workspace && \
    chown -R claude:claude /app /workspace

# Copy built application
COPY --from=base --chown=claude:claude /app/packages/core-runner/dist ./packages/core-runner/dist
COPY --from=base --chown=claude:claude /app/packages/worker/dist ./packages/worker/dist
COPY --from=base --chown=claude:claude /app/node_modules ./node_modules
COPY --from=base --chown=claude:claude /app/package.json ./

# Copy scripts and make executable
COPY --chown=claude:claude packages/worker/scripts/ ./packages/worker/scripts/
RUN chmod +x ./packages/worker/scripts/*.sh || true

# Switch to non-root user
USER claude

# Set working directory to workspace
WORKDIR /workspace

# Set default environment variables
ENV NODE_ENV=production
ENV WORKSPACE_DIR=/workspace

# Claude CLI will be verified at runtime

# Default command
CMD ["bun", "run", "/app/packages/worker/dist/index.js"]