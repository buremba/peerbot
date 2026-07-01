# ===========================================
# Lobu API + Frontend (server)
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
# server depends on @lobu/pgvector-embedded (workspace:*); its manifest must be
# present for bun install to resolve the workspace member and for tsc to find
# its types. Prod never loads it at runtime (external Postgres) — it's pruned
# from the runtime node_modules below.
COPY packages/pgvector-embedded/package.json packages/pgvector-embedded/
# packages/owletto is a private git submodule. The glob lets the copy succeed
# when the submodule is not initialized (external contributors / backend-only builds).
COPY packages/owletto/package.jso[n] packages/owletto/

# Stub out workspace packages we don't build in this image so bun install doesn't
# error on missing manifests.
RUN mkdir -p packages/cli packages/landing packages/lobu-cli packages/browser-extension packages/mcpsandbox \
    && for p in cli landing browser-extension mcpsandbox; do \
        echo "{\"name\":\"@lobu/$p\",\"version\":\"0.0.0\",\"private\":true}" > "packages/$p/package.json"; \
      done \
    && echo '{"name":"lobu","version":"0.0.0","private":true}' > packages/lobu-cli/package.json

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
COPY packages/pgvector-embedded/ packages/pgvector-embedded/
COPY packages/server/ packages/server/
# Copy the private frontend submodule when present.
COPY packages/owletto packages/owletto

# Build dist for shared workspace packages whose `exports` map points at
# dist subpaths. server imports @lobu/core from its dist barrel,
# and worker/openclaw plugin-loader resolves @lobu/openclaw-plugin by name
# at runtime (ESM-only export, not bundled), so dist/ must exist on disk.
RUN cd packages/core && bunx tsc \
    && cd ../connector-sdk && bunx tsc \
    && cd ../embeddings && bunx tsc \
    && cd ../connector-worker && bunx tsc \
    && cd ../pgvector-embedded && bunx tsc \
    && cd ../openclaw-plugin && bun run build

# Type check
RUN cd packages/server && bunx tsc --noEmit

# Bundle the backend so prod runs under Node (so isolated-vm loads). See
# docker/app/start.sh and packages/server/scripts/build-server-bundle.mjs
# for the full rationale.
RUN cd packages/server && bun run build:server

# Prune the embedded-Postgres runtime (~145MB platform binary) before it reaches
# the runtime image. Prod always uses an external DATABASE_URL (postgres://), so
# server.ts never loads embedded-postgres or the pgvector injector — both are
# reached only via await import() on the file:// path. The builder needs them
# for the type-check + bundle above, so we drop them only afterward.
RUN rm -rf node_modules/embedded-postgres node_modules/@embedded-postgres

# Build frontend static assets (production only)
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
# Vite inlines these at build time (import.meta.env). Without VITE_SENTRY_DSN
# baked in here the prod SPA's initSentry() short-circuits and frontend errors
# never reach Sentry. Safe no-op when the build-arg is empty.
ARG VITE_SENTRY_DSN=
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ARG VITE_ENVIRONMENT=production
ENV VITE_ENVIRONMENT=$VITE_ENVIRONMENT
ARG SKIP_WEB_BUILD=false
RUN if [ "$SKIP_WEB_BUILD" = "false" ] && [ -f packages/owletto/package.json ]; then \
      cd packages/owletto && bun run build && bun run build:mcp-apps; \
    else \
      mkdir -p /app/packages/owletto/dist; \
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
COPY --from=builder /app/packages/server ./packages/server
COPY --from=builder /app/packages/owletto ./packages/owletto

# Database migrations
COPY db/migrations ./db/migrations

# Install Playwright/patchright Chromium for browser-based connectors.
# PLAYWRIGHT_BROWSERS_PATH pins both the install target and the runtime lookup to
# an absolute, HOME-independent path (default is $HOME/.cache/ms-playwright, which
# differs by USER and breaks the connector child forked in another cwd). chmod 755
# keeps it readable regardless of which user the runtime resolves to. The install
# must fail the build loudly — the old `2>/dev/null ... || true` silently shipped
# images with no Chromium. `playwright` is the patchright alias, so a single
# patchright install is deterministic.
RUN mkdir -p /ms-playwright && chmod 755 /ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx patchright install chromium

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
