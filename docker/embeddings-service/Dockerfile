# ===========================================
# Embeddings Service (owletto-embeddings)
# ===========================================

FROM node:22-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
    && chmod +x /usr/local/bin/bun

ENV PATH="/usr/local/bin:${PATH}"

COPY bun.lock package.json tsconfig.json ./
COPY patches/ ./patches/
COPY packages/owletto-embeddings/package.json packages/owletto-embeddings/

# Stub workspaces not needed at build time
RUN mkdir -p packages/cli packages/core packages/gateway packages/landing \
               packages/owletto-backend packages/owletto-cli packages/owletto-connectors \
               packages/owletto-extension packages/owletto-openclaw packages/owletto-sdk \
               packages/owletto-web packages/owletto-worker packages/worker packages/mcpsandbox \
    && for p in cli core gateway landing owletto-backend owletto-connectors \
                owletto-extension owletto-openclaw owletto-sdk owletto-web owletto-worker worker mcpsandbox; do \
        echo "{\"name\":\"@lobu/$p\",\"version\":\"0.0.0\",\"private\":true}" > "packages/$p/package.json"; \
      done \
    && echo '{"name":"owletto","version":"0.0.0","private":true}' > packages/owletto-cli/package.json

RUN --mount=type=cache,target=/root/.bun/install/cache bun install

COPY packages/owletto-embeddings/ packages/owletto-embeddings/

RUN cd packages/owletto-embeddings && bunx tsc --noEmit

# ===========================================
# Runtime
# ===========================================
FROM node:22-slim AS runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
    && chmod +x /usr/local/bin/bun

ENV PATH="/usr/local/bin:${PATH}"

RUN useradd -m -s /bin/bash embeddings && \
    mkdir -p /app/.cache/transformers && \
    chown -R embeddings:embeddings /app

COPY --from=builder --chown=embeddings:embeddings /app/node_modules ./node_modules
COPY --from=builder --chown=embeddings:embeddings /app/package.json ./
COPY --from=builder --chown=embeddings:embeddings /app/packages/owletto-embeddings ./packages/owletto-embeddings

ENV NODE_ENV=production
ENV TRANSFORMERS_CACHE=/app/.cache/transformers

EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:8790/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER embeddings
WORKDIR /app/packages/owletto-embeddings

CMD ["bun", "src/server.ts"]
