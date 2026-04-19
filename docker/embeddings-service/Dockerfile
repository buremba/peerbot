# ===========================================
# Embeddings Service
# ===========================================

FROM node:22-slim AS builder

WORKDIR /app

RUN npm install -g pnpm@9

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/embeddings-service/package.json packages/embeddings-service/

RUN pnpm install --frozen-lockfile

COPY packages/embeddings-service/src/ packages/embeddings-service/src/
COPY packages/embeddings-service/tsconfig.json packages/embeddings-service/

RUN pnpm --filter @owletto/embeddings-service exec tsc --noEmit

FROM node:22-slim AS runtime

WORKDIR /app

RUN npm install -g pnpm@9 tsx@4

RUN useradd -m -s /bin/bash embeddings && \
    mkdir -p /app/.cache/transformers && \
    chown -R embeddings:embeddings /app

COPY --from=builder --chown=embeddings:embeddings /app/node_modules ./node_modules
COPY --from=builder --chown=embeddings:embeddings /app/packages/embeddings-service ./packages/embeddings-service
COPY --from=builder --chown=embeddings:embeddings /app/package.json ./

ENV NODE_ENV=production
ENV TRANSFORMERS_CACHE=/app/.cache/transformers

EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:8790/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER embeddings
WORKDIR /app/packages/embeddings-service

CMD ["tsx", "src/server.ts"]
