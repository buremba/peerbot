---
title: Observability
description: Distributed tracing, logging, and error monitoring for Lobu deployments.
---

Lobu includes built-in observability through OpenTelemetry tracing, structured logging (Loki-compatible), and error monitoring (Sentry).

## Distributed tracing

Lobu uses [OpenTelemetry](https://opentelemetry.io/) to trace messages end-to-end across the gateway and worker. Traces are exported via OTLP gRPC to any compatible collector. We recommend [Grafana Tempo](https://grafana.com/oss/tempo/), but any OTLP-compatible backend works (Jaeger, Datadog, Honeycomb, etc.).

### What gets traced

Each incoming message creates a root span that propagates through the full request and response pipeline:

**Request path (gateway → worker):**

1. **message_received** — gateway ingests message from API or platform (Slack, Telegram, etc.)
2. **queue_processing** — message consumer picks up the job
3. **worker_creation** — gateway spawns the worker subprocess
4. **job_received** — worker receives the job
5. **exec_execution** — sandbox command execution (if applicable)
6. **agent_execution** — agent runs the prompt

**Response path (worker → platform):**

8. **response_delivery** — gateway receives worker response and routes to platform renderer

Spans are linked via W3C `traceparent` headers propagated through the queue, so a single trace ID connects the full round-trip from message ingestion through agent execution to response delivery. All entry points (API, Slack, Telegram, Discord, etc.) create root spans.

### Trace ID format

Each message gets a trace ID in the format `tr-{messageId}-{timestamp}-{random}` (e.g., `tr-abc12345-lx4k-a3b2`). This ID appears in logs and can be used to look up the full trace in Grafana.

### Enable tracing

Point `OTEL_EXPORTER_OTLP_ENDPOINT` at any OTLP gRPC endpoint. Tracing is automatically disabled when this variable is unset.

```bash
# .env — any OTLP gRPC endpoint (default port 4317)
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4317
```

Both gateway and worker initialize tracing on startup when this is set. The gateway passes the endpoint to workers automatically. You can also set this during `lobu init`.

### Local Tempo + Grafana

Lobu doesn't bundle observability infrastructure. Run Tempo and Grafana however you prefer — managed (Grafana Cloud), a separate compose file, or directly via `docker run` / `podman run`. Then point Lobu at the OTLP endpoint via `OTEL_EXPORTER_OTLP_ENDPOINT`.

For a minimal local stack:

```bash
docker run -d --name tempo -p 4318:4318 -p 3200:3200 \
  -v "$PWD/tempo.yaml:/etc/tempo.yaml" -v tempo-data:/var/tempo \
  grafana/tempo:latest -config.file=/etc/tempo.yaml

docker run -d --name grafana -p 3001:3000 \
  -e GF_AUTH_ANONYMOUS_ENABLED=true -e GF_AUTH_ANONYMOUS_ORG_ROLE=Admin \
  -v grafana-data:/var/lib/grafana grafana/grafana:latest
```

Minimal `tempo.yaml`:

```yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: "0.0.0.0:4318"

storage:
  trace:
    backend: local
    local:
      path: /var/tempo/traces

metrics_generator:
  storage:
    path: /var/tempo/metrics
```

Then add `OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4317` to your `.env` and restart.

### Grafana dashboard

A reference Grafana dashboard JSON is published with each release. It provides:

- **Messages processed per minute** — throughput time series
- **Recent stage completions** — table of recent traces with stage and duration
- **Stage timeline** — per-trace waterfall showing duration by stage
- **Trace details** — full log view for a selected trace
- **Errors** — filtered error logs

Filter by trace ID prefix (e.g., `tr-abc`) to drill into a specific conversation.

## Logging

Lobu uses a console logger by default (unbuffered, 12-factor compliant). Logs are structured for easy parsing by Loki or any log aggregator.

### Environment variables

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `LOG_LEVEL` | `error`, `warn`, `info`, `debug` | `info` | Minimum log level |
| `LOG_FORMAT` | `json`, `text` | `text` | Output format. Use `json` for Loki/Grafana |
| `USE_WINSTON_LOGGER` | `true`, `false` | `false` | Enable Winston logger for file rotation and multiple transports |

### Log format

**Text** (default, development):
```
[2025-01-15 14:30:22] [info] [gateway] Processing message {"traceId":"tr-abc12345-lx4k-a3b2"}
```

**JSON** (production, Loki-friendly):
```json
{"timestamp":"2025-01-15T14:30:22.123Z","level":"info","service":"gateway","message":"Processing message","traceId":"tr-abc12345-lx4k-a3b2"}
```

### Viewing logs

Logs come from the single Lobu Node process's stdout/stderr. View them however you supervise the process:

```bash
# Foreground
lobu run

# systemd
journalctl -u lobu -f

# pm2
pm2 logs lobu
```

## Error monitoring (Sentry)

Lobu integrates with [Sentry](https://sentry.io/) for error and warning capture. Sentry is **opt-in only** — no error data is sent unless you explicitly enable it.

### Enable Sentry

During `lobu init`, you'll be asked whether to share anonymous error reports with Lobu's community Sentry project. You can also configure your own Sentry project:

```bash
# .env — use Lobu's community DSN or your own
SENTRY_DSN=https://your-dsn@sentry.io/your-project
```

When set, errors and warnings from both gateway and worker are automatically sent to Sentry with:
- Console log integration (captures `log`, `warn`, `error`)
- 100% trace sample rate for full visibility

To disable, remove `SENTRY_DSN` from your `.env`.

## Environment variable summary

| Variable | Component | Description |
|----------|-----------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Gateway, Worker | OTLP gRPC endpoint for trace collector (e.g., `http://collector:4317`) |
| `SENTRY_DSN` | Gateway, Worker | Sentry DSN for error monitoring |
| `LOG_LEVEL` | Gateway, Worker | Minimum log level (`error`, `warn`, `info`, `debug`) |
| `LOG_FORMAT` | Gateway, Worker | Log output format (`json` or `text`) |
| `USE_WINSTON_LOGGER` | Gateway, Worker | Enable Winston logger (`true`/`false`) |
