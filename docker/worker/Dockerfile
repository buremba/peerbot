# ===========================================
# Lobu Worker (connector-worker daemon)
# ===========================================
# Self-hosted worker for Lobu connectors and embedding generation.

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

# Manifests for the worker and its workspace deps. core is a real
# build-time dep (connector-sdk imports @lobu/core), so its package.json
# must be the real one — not a stub.
COPY packages/connector-worker/package.json packages/connector-worker/
COPY packages/connector-sdk/package.json packages/connector-sdk/
COPY packages/connectors/package.json packages/connectors/
COPY packages/embeddings/package.json packages/embeddings/
COPY packages/core/package.json packages/core/

# Stub workspaces not needed at build time
RUN mkdir -p packages/cli packages/landing \
               packages/server packages/lobu-cli \
               packages/openclaw-plugin packages/owletto packages/agent-worker packages/mcpsandbox \
    && for p in cli landing server \
                openclaw-plugin owletto agent-worker mcpsandbox; do \
        echo "{\"name\":\"@lobu/$p\",\"version\":\"0.0.0\",\"private\":true}" > "packages/$p/package.json"; \
      done \
    && echo '{"name":"@lobu/worker","version":"0.0.0","private":true}' > packages/agent-worker/package.json \
    && echo '{"name":"lobu","version":"0.0.0","private":true}' > packages/lobu-cli/package.json

RUN --mount=type=cache,target=/root/.bun/install/cache bun install

# Source code (core needed because connector-sdk imports @lobu/core)
COPY packages/core/ packages/core/
COPY packages/connector-sdk/ packages/connector-sdk/
COPY packages/connectors/ packages/connectors/
COPY packages/embeddings/ packages/embeddings/
COPY packages/connector-worker/ packages/connector-worker/

# Build workspace dists required by runtime source imports.
# connector-sdk imports @lobu/core; connector-worker/src/embeddings.ts imports
# @lobu/embeddings, whose package exports point at dist/.
RUN cd packages/core && bunx tsc \
    && cd ../connector-sdk && bunx tsc \
    && cd ../embeddings && bunx tsc

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

# Non-root user. Pinned UID and numeric final USER so the kubelet can
# verify runAsNonRoot — a named USER fails CreateContainerConfigError
# ("non-numeric user, cannot verify user is non-root"). Keep in sync
# with worker.containerSecurityContext.runAsUser in charts/lobu.
RUN useradd -m -u 1001 -s /bin/bash worker && \
    mkdir -p /app/.cache/transformers /ms-playwright && \
    chown -R worker:worker /app /ms-playwright

COPY --from=builder --chown=worker:worker /app/node_modules ./node_modules
COPY --from=builder --chown=worker:worker /app/package.json ./
COPY --from=builder --chown=worker:worker /app/tsconfig.json ./
# connector-sdk imports @lobu/core (logger/retry); the bun workspace symlink
# points at packages/core, so the runtime stage must include it or the symlink
# dangles -> "ENOENT reading .../connector-sdk/node_modules/@lobu/core" at feed
# sync. Mirrors docker/app/Dockerfile, which already copies core.
COPY --from=builder --chown=worker:worker /app/packages/core ./packages/core
COPY --from=builder --chown=worker:worker /app/packages/connector-sdk ./packages/connector-sdk
COPY --from=builder --chown=worker:worker /app/packages/connectors ./packages/connectors
COPY --from=builder --chown=worker:worker /app/packages/embeddings ./packages/embeddings
COPY --from=builder --chown=worker:worker /app/packages/connector-worker ./packages/connector-worker

# Install patchright's Chromium (declared as `playwright` alias in worker package.json).
# Use bunx from the worker workspace so bun's resolver finds the alias.
# PLAYWRIGHT_BROWSERS_PATH pins BOTH the install target and the runtime lookup to
# an absolute, HOME-independent path. Without it patchright defaults to
# $HOME/.cache/ms-playwright (/home/worker/.cache/ms-playwright), and the connector
# child spawned via fork() in a different cwd can fail to resolve the binary ->
# "Executable doesn't exist". /ms-playwright is created + chowned to worker above;
# subprocess.ts already forwards PLAYWRIGHT_BROWSERS_PATH to the connector child.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER 1001
WORKDIR /app/packages/connector-worker
RUN bunx --bun playwright install chromium
WORKDIR /app

ENV NODE_ENV=production
ENV TRANSFORMERS_CACHE=/app/.cache/transformers

WORKDIR /app/packages/connector-worker

CMD ["bun", "src/bin.ts", "daemon"]
