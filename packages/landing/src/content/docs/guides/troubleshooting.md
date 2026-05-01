---
title: Troubleshooting
description: Common issues and how to fix them.
---

Lobu boots as a single Node process (`lobu run` / `node packages/server/dist/server.bundle.mjs`). Postgres (with pgvector) is the only user-provided external, reached via `DATABASE_URL`. Worker subprocesses are spawned by the gateway's `EmbeddedDeploymentManager`.

## Worker won't start

```bash
# Gateway logs are the Lobu process's stdout/stderr.
# If you ran `lobu run` directly, scroll up. If under systemd:
journalctl -u lobu -f

# List spawned worker subprocesses
ps -ef | grep '@lobu/worker' | grep -v grep

# Kill orphaned workers (if a crashed gateway left subprocesses behind)
make clean-workers   # in the monorepo
# or: pkill -f '@lobu/worker'

# Common causes:
# - Port 8787 already in use → Change GATEWAY_PORT or PORT in .env
# - DATABASE_URL not reachable → see "Agent not responding" below
# - Invalid lobu.toml → npx @lobu/cli@latest validate
```

## Agent not responding

```bash
# Check if Lobu is running
curl http://localhost:8787/health

# Check Postgres connection
psql "$DATABASE_URL" -c 'select 1'

# Clear stale chat history (for stuck conversations).
# History rows live in chat_state_lists keyed by `history:<connectionId>:<channelId>`.
psql "$DATABASE_URL" -c "DELETE FROM chat_state_lists WHERE key LIKE 'history:%';"

# Restart Lobu after .env changes (the process reads .env at boot)
# Ctrl+C the running process, then `lobu run` (or `make dev`) again.
```

## MCP tools failing

```bash
# Check MCP status at /api/docs on your gateway

# Verify the in-process HTTP proxy is reachable from the host
curl -v http://localhost:8118

# For OAuth flows: check browser console and Lobu logs
# For static headers: verify ${env:VAR} syntax in mcpServers config
```

## Platform connection issues

Platform connections are usually configured from the **Connections** UI or the `/api/v1/connections` API.

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
# Restart Lobu (Ctrl+C and re-run `lobu run` / `make dev`)

# Proper format: exact domain or .wildcard
# api.example.com  - only this domain
# .example.com     - all subdomains
```

## Worker can't reach the internet

By default, worker subprocesses run with `HTTP_PROXY=http://localhost:8118` so all outbound HTTP/HTTPS traverses the gateway proxy.

```bash
# Verify the proxy is reachable from the host
curl -v http://localhost:8118

# On Linux production hosts, the systemd-run wrapper enforces
# IPAddressDeny=any + IPAddressAllow=127.0.0.1 — so a worker that
# tries to bypass HTTP_PROXY is dropped at the kernel. On macOS dev,
# HTTP_PROXY is advisory; if a worker is bypassing it, audit the
# tool that issued the request.

# Check if the domain is in the allowlist (see "Network policy blocking requests")
```

## Out of memory / disk space

```bash
# Check Node process memory
ps -o pid,rss,command -p "$(pgrep -f 'server/dist/server.bundle.mjs')"

# Workspaces accumulate per agent under ./workspaces/
# Clear stale ones if disk is filling up:
rm -rf workspaces/*
```

## Owletto connection issues

```bash
# Owletto runs in-process with the gateway. /health covers both.
curl http://localhost:8787/health

# Check file-first memory config
# - lobu.toml should contain [memory.owletto] with enabled = true and an org
# - MEMORY_URL is optional; use it mainly for custom external Owletto URLs

# Test connection
npx @lobu/cli@latest memory health
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

## Postgres not reachable

```bash
# Verify DATABASE_URL in .env
grep -E '^DATABASE_URL=' .env

# Test connectivity
psql "$DATABASE_URL" -c 'select 1'

# If using local Postgres on macOS:
brew services list
brew services start postgresql
```

## Still stuck?

1. Enable verbose logging: `LOG_LEVEL=debug` in `.env`
2. Collect logs with trace ID
3. Open an issue at [github.com/lobu-ai/lobu](https://github.com/lobu-ai/lobu)
