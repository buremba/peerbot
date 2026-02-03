/**
 * Trace ID utilities for end-to-end message lifecycle observability.
 * Trace IDs propagate through the entire pipeline:
 * [WhatsApp Message] -> [Queue] -> [Worker Creation] -> [PVC Setup] -> [Agent Runtime] -> [Response]
 *
 * When OpenTelemetry is initialized, spans are sent to Tempo for waterfall visualization.
 * Use createSpan/createChildSpan from ./otel.ts for actual span creation.
 */

/**
 * Generate a trace ID from a message ID.
 * Format: tr-{messageId prefix}-{timestamp base36}-{random}
 * Example: tr-abc12345-lx4k-a3b2
 */
export function generateTraceId(messageId: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  // Take first 8 chars of messageId, sanitize for safe logging
  const shortMessageId = messageId.replace(/[^a-zA-Z0-9]/g, "").substring(0, 8);
  return `tr-${shortMessageId}-${timestamp}-${random}`;
}

/**
 * Extract trace ID from various payload formats.
 * Checks both top-level and nested platformMetadata.
 */
export function extractTraceId(payload: {
  traceId?: string;
  platformMetadata?: { traceId?: string };
}): string | undefined {
  return payload?.traceId || payload?.platformMetadata?.traceId;
}
