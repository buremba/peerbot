---
title: Troubleshooting
description: Common issues and how to fix them.
---

## Worker won't start

```bash
# Check gateway logs first (it launches worker containers on demand)
docker compose -f docker/docker-compose.yml logs -f gateway

# List spawned worker containers
# (the compose `worker` service only builds the image; it does not stay running)
docker ps --format '{{.Names}}' | grep lobu-worker || true

# Common causes:
# - Port 8080 already in use → Change GATEWAY_PORT in .env
# - Docker network conflict → docker compose down -v && docker compose up -d
# - Invalid lobu.toml → npx @lobu/cli@latest validate
```

## Agent not responding

```bash
# Check if gateway is running
curl http://localhost:8080/health

# Check Redis connection
docker compose -f docker/docker-compose.yml exec redis redis-cli ping

# Clear stale chat history (for stuck conversations)
docker compose -f docker/docker-compose.yml exec redis redis-cli KEYS 'chat:history:*'
docker compose -f docker/docker-compose.yml exec redis redis-cli DEL 'chat:history:{key}'

# Recreate gateway after .env changes
# (`restart` does not reload env-file values)
docker compose -f docker/docker-compose.yml up -d --force-recreate gateway
```

## MCP tools failing

```bash
# Check MCP status at /api/docs on your gateway
# Verify worker can reach gateway
docker compose -f docker/docker-compose.yml exec worker curl -v http://gateway:8080/health

# For OAuth flows: check browser console and gateway logs
# For static headers: verify ${env:VAR} syntax in mcpServers config
```

## Platform connection issues

Platform connections are usually configured from the **Connections** UI or the `/api/v1/connections` API, not by editing per-platform env vars in `docker-compose.yml`.

**Slack**: Reconnect or reinstall the workspace after adding scopes. If you use Slack OAuth install flows on a self-hosted gateway, also verify `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` on the gateway.

**Telegram**: Verify the bot token and webhook / polling settings in the connection config. Webhook mode still needs a public HTTPS URL.

**Discord**: Verify the bot token, configured intents, and guild ID in the connection settings.

**WhatsApp**: Confirm the configured phone number is verified in Meta and matches the connection settings.

## Network policy blocking requests

```bash
# Check what domains are allowed
echo $WORKER_ALLOWED_DOMAINS

# Temporarily allow all (for testing only)
export WORKER_ALLOWED_DOMAINS="*"
docker compose -f docker/docker-compose.yml restart gateway

# Proper format: exact domain or .wildcard
# api.example.com  - only this domain
# .example.com     - all subdomains
```

## Worker can't reach the internet

By design, workers have no direct internet access. All traffic routes through the gateway proxy.

```bash
# Verify proxy is reachable
docker compose -f docker/docker-compose.yml exec worker curl -v http://gateway:8118

# Check if domain is in allowlist
# See "Network policy blocking requests" above
```

## Out of memory / disk space

```bash
# Check worker stats
docker stats

# Clean up old workspaces (Docker)
docker compose -f docker/docker-compose.yml down -v
rm -rf workspaces/*

# For K8s: check PVC usage
kubectl get pvc -n lobu
kubectl describe pvc <pvc-name> -n lobu
```

## Owletto connection issues

```bash
# Verify local Owletto is running (if you're using owletto-local)
curl http://localhost:8787/health

# Check file-first memory config
# - lobu.toml should contain [memory.owletto] with enabled = true and an org
# - MEMORY_URL is optional; use it mainly for local/custom Owletto base URLs

# Test connection
npx owletto@latest health
```

## Slow responses

```bash
# Check trace ID in logs (format: tr-xxx-lx4k-xxx)
# Use with Grafana Tempo or OTLP collector

# Common causes:
# - Cold worker start → Subsequent requests are faster
# - Model latency → Try a different provider/model
# - Large prompt context → Clear chat history or increase context window
```

## Docker-specific issues

```bash
# Clean restart
docker compose -f docker/docker-compose.yml down -v
docker system prune -f
docker compose -f docker/docker-compose.yml up -d

# Rebuild worker image after code changes
make clean-workers  # or: docker compose -f docker/docker-compose.yml build --no-cache worker
```

## Kubernetes-specific issues

```bash
# Check pod status
kubectl get pods -n lobu
kubectl describe pod <pod-name> -n lobu

# Worker not scaling?
# Check if HPA is hitting min/max replicas
kubectl get hpa -n lobu

# PVC stuck in Terminating?
kubectl patch pvc <pvc-name> -n lobu -p '{"metadata":{"finalizers":null}}'
```

## Still stuck?

1. Enable verbose logging: `LOG_LEVEL=debug` in `.env`
2. Collect logs with trace ID
3. Open an issue at [github.com/lobu-ai/lobu](https://github.com/lobu-ai/lobu)
