---
title: Docker
description: How Lobu works in Docker Compose mode.
sidebar:
  order: 1
---

Docker mode is the easiest way to run Lobu on a single machine.

## Docker images

Pre-built images are published to GitHub Container Registry on every push to `main`:

| Image | Description |
|-------|-------------|
| `ghcr.io/lobu-ai/lobu-gateway` | Gateway server |
| `ghcr.io/lobu-ai/lobu-worker-base` | Worker base image |

```bash
docker pull ghcr.io/lobu-ai/lobu-gateway:latest
docker pull ghcr.io/lobu-ai/lobu-worker-base:latest
```

Tags follow the pattern `latest`, `<version>`, and `main-<sha>`.

## How It Works

1. `docker compose` starts gateway + Redis.
2. Gateway creates per-session worker containers on demand using the worker image.
3. Each worker gets an isolated workspace directory (for example `./workspaces/{threadId}/`).
4. Worker network access goes through the gateway proxy (`HTTP_PROXY=http://gateway:8118`).

## Isolation Model

Lobu's Docker deployment uses two Docker networks:

- Public network for gateway ingress
- Internal network for worker-to-gateway traffic

Workers are attached to the internal network with no direct external route. External HTTP traffic is controlled by the gateway proxy and domain policy (`WORKER_ALLOWED_DOMAINS` / `WORKER_DISALLOWED_DOMAINS`).

## When to Use Docker Mode

Use Docker mode when:

- You are getting started quickly
- You run a single-node production deployment
- You want simple operations without Kubernetes

## Operational Notes

- Start stack: `npx @lobu/cli run -d` or `docker compose up -d`
- Restart after `.env` changes
- Session persistence is provided by mounted workspace directories
