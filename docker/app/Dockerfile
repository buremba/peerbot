# ===========================================
# Owletto API + Frontend (owletto-backend)
# ===========================================
# Hono server that embeds @lobu/gateway and serves the owletto-web frontend.

FROM node:22-slim AS builder

WORKDIR /app

# Bun for workspace install + tsc. git needed because some deps ship git URLs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
    && chmod +x /usr/local/bin/bun

ENV PATH="/usr/local/bin:${PATH}"

# Root workspace files
COPY bun.lock package.json tsconfig.json ./
COPY patches/ ./patches/

# Workspace package manifests needed to resolve the backend + its deps.
COPY packages/core/package.json packages/core/
COPY packages/gateway/package.json packages/gateway/
COPY packages/worker/package.json packages/worker/
COPY packages/owletto-backend/package.json packages/owletto-backend/
COPY packages/owletto-sdk/package.json packages/owletto-sdk/
COPY packages/owletto-openclaw/package.json packages/owletto-openclaw/
COPY packages/owletto-connectors/package.json packages/owletto-connectors/
COPY packages/owletto-embeddings/package.json packages/owletto-embeddings/
COPY packages/owletto-worker/package.json packages/owletto-worker/
# packages/owletto-web is a private git submodule. The glob lets the copy succeed
# when the submodule is not initialized (external contributors / backend-only builds).
COPY packages/owletto-web/package.jso[n] packages/owletto-web/

# Stub out workspace packages we don't build in this image so bun install doesn't
# error on missing manifests.
RUN mkdir -p packages/cli packages/landing packages/owletto-cli packages/owletto-extension packages/mcpsandbox \
    && for p in cli landing owletto-extension mcpsandbox; do \
        echo "{\"name\":\"@lobu/$p\",\"version\":\"0.0.0\",\"private\":true}" > "packages/$p/package.json"; \
      done \
    && echo '{"name":"owletto","version":"0.0.0","private":true}' > packages/owletto-cli/package.json

RUN --mount=type=cache,target=/root/.bun/install/cache bun install

# Force rebuild of source layers
ARG CACHEBUST=default
ARG APP_GIT_SHA=unknown
ARG APP_BUILD_TIME=unknown
RUN echo "Build: ${CACHEBUST}" && date > /tmp/.build-time

# Source code
COPY config/ config/
COPY packages/core/ packages/core/
COPY packages/gateway/ packages/gateway/
COPY packages/worker/ packages/worker/
COPY packages/owletto-sdk/ packages/owletto-sdk/
COPY packages/owletto-openclaw/ packages/owletto-openclaw/
COPY packages/owletto-connectors/ packages/owletto-connectors/
COPY packages/owletto-embeddings/ packages/owletto-embeddings/
COPY packages/owletto-worker/ packages/owletto-worker/
COPY packages/owletto-backend/ packages/owletto-backend/
# Copy the private frontend submodule when present.
COPY packages/owletto-web packages/owletto-web

# Build dist for packages whose `exports` map points at dist subpaths.
# owletto-backend imports `@lobu/gateway/dist/connections` and
# `@lobu/gateway/dist/api`, so gateway must be built before typechecking.
# Build everything in a single RUN for consistent file mtimes (composite
# project references are mtime-sensitive). Use `tsc -b` from gateway so
# it walks the reference graph (gateway → core) in dependency order.
RUN cd packages/core && bunx tsc \
    && cd ../owletto-sdk && bunx tsc \
    && cd ../gateway && bunx tsc -b --force

# Type check
RUN cd packages/owletto-backend && bunx tsc --noEmit

# Build frontend static assets (production only)
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
ARG SKIP_WEB_BUILD=false
RUN if [ "$SKIP_WEB_BUILD" = "false" ] && [ -f packages/owletto-web/package.json ]; then \
      cd packages/owletto-web && bun run build; \
    else \
      mkdir -p /app/packages/owletto-web/dist; \
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
COPY --from=builder /app/packages/gateway ./packages/gateway
COPY --from=builder /app/packages/worker ./packages/worker
COPY --from=builder /app/packages/owletto-sdk ./packages/owletto-sdk
COPY --from=builder /app/packages/owletto-openclaw ./packages/owletto-openclaw
COPY --from=builder /app/packages/owletto-connectors ./packages/owletto-connectors
COPY --from=builder /app/packages/owletto-embeddings ./packages/owletto-embeddings
COPY --from=builder /app/packages/owletto-worker ./packages/owletto-worker
COPY --from=builder /app/packages/owletto-backend ./packages/owletto-backend
COPY --from=builder /app/packages/owletto-web ./packages/owletto-web

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
