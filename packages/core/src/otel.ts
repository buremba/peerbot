/**
 * OpenTelemetry tracing setup for distributed tracing.
 * Ships traces via OTLP HTTP to any compatible collector (Tempo, Jaeger, Datadog, etc.).
 */

import type { Span, Tracer } from "@opentelemetry/api";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { createLogger } from "./logger";

const logger = createLogger("otel");

let provider: NodeTracerProvider | null = null;
let tracer: Tracer | null = null;

export interface OtelConfig {
  serviceName: string;
  serviceVersion?: string;
  otlpEndpoint?: string; // e.g., "http://collector:4318/v1/traces"
  enabled?: boolean;
}

/**
 * Initialize OpenTelemetry tracing.
 * Call this once at application startup.
 *
 * @example
 * initTracing({
 *   serviceName: "lobu-gateway",
 *   otlpEndpoint: "http://collector:4318/v1/traces",
 * });
 */
export function initTracing(config: OtelConfig): void {
  if (provider) {
    return; // Already initialized
  }

  const enabled = config.enabled ?? !!config.otlpEndpoint;
  if (!enabled) {
    logger.debug(
      "Tracing disabled (no OTEL_EXPORTER_OTLP_ENDPOINT configured)"
    );
    return;
  }

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion || "1.0.0",
  });

  provider = new NodeTracerProvider({ resource });

  const exporter = new OTLPTraceExporter({
    url: config.otlpEndpoint,
    timeoutMillis: 30000, // 30 second timeout for reliability
  });

  // Use SimpleSpanProcessor for immediate export (better for short-lived workers)
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();

  tracer = trace.getTracer(config.serviceName, config.serviceVersion);

  logger.info(
    `Tracing initialized: ${config.serviceName} -> ${config.otlpEndpoint}`
  );
}

/**
 * Get the configured tracer. Returns null if not initialized.
 */
export function getTracer(): Tracer | null {
  return tracer;
}

/**
 * Shutdown tracing gracefully.
 */
export async function shutdownTracing(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
    tracer = null;
  }
}

/**
 * Force flush all pending spans to the exporter.
 * Call this after processing a message to ensure spans are exported promptly.
 */
export async function flushTracing(): Promise<void> {
  if (provider) {
    await provider.forceFlush();
  }
}

/**
 * Create a new span for tracing.
 * If tracing is not initialized, returns a no-op span.
 *
 * @param name Span name (e.g., "queue_processing", "agent_execution")
 * @param attributes Optional attributes to add to the span
 * @param parentContext Optional parent context for trace correlation
 */
export function createSpan(
  name: string,
  attributes?: Record<string, string | number | boolean>,
  kind: SpanKind = SpanKind.INTERNAL
): Span | null {
  if (!tracer) {
    return null;
  }

  const span = tracer.startSpan(name, {
    kind,
    attributes,
  });

  return span;
}

/**
 * Execute a function within a span context.
 * Automatically handles span lifecycle (start, end, error recording).
 *
 * @example
 * const result = await withSpan("process_message", async (span) => {
 *   span?.setAttribute("messageId", messageId);
 *   return await processMessage();
 * });
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span | null) => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  const span = createSpan(name, attributes);

  try {
    const result = await fn(span);
    span?.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    if (span) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error as Error);
    }
    throw error;
  } finally {
    span?.end();
  }
}

/**
 * Get current active span from context.
 */
export function getCurrentSpan(): Span | undefined {
  return trace.getActiveSpan();
}

/**
 * Run a function within a span context, propagating the span.
 */
export function runInSpanContext<T>(span: Span, fn: () => T): T {
  const ctx = trace.setSpan(context.active(), span);
  return context.with(ctx, fn);
}

/**
 * Create a root span and return traceparent header for propagation.
 * Use this at the entry point (message ingestion) to start a trace.
 *
 * @example
 * const { span, traceparent } = createRootSpan("message_received", { messageId });
 * // Store traceparent in message metadata for downstream propagation
 * await queueProducer.enqueueMessage({ ...data, platformMetadata: { traceparent } });
 * span.end();
 */
export function createRootSpan(
  name: string,
  attributes?: Record<string, string | number | boolean>
): { span: Span | null; traceparent: string | null } {
  if (!tracer) {
    return { span: null, traceparent: null };
  }

  const span = tracer.startSpan(name, {
    kind: SpanKind.SERVER,
    attributes,
  });

  // Extract W3C traceparent header from span context
  const spanContext = span.spanContext();
  const traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-01`;

  return { span, traceparent };
}

/**
 * Create a child span from a traceparent header.
 * Use this to continue a trace in downstream services (queue consumer, worker).
 *
 * @example
 * const traceparent = data.platformMetadata?.traceparent;
 * const span = createChildSpan("queue_processing", traceparent, { jobId });
 * // ... do work ...
 * span?.end();
 */
export function createChildSpan(
  name: string,
  traceparent: string | null | undefined,
  attributes?: Record<string, string | number | boolean>
): Span | null {
  if (!tracer) {
    return null;
  }

  if (!traceparent) {
    // No parent context - create independent span
    return createSpan(name, attributes);
  }

  // Parse W3C traceparent: 00-traceId-parentSpanId-flags
  const parts = traceparent.split("-");
  if (parts.length !== 4) {
    return createSpan(name, attributes);
  }

  const traceId = parts[1]!;
  const parentSpanId = parts[2]!;

  // Create span context from traceparent
  const parentContext = trace.setSpanContext(context.active(), {
    traceId,
    spanId: parentSpanId,
    traceFlags: 1, // sampled
    isRemote: true,
  });

  // Start span as child of the propagated context
  return tracer.startSpan(
    name,
    { kind: SpanKind.INTERNAL, attributes },
    parentContext
  );
}

/**
 * Run a function within a child span context.
 * Automatically handles span lifecycle and error recording.
 *
 * @example
 * const result = await withChildSpan("process_job", traceparent, async (span) => {
 *   span?.setAttribute("jobId", jobId);
 *   return await processJob();
 * });
 */
export async function withChildSpan<T>(
  name: string,
  traceparent: string | null | undefined,
  fn: (span: Span | null) => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  const span = createChildSpan(name, traceparent, attributes);

  try {
    const result = await fn(span);
    span?.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    if (span) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error as Error);
    }
    throw error;
  } finally {
    span?.end();
  }
}

/**
 * Extract traceparent from span for propagation to downstream services.
 */
export function getTraceparent(span: Span | null): string | null {
  if (!span) return null;
  const ctx = span.spanContext();
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

export type { Span, Tracer };
// Re-export OpenTelemetry types for convenience
export { SpanKind, SpanStatusCode };
