/**
 * Simple Prometheus metrics exporter (no external dependencies)
 * Exposes basic gateway metrics in Prometheus text format
 */

import { createLogger } from "@lobu/core";

const logger = createLogger("metrics");

interface MetricValue {
  value: number;
  labels: Record<string, string>;
}

interface Metric {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  /** Keyed by JSON.stringify(labels) for O(1) lookup. */
  valuesByKey: Map<string, MetricValue>;
}

const metrics: Map<string, Metric> = new Map();

function initializeMetrics() {
  registerMetric(
    "lobu_worker_deployments_total",
    "Total number of worker deployments created",
    "counter"
  );
  registerMetric(
    "lobu_worker_deployments_failed_total",
    "Total number of failed worker deployments",
    "counter"
  );
  registerMetric(
    "lobu_worker_deployments_active",
    "Current number of active worker deployments",
    "gauge"
  );
  registerMetric(
    "lobu_messages_received_total",
    "Total number of messages received",
    "counter"
  );
  registerMetric(
    "lobu_messages_processed_total",
    "Total number of messages processed",
    "counter"
  );
  registerMetric("lobu_queue_length", "Current message queue length", "gauge");
  registerMetric(
    "lobu_proxy_requests_total",
    "Total number of HTTP proxy requests",
    "counter"
  );
  registerMetric(
    "lobu_proxy_requests_blocked_total",
    "Total number of blocked proxy requests",
    "counter"
  );
  // Terminal run failures (exhausted retries) by run_type + queue. A
  // user-facing reply (run_type='chat_message') that lands here was dropped —
  // alert on rate(lobu_runs_failed_total{run_type="chat_message"}[5m]). The
  // failed `runs` rows are the durable dead-letter record (see
  // FAILED_RUNS_RETENTION_DAYS); this counter is the actionable signal.
  registerMetric(
    "lobu_runs_failed_total",
    "Runs that reached terminal 'failed' after exhausting retries, by run_type and queue",
    "counter"
  );
  // Transient DB connection-drop retries (db/with-retry.ts). The prod pooler
  // (or an intermediary LB) silently closes idle/reloaded sockets; postgres.js
  // rejects the next query with CONNECTION_ENDED. We retry on a fresh
  // connection. outcome="retried" counts caught drops; outcome="exhausted"
  // counts the ones that still failed after retries (those are the 500s we
  // used to always emit). Alert on
  // rate(lobu_db_conn_retry_total{outcome="exhausted"}[5m]).
  registerMetric(
    "lobu_db_conn_retry_total",
    "Transient DB connection drops retried, by call-site op and outcome (retried|exhausted)",
    "counter"
  );
  registerMetric(
    "lobu_process_start_time_seconds",
    "Start time of the process since unix epoch in seconds",
    "gauge"
  );

  // Cross-replica SSE fan-out (services/sse-fanout.ts). published/received
  // should track each other across the fleet (received ≈ published × (N-1));
  // oversize > 0 means events fell back to local-only delivery and the
  // runs.action_input ref design should be revisited before any owner-gate
  // removal.
  registerMetric(
    "lobu_sse_fanout_published_total",
    "SSE events published to peer replicas via pg_notify",
    "counter"
  );
  registerMetric(
    "lobu_sse_fanout_received_total",
    "Peer SSE events received via LISTEN sse_fanout",
    "counter"
  );
  registerMetric(
    "lobu_sse_fanout_publish_failed_total",
    "SSE fan-out NOTIFY attempts that failed",
    "counter"
  );
  registerMetric(
    "lobu_sse_fanout_oversize_total",
    "SSE events skipped from fan-out for exceeding the NOTIFY payload cap",
    "counter"
  );

  // Scheduler + watcher-automation health. These back the prod alerting rules
  // (charts/lobu PrometheusRule): a silent scheduler / failing watcher tick is
  // exactly the failure mode that went undetected for 12 days (lobu#1046).
  // Per-pod in-memory counters are the correct Prometheus model — each pod's
  // /metrics is scraped and summed across pods; counter resets on restart are
  // handled by rate()/increase().
  registerMetric(
    "lobu_scheduled_job_runs_total",
    "Scheduled (cron) task ticks by task name and outcome (success|error)",
    "counter"
  );
  registerMetric(
    "lobu_watcher_automation_phase_failures_total",
    "watcher-automation phases that threw, by phase (reset|reconcile|materialize|dispatch)",
    "counter"
  );
  registerMetric(
    "lobu_watcher_runs_created_total",
    "Watcher runs materialized (enqueued) by the scheduler",
    "counter"
  );
  registerMetric(
    "lobu_watchers_unrunnable",
    "Due active watchers skipped this tick for lacking a runnable executor (no device pin, no agent row)",
    "gauge"
  );

  setGaugeInternal("lobu_process_start_time_seconds", Math.floor(Date.now() / 1000));
  logger.info("Prometheus metrics initialized");
}

function registerMetric(
  name: string,
  help: string,
  type: "counter" | "gauge" | "histogram"
) {
  metrics.set(name, { name, help, type, valuesByKey: new Map() });
}

function setGaugeInternal(
  name: string,
  value: number,
  labels: Record<string, string> = {}
) {
  const metric = metrics.get(name);
  if (!metric || metric.type !== "gauge") {
    logger.warn(`Gauge metric ${name} not found`);
    return;
  }

  const labelKey = JSON.stringify(labels);
  const existing = metric.valuesByKey.get(labelKey);
  if (existing) {
    existing.value = value;
  } else {
    metric.valuesByKey.set(labelKey, { value, labels });
  }
}

export function setGauge(
  name: string,
  value: number,
  labels: Record<string, string> = {}
): void {
  setGaugeInternal(name, value, labels);
}

export function incrementCounter(
  name: string,
  labels: Record<string, string> = {},
  by = 1
): void {
  const metric = metrics.get(name);
  if (!metric || metric.type !== "counter") {
    logger.warn(`Counter metric ${name} not found`);
    return;
  }
  const labelKey = JSON.stringify(labels);
  const existing = metric.valuesByKey.get(labelKey);
  if (existing) {
    existing.value += by;
  } else {
    metric.valuesByKey.set(labelKey, { value: by, labels });
  }
}

export function getMetricsText(): string {
  const lines: string[] = [];

  for (const metric of metrics.values()) {
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);

    if (metric.valuesByKey.size === 0) {
      lines.push(`${metric.name} 0`);
      continue;
    }

    for (const { value, labels } of metric.valuesByKey.values()) {
      const labelStr = Object.entries(labels)
        .map(([key, labelValue]) => `${key}="${labelValue}"`)
        .join(",");
      if (labelStr) {
        lines.push(`${metric.name}{${labelStr}} ${value}`);
      } else {
        lines.push(`${metric.name} ${value}`);
      }
    }
  }

  const memUsage = process.memoryUsage();
  lines.push("# HELP nodejs_heap_size_bytes Node.js heap size in bytes");
  lines.push("# TYPE nodejs_heap_size_bytes gauge");
  lines.push(`nodejs_heap_size_bytes{type="used"} ${memUsage.heapUsed}`);
  lines.push(`nodejs_heap_size_bytes{type="total"} ${memUsage.heapTotal}`);
  lines.push(
    "# HELP nodejs_external_memory_bytes Node.js external memory in bytes"
  );
  lines.push("# TYPE nodejs_external_memory_bytes gauge");
  lines.push(`nodejs_external_memory_bytes ${memUsage.external}`);

  return `${lines.join("\n")}\n`;
}

initializeMetrics();
