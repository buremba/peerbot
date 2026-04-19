# ===========================================
# Stage 1: Builder
# ===========================================
FROM node:22-bookworm AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9

# Copy root package files and workspace config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy worker package.json for workspace install
COPY packages/worker/package.json packages/worker/

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Copy source code (connectors from root + worker + embeddings-service utils)
COPY tsconfig.json ./
COPY connectors/ connectors/
COPY src/ src/
COPY packages/worker/src/ packages/worker/src/
COPY packages/worker/tsconfig.json packages/worker/
COPY packages/embeddings-service/src/ packages/embeddings-service/src/

# ===========================================
# Stage 2: Runtime
# ===========================================
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# Install system deps for Chromium + exiftool
RUN apt-get update && apt-get install -y --no-install-recommends \
    libimage-exiftool-perl \
    # Chromium runtime deps
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libxshmfence1 libxfixes3 libglib2.0-0 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@9 tsx@4

# Create non-root user for security
RUN useradd -m -s /bin/bash worker && \
    mkdir -p /app/.cache/transformers /ms-playwright && \
    chown -R worker:worker /app /ms-playwright

# Copy installed dependencies and source from builder
COPY --from=builder --chown=worker:worker /app/node_modules ./node_modules
COPY --from=builder --chown=worker:worker /app/connectors ./connectors
COPY --from=builder --chown=worker:worker /app/src ./src
COPY --from=builder --chown=worker:worker /app/packages/worker/src ./packages/worker/src
COPY --from=builder --chown=worker:worker /app/packages/worker/tsconfig.json ./packages/worker/
COPY --from=builder --chown=worker:worker /app/packages/worker/package.json ./packages/worker/
COPY --from=builder --chown=worker:worker /app/packages/worker/node_modules ./packages/worker/node_modules
COPY --from=builder --chown=worker:worker /app/packages/embeddings-service/src ./packages/embeddings-service/src
COPY --from=builder --chown=worker:worker /app/tsconfig.json ./
COPY --from=builder --chown=worker:worker /app/package.json ./

# Copy health check script
COPY --chown=worker:worker docker/worker/healthcheck.sh /healthcheck.sh
RUN chmod +x /healthcheck.sh

# Install patchright's Chromium (aliased as playwright in package.json)
USER worker
RUN node -e " \
  const p = require('path'); \
  const dir = p.dirname(require.resolve('playwright/package.json')); \
  require('child_process').execSync( \
    'node ' + p.join(dir, 'cli.js') + ' install chromium', \
    { stdio: 'inherit' } \
  );"

# Environment defaults
ENV NODE_ENV=production
ENV TRANSFORMERS_CACHE=/app/.cache/transformers

WORKDIR /app/packages/worker

# Start the worker daemon
CMD ["tsx", "src/bin.ts", "daemon"]
