# ===========================================
# Owletto API + Frontend (server)
# ===========================================
# Hono server that runs the gateway in-process and serves the web frontend.

FROM node:22-slim AS builder

WORKDIR /app

# Bun for workspace install + tsc. git needed because some deps ship git URLs.
# python3 + build-essential needed for isolated-vm native build (node-gyp).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl unzip \
      python3 build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
    && chmod +x /usr/local/bin/bun

ENV PATH="/usr/local/bin:${PATH}"

# Root workspace files
COPY bun.lock package.json tsconfig.json ./
COPY patches/ ./patches/

# Workspace package manifests needed to resolve the backend + its deps.
COPY packages/core/package.json packages/core/
COPY packages/agent-worker/package.json packages/agent-worker/
COPY packages/server/package.json packages/server/
COPY packages/connector-sdk/package.json packages/connector-sdk/
COPY packages/openclaw-plugin/package.json packages/openclaw-plugin/
COPY packages/connectors/package.json packages/connectors/
COPY packages/embeddings/package.json packages/embeddings/
COPY packages/connector-worker/package.json packages/connector-worker/
COPY packages/owletto-sdk/package.json packages/owletto-sdk/
COPY packages/owletto-connectors/package.json packages/owletto-connectors/
COPY packages/owletto-embeddings/package.json packages/owletto-embeddings/
COPY packages/owletto-worker/package.json packages/owletto-worker/
COPY packages/owletto-openclaw/package.json packages/owletto-openclaw/
# packages/web is a private git submodule. The glob lets the copy succeed
# when the submodule is not initialized (external contributors / backend-only builds).
COPY packages/web/package.jso[n] packages/web/

# Stub out workspace packages we don't build in this image so bun install doesn't
# error on missing manifests.
RUN mkdir -p packages/cli packages/landing packages/owletto-cli packages/browser-extension packages/mcpsandbox \
    && for p in cli landing browser-extension mcpsandbox; do \
        echo "{\"name\":\"@lobu/$p\",\"version\":\"0.0.0\",\"private\":true}" > "packages/$p/package.json"; \
      done \
    && echo '{"name":"owletto","version":"0.0.0","private":true}' > packages/owletto-cli/package.json

# Hoisted layout (npm-style flat node_modules) is required so the bundled
# server.bundle.mjs (built below) can resolve transitive npm deps via Node's
# resolver. Bun's default isolated linker uses .bun/<pkg>@<ver>/ paths that
# Node doesn't understand.
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --linker=hoisted

# Force rebuild of source layers
ARG CACHEBUST=default
ARG APP_GIT_SHA=unknown
ARG APP_BUILD_TIME=unknown
RUN echo "Build: ${CACHEBUST}" && date > /tmp/.build-time

# Source code
COPY config/ config/
COPY packages/core/ packages/core/
COPY packages/agent-worker/ packages/agent-worker/
COPY packages/connector-sdk/ packages/connector-sdk/
COPY packages/openclaw-plugin/ packages/openclaw-plugin/
COPY packages/connectors/ packages/connectors/
COPY packages/embeddings/ packages/embeddings/
COPY packages/connector-worker/ packages/connector-worker/
COPY packages/owletto-sdk/ packages/owletto-sdk/
COPY packages/owletto-connectors/ packages/owletto-connectors/
COPY packages/owletto-embeddings/ packages/owletto-embeddings/
COPY packages/owletto-worker/ packages/owletto-worker/
COPY packages/owletto-openclaw/ packages/owletto-openclaw/
COPY packages/server/ packages/server/
# Copy the private frontend submodule when present.
COPY packages/web packages/web

# Build dist for shared workspace packages whose `exports` map points at
# dist subpaths. server imports @lobu/core from its dist barrel,
# and worker/openclaw plugin-loader resolves @lobu/openclaw-plugin by name
# at runtime (ESM-only export, not bundled), so dist/ must exist on disk.
RUN cd packages/core && bunx tsc \
    && cd ../connector-sdk && bunx tsc \
    && cd ../connector-worker && bunx tsc \
    && cd ../openclaw-plugin && bun run build

# Type check
RUN cd packages/server && bunx tsc --noEmit

# Bundle the backend so prod runs under Node (so isolated-vm loads). See
# docker/app/start.sh and packages/server/scripts/build-server-bundle.mjs
# for the full rationale.
RUN cd packages/server && bun run build:server

# Build frontend static assets (production only)
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
ARG SKIP_WEB_BUILD=false
RUN if [ "$SKIP_WEB_BUILD" = "false" ] && [ -f packages/web/package.json ]; then \
      cd packages/web && bun run build; \
    else \
      mkdir -p /app/packages/web/dist; \
    fi

# ===========================================
# Runtime
# ===========================================
FROM node:22-slim AS runtime

WORKDIR /app

# curl for health checks, dbmate for migrations, bun for tsx-equivalent, Chromium deps for connectors
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates unzip \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 \
      libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libpango-1.0-0 libcairo2 libasound2 libwayland-client0 \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://github.com/amacneil/dbmate/releases/download/v2.22.0/dbmate-linux-amd64 -o /usr/local/bin/dbmate \
    && chmod +x /usr/local/bin/dbmate \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
    && chmod +x /usr/local/bin/bun

ENV PATH="/usr/local/bin:${PATH}"

# Copy installed deps + source from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/config ./config
COPY --from=builder /app/packages/core ./packages/core
COPY --from=builder /app/packages/agent-worker ./packages/agent-worker
COPY --from=builder /app/packages/connector-sdk ./packages/connector-sdk
COPY --from=builder /app/packages/openclaw-plugin ./packages/openclaw-plugin
COPY --from=builder /app/packages/connectors ./packages/connectors
COPY --from=builder /app/packages/embeddings ./packages/embeddings
COPY --from=builder /app/packages/connector-worker ./packages/connector-worker
COPY --from=builder /app/packages/owletto-sdk ./packages/owletto-sdk
COPY --from=builder /app/packages/owletto-connectors ./packages/owletto-connectors
COPY --from=builder /app/packages/owletto-embeddings ./packages/owletto-embeddings
COPY --from=builder /app/packages/owletto-worker ./packages/owletto-worker
COPY --from=builder /app/packages/owletto-openclaw ./packages/owletto-openclaw
COPY --from=builder /app/packages/server ./packages/server
COPY --from=builder /app/packages/web ./packages/web

# Database migrations
COPY db/migrations ./db/migrations

# Install Playwright/patchright Chromium for browser-based connectors
RUN npx patchright install chromium 2>/dev/null || npx playwright install chromium 2>/dev/null || true

# Build metadata + environment defaults
ARG APP_GIT_SHA=unknown
ARG APP_BUILD_TIME=unknown
ENV NODE_ENV=production
ENV APP_GIT_SHA=${APP_GIT_SHA}
ENV APP_BUILD_TIME=${APP_BUILD_TIME}

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8787/health || exit 1

# Startup script
COPY docker/app/start.sh /app/start.sh
RUN chmod +x /app/start.sh

CMD ["/app/start.sh"]
