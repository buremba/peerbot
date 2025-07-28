# Dockerfile for Claude Code Worker
FROM node:20-alpine AS base

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

# Install Claude CLI
RUN curl -fsSL https://claude.ai/install.sh | sh && \
    mv /root/.local/bin/claude /usr/local/bin/claude && \
    chmod +x /usr/local/bin/claude

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json bun.lock ./
COPY packages/core-runner/package.json ./packages/core-runner/
COPY packages/worker/package.json ./packages/worker/

# Install dependencies
RUN npm install

# Copy source code
COPY packages/core-runner/ ./packages/core-runner/
COPY packages/worker/ ./packages/worker/
COPY tsconfig.json ./

# Build the packages
RUN npm run build:packages

# Production stage
FROM node:20-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache \
    git \
    curl \
    bash \
    jq \
    python3 \
    ca-certificates \
    openssh-client

# Install Claude CLI (production)
RUN curl -fsSL https://claude.ai/install.sh | sh && \
    mv /root/.local/bin/claude /usr/local/bin/claude && \
    chmod +x /usr/local/bin/claude

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
COPY --chown=claude:claude packages/worker/scripts/ ./scripts/
RUN chmod +x ./scripts/*.sh

# Switch to non-root user
USER claude

# Set working directory to workspace
WORKDIR /workspace

# Set default environment variables
ENV NODE_ENV=production
ENV WORKSPACE_DIR=/workspace

# Verify Claude CLI installation
RUN claude --version || (echo "Claude CLI not properly installed" && exit 1)

# Default command (will be overridden by entrypoint)
CMD ["/app/scripts/entrypoint.sh"]