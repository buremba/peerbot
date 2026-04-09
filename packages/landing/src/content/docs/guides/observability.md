---
title: Observability
description: Distributed tracing, logging, and error monitoring for Lobu deployments.
---

Lobu includes built-in observability through OpenTelemetry tracing, structured logging (Loki-compatible), and error monitoring (Sentry).

## Distributed tracing

Lobu uses [OpenTelemetry](https://opentelemetry.io/) to trace messages end-to-end across the gateway and worker. Traces are exported via OTLP HTTP to any compatible collector (Tempo, Jaeger, Datadog, Honeycomb, etc.).

### What gets traced

Each incoming message creates a root span that propagates through the full request and response pipeline:

**Request path (gateway → worker):**

1. **message_received** — gateway ingests message from API or platform (Slack, Telegram, etc.)
2. **queue_processing** — message consumer picks up the job
3. **worker_creation** — gateway creates worker container/pod
4. **pvc_setup** — persistent volume setup (Kubernetes only)
5. **job_received** — worker receives the job
6. **exec_execution** — sandbox command execution (if applicable)
7. **agent_execution** — agent runs the prompt

**Response path (worker → platform):**

8. **response_delivery** — gateway receives worker response and routes to platform renderer

Spans are linked via W3C `traceparent` headers propagated through the queue, so a single trace ID connects the full round-trip from message ingestion through agent execution to response delivery. All entry points (API, Slack, Telegram, Discord, etc.) create root spans.

### Trace ID format

Each message gets a trace ID in the format `tr-{messageId}-{timestamp}-{random}` (e.g., `tr-abc12345-lx4k-a3b2`). This ID appears in logs and can be used to look up the full trace in Grafana.

### Enable tracing

Point `OTEL_EXPORTER_OTLP_ENDPOINT` at any OTLP HTTP collector. Tracing is automatically disabled when this variable is unset.

```bash
# .env — use any OTLP-compatible collector
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318/v1/traces
```

Both gateway and worker initialize tracing on startup when this is set. The gateway passes the endpoint to workers automatically. You can also set this during `lobu init`.

### Docker setup

Add a Tempo service to your `docker-compose.yml`:

```yaml
tempo:
  image: grafana/tempo:latest
  command: ["-config.file=/etc/tempo.yaml"]
  volumes:
    - ./tempo.yaml:/etc/tempo.yaml
    - tempo-data:/var/tempo
  ports:
    - "4318:4318"   # OTLP HTTP
    - "3200:3200"   # Tempo query API

grafana:
  image: grafana/grafana:latest
  ports:
    - "3001:3000"
  environment:
    - GF_AUTH_ANONYMOUS_ENABLED=true
    - GF_AUTH_ANONYMOUS_ORG_ROLE=Admin
  volumes:
    - grafana-data:/var/lib/grafana

volumes:
  tempo-data:
  grafana-data:
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

Then add `OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318/v1/traces` to your `.env` and restart.

### Kubernetes setup

Enable Tempo in your Helm values:

```yaml
tempo:
  enabled: true
  tempo:
    storage:
      trace:
        backend: local
        local:
          path: /var/tempo/traces
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: "0.0.0.0:4317"
          http:
            endpoint: "0.0.0.0:4318"
  persistence:
    enabled: true
    size: 10Gi

grafana:
  enabled: true
  namespace: "monitoring"
  lokiUrl: "http://loki:3100"
```

The Helm chart automatically:
- Configures Tempo and Loki datasources in Grafana with cross-linking (logs ↔ traces)
- Deploys the "Lobu Message Traces" dashboard

### Grafana dashboard

The built-in dashboard (`charts/lobu/grafana-dashboard.json`) provides:

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

```bash
# Docker
docker compose -f docker/docker-compose.yml logs -f gateway

# Kubernetes
kubectl logs -f deployment/lobu-gateway -n lobu
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
- Redis integration for queue-related errors
- 100% trace sample rate for full visibility

To disable, remove `SENTRY_DSN` from your `.env`.

## Environment variable summary

| Variable | Component | Description |
|----------|-----------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Gateway, Worker | OTLP HTTP endpoint for trace collector (e.g., `http://collector:4318/v1/traces`) |
| `SENTRY_DSN` | Gateway, Worker | Sentry DSN for error monitoring |
| `LOG_LEVEL` | Gateway, Worker | Minimum log level (`error`, `warn`, `info`, `debug`) |
| `LOG_FORMAT` | Gateway, Worker | Log output format (`json` or `text`) |
| `USE_WINSTON_LOGGER` | Gateway, Worker | Enable Winston logger (`true`/`false`) |
