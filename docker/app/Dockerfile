# ===========================================
# Owletto API + Frontend
# ===========================================
# Node.js MCP server with PostgreSQL, embeddings, and embedded Lobu agent runtime.

FROM node:22-slim AS builder

WORKDIR /app

# Install pnpm and git (baileys pulls libsignal-node from a git URL)
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@9

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy workspace package.json files for install
COPY packages/worker/package.json packages/worker/
COPY packages/sdk/package.json packages/sdk/
# packages/web is a private git submodule. The glob lets the copy succeed when
# the submodule is not initialized (external contributors / backend-only builds).
COPY packages/web/package.jso[n] packages/web/
COPY packages/embeddings-service/package.json packages/embeddings-service/

# Install dependencies
RUN pnpm install --no-frozen-lockfile --ignore-scripts

# Restore the Linux-native sharp binary for embedded workers without
# enabling arbitrary install scripts across the whole workspace.
RUN SHARP_DIR="$(find /app/node_modules/.pnpm -path '*/node_modules/sharp/package.json' | head -n1 | xargs dirname)" \
    && PREBUILD_INSTALL_BIN="$(find /app/node_modules/.pnpm -path '*/node_modules/prebuild-install/bin.js' | head -n1)" \
    && if [ -n "$SHARP_DIR" ] && [ -n "$PREBUILD_INSTALL_BIN" ]; then \
        cd "$SHARP_DIR" \
        && node install/libvips \
        && node install/dll-copy \
        && node "$PREBUILD_INSTALL_BIN"; \
      fi

# Patch ESM-only packages for CJS compatibility
COPY docker/app/patch-esm-exports.cjs /app/patch-esm-exports.cjs
RUN node patch-esm-exports.cjs

# Force rebuild of source layers
ARG CACHEBUST=default
ARG APP_GIT_SHA=unknown
ARG APP_BUILD_TIME=unknown
RUN echo "Build: ${CACHEBUST}" && date > /tmp/.build-time

# Copy source code (app imports from worker, worker imports from sdk)
COPY tsconfig.json ./
COPY config/ config/
COPY connectors/ connectors/
COPY src/ src/
COPY packages/worker/src/ packages/worker/src/
COPY packages/worker/tsconfig.json packages/worker/
COPY packages/sdk/src/ packages/sdk/src/
COPY packages/sdk/tsconfig.json packages/sdk/
COPY packages/embeddings-service/src/ packages/embeddings-service/src/
COPY packages/embeddings-service/tsconfig.json packages/embeddings-service/
# Copy the private frontend submodule when present. Empty directory is fine;
# the web build step below short-circuits when packages/web/package.json is absent.
COPY packages/web packages/web

# Build SDK (other packages import from dist/)
RUN cd packages/sdk && pnpm exec tsc

# Type check
ARG SKIP_TSC=false
RUN if [ "$SKIP_TSC" = "false" ]; then pnpm exec tsc --noEmit; fi

# Build frontend static assets (production only — dev uses Vite middleware mode)
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
# Build frontend — vite only (tsc validated in CI)
# Skip when SKIP_WEB_BUILD=true or when the private submodule is absent (external builds).
ARG SKIP_WEB_BUILD=false
RUN if [ "$SKIP_WEB_BUILD" = "false" ] && [ -f packages/web/package.json ]; then \
      cd packages/web && pnpm exec vite build; \
    else \
      mkdir -p /app/packages/web/dist; \
    fi

# ===========================================
# Runtime
# ===========================================
FROM node:22-slim AS runtime

WORKDIR /app

# Install curl for health checks, dbmate for migrations, and Playwright deps for browser-based connectors
RUN apt-get update && apt-get install -y curl \
    # Playwright/Chromium runtime dependencies
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 \
    libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libwayland-client0 \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://github.com/amacneil/dbmate/releases/download/v2.22.0/dbmate-linux-amd64 -o /usr/local/bin/dbmate \
    && chmod +x /usr/local/bin/dbmate

# Install pnpm for running tsx
RUN npm install -g pnpm@9

# Copy source files and dependencies from builder
COPY --from=builder /app/config ./config
COPY --from=builder /app/connectors ./connectors
COPY --from=builder /app/src ./src
COPY --from=builder /app/packages/worker ./packages/worker
COPY --from=builder /app/packages/sdk ./packages/sdk
COPY --from=builder /app/packages/embeddings-service ./packages/embeddings-service
COPY --from=builder /app/packages/web ./packages/web
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.json ./

# Copy database migrations
COPY db/migrations ./db/migrations

# Install Playwright/patchright Chromium for browser-based connectors
RUN npx patchright install chromium 2>/dev/null || npx playwright install chromium 2>/dev/null || true

# Build metadata + environment defaults
ARG APP_GIT_SHA=unknown
ARG APP_BUILD_TIME=unknown
ENV NODE_ENV=production
ENV APP_GIT_SHA=${APP_GIT_SHA}
ENV APP_BUILD_TIME=${APP_BUILD_TIME}

# Expose port
EXPOSE 8787

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8787/health || exit 1

# ESM compat patch script (runs at startup for lazy-installed deps)
COPY docker/app/patch-esm-exports.cjs /app/patch-esm-exports.cjs

# Bun shim for embedded Lobu workers in the Node runtime image
COPY scripts/runtime-shims/bun /usr/local/bin/bun
RUN chmod +x /usr/local/bin/bun

# Startup script
COPY docker/app/start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Start via script that runs migrations then node
CMD ["/app/start.sh"]
