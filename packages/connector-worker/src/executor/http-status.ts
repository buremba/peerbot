/**
 * Extract a structured HTTP status from a connector-thrown error (lobu#2051 Item 2).
 *
 * Lives in its own side-effect-free module so tests can import it without
 * pulling in the executor. The connector SDK's
 * `HttpStatusError` sets a numeric `status`; carrying that number to the gateway
 * lets it classify 429/5xx honestly instead of keyword-matching the redacted
 * message string.
 */

/**
 * Pull a numeric HTTP status off a thrown error when the connector used the SDK's
 * `HttpStatusError` (or any error carrying a numeric `status`). Returns undefined
 * when there's no plausible status, so callers can omit the field entirely.
 */
export function extractHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && status >= 100 && status < 600 ? status : undefined;
}
