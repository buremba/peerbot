# ===========================================
# Owletto Worker (connector-worker daemon)
# ===========================================
# Self-hosted worker for Owletto connectors and embedding generation.

FROM node:22-bookworm AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
    && chmod +x /usr/local/bin/bun

ENV PATH="/usr/local/bin:${PATH}"

# Root workspace files
COPY bun.lock package.json tsconfig.json ./
COPY patches/ ./patches/

# Manifests for the worker and its workspace deps
COPY packages/connector-worker/package.json packages/connector-worker/
COPY packages/connector-sdk/package.json packages/connector-sdk/
COPY packages/connectors/package.json packages/connectors/
COPY packages/embeddings/package.json packages/embeddings/

# Stub workspaces not needed at build time
RUN mkdir -p packages/cli packages/core packages/landing \
               packages/server packages/owletto-cli packages/browser-extension \
               packages/openclaw-plugin packages/web packages/agent-worker packages/mcpsandbox \
    && for p in cli core landing server \
                browser-extension openclaw-plugin web agent-worker mcpsandbox; do \
        echo "{\"name\":\"@lobu/$p\",\"version\":\"0.0.0\",\"private\":true}" > "packages/$p/package.json"; \
      done \
    && echo '{"name":"@lobu/worker","version":"0.0.0","private":true}' > packages/agent-worker/package.json \
    && echo '{"name":"owletto","version":"0.0.0","private":true}' > packages/owletto-cli/package.json

RUN --mount=type=cache,target=/root/.bun/install/cache bun install

# Source code
COPY packages/connector-sdk/ packages/connector-sdk/
COPY packages/connectors/ packages/connectors/
COPY packages/embeddings/ packages/embeddings/
COPY packages/connector-worker/ packages/connector-worker/

# Build SDK dist (worker imports compiled sdk)
RUN cd packages/connector-sdk && bunx tsc

# ===========================================
# Runtime
# ===========================================
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip \
      libimage-exiftool-perl \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
      libcairo2 libasound2 libxshmfence1 libxfixes3 libglib2.0-0 fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
    && chmod +x /usr/local/bin/bun

ENV PATH="/usr/local/bin:${PATH}"

# Non-root user
RUN useradd -m -s /bin/bash worker && \
    mkdir -p /app/.cache/transformers /ms-playwright && \
    chown -R worker:worker /app /ms-playwright

COPY --from=builder --chown=worker:worker /app/node_modules ./node_modules
COPY --from=builder --chown=worker:worker /app/package.json ./
COPY --from=builder --chown=worker:worker /app/tsconfig.json ./
COPY --from=builder --chown=worker:worker /app/packages/connector-sdk ./packages/connector-sdk
COPY --from=builder --chown=worker:worker /app/packages/connectors ./packages/connectors
COPY --from=builder --chown=worker:worker /app/packages/embeddings ./packages/embeddings
COPY --from=builder --chown=worker:worker /app/packages/connector-worker ./packages/connector-worker

# Install patchright's Chromium (declared as `playwright` alias in worker package.json).
# Use bunx from the worker workspace so bun's resolver finds the alias.
USER worker
WORKDIR /app/packages/connector-worker
RUN bunx --bun playwright install chromium
WORKDIR /app

ENV NODE_ENV=production
ENV TRANSFORMERS_CACHE=/app/.cache/transformers

WORKDIR /app/packages/connector-worker

CMD ["bun", "src/bin.ts", "daemon"]
