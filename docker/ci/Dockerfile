# CI image for running tests locally against K8s.
# Minimal: bun + node + pg client. No build artifacts, no app source.

ARG BUN_VERSION=1.3.5

FROM node:22-slim

ARG BUN_VERSION

WORKDIR /workspace

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl unzip \
      postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s -- "bun-v${BUN_VERSION}" \
    && chmod +x /usr/local/bin/bun

ENV PATH="/usr/local/bin:${PATH}"
