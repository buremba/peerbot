import * as Sentry from '@sentry/node';
import pino from 'pino';

/**
 * Logger utility using Pino for structured logging
 *
 * Log Levels:
 * - trace (10): Very detailed debugging
 * - debug (20): Debugging information
 * - info (30): Informational messages (default in production)
 * - warn (40): Warning messages
 * - error (50): Error messages
 * - fatal (60): Fatal errors
 */

// Determine log level from environment
const getLogLevel = (): pino.Level => {
  const env = (globalThis as any).ENVIRONMENT || 'development';

  if (env === 'production') {
    return 'info';
  }
  return 'debug';
};

// pino's default error serializer only fires for the `err` key, so
// `logger.error({ error }, '...')` silently logs `error: {}` (Error's own
// fields are non-enumerable). Register the same serializer on the `error`
// key too so either spelling produces a real stack/message. Found during
// the 2026-05-16 prod outage where every queue failure logged `error: {}`
// and hid `column "events.search_tsv" does not exist`.
const errSerializer = pino.stdSerializers.err;

/**
 * Sentry forwarding for logger.error() and logger.fatal().
 *
 * Prior to this hook, `logger.error(...)` only wrote to stdout. The Sentry
 * capture middleware in server.ts:85-113 only fires on HTTP 500 responses,
 * so error-logged failures inside background jobs (CheckDueFeeds, runs
 * queue, scheduled tasks) were invisible to monitoring. The 2026-05-16
 * audit found ~1914 errors / 5 min in stdout with zero Sentry issues.
 *
 * In-process dedupe: repeating errors are common (e.g. an orphan feed
 * fails every 1-min CheckDueFeeds tick). We fingerprint by
 * (msg, err.type, top stack frame) and only forward once per
 * SENTRY_DEDUPE_WINDOW_MS per fingerprint. Sentry has its own grouping
 * but every captureException still incurs an HTTP call + cost; this
 * cuts the load without losing signal.
 */
const SENTRY_DEDUPE_WINDOW_MS = 60_000;
const SENTRY_DEDUPE_MAX_ENTRIES = 1000;
const sentryDedupe: Map<string, number> = new Map();

/**
 * True when a pino-serialized error represents an expected client fault that
 * should NOT be forwarded to Sentry: a `ToolUserError`, or anything carrying a
 * 4xx `httpStatus` (bad input, not-found, permission denied, conflict). These
 * are already returned to the caller as a 4xx and are not operational alerts.
 * Exported for direct unit testing (the integration suite runs with
 * `isolate: false`, so module-level mocking of this path is unreliable).
 */
export function isExpectedClientFaultLog(
  errObj: { type?: string; httpStatus?: number } | undefined
): boolean {
  if (!errObj) return false;
  if (errObj.type === 'ToolUserError') return true;
  const status = errObj.httpStatus;
  return typeof status === 'number' && status >= 400 && status < 500;
}

function fingerprintAndCapture(parsed: Record<string, unknown>): void {
  const level = parsed.level;
  if (level !== 'error' && level !== 'fatal') return;

  // Caller already captured this to Sentry (see server.ts onError +
  // 500-response middleware). Skip to avoid duplicate events.
  if (parsed.sentryReported === true) return;

  const msg = typeof parsed.msg === 'string' ? parsed.msg : 'logger.error';
  // pino.stdSerializers.err normalises both `err` and `error` (see serializers
  // config below) to objects with `type` / `message` / `stack` (plus any own
  // enumerable fields such as ToolUserError's `httpStatus`).
  const errObj =
    (parsed.err as
      | { type?: string; message?: string; stack?: string; httpStatus?: number }
      | undefined) ??
    (parsed.error as
      | { type?: string; message?: string; stack?: string; httpStatus?: number }
      | undefined);

  // Expected client-fault outcomes (ToolUserError and anything carrying a 4xx
  // httpStatus — bad input, not-found, permission denied, conflict) are already
  // returned to the caller as a 4xx response; they are NOT operational alerts.
  // `trackMCPToolCall` / `captureServerError` already skip them at the
  // captureException layer, but a handler that *logs* the error (e.g.
  // `routeAction`'s catch) still reaches this pino bridge. Skip here too so the
  // three capture paths stay consistent and the alert feed stays clean.
  if (isExpectedClientFaultLog(errObj)) return;

  // Include err.message in the fingerprint — pre-fix, "(msg, err.type,
  // top stack frame)" grouped distinct errors raised from the same
  // catch site (same Error type, same wrapping log line). One legit
  // incident could be masked by a noisy unrelated one within the 60s
  // window. err.message disambiguates them.
  const errType = errObj?.type ?? '';
  const errMessage = errObj?.message ?? '';
  const stackTop = (errObj?.stack ?? '').split('\n')[1]?.trim() ?? '';
  const fingerprint = `${msg}|${errType}|${errMessage}|${stackTop}`;

  const now = Date.now();
  const last = sentryDedupe.get(fingerprint);
  if (last !== undefined && now - last < SENTRY_DEDUPE_WINDOW_MS) return;
  sentryDedupe.set(fingerprint, now);

  // Bound the dedupe map so a long-running pod doesn't grow it without limit.
  if (sentryDedupe.size > SENTRY_DEDUPE_MAX_ENTRIES) {
    const oldest = sentryDedupe.keys().next().value;
    if (oldest !== undefined) sentryDedupe.delete(oldest);
  }

  try {
    if (errObj?.message) {
      // Reconstruct an Error so Sentry's grouping works on the stack.
      const reconstructed = new Error(errObj.message);
      if (errObj.stack) reconstructed.stack = errObj.stack;
      Sentry.captureException(reconstructed, {
        extra: parsed,
        tags: { source: 'pino', level: String(level) },
      });
    } else {
      Sentry.captureMessage(msg, {
        level: level === 'fatal' ? 'fatal' : 'error',
        extra: parsed,
        tags: { source: 'pino' },
      });
    }
  } catch {
    // Sentry not initialised (test envs) or transient SDK failure — never
    // crash the logger over telemetry.
  }
}

/**
 * pino destination that mirrors lines to stdout AND inspects each line for
 * Sentry forwarding. Sync write is intentional: pino's default stdout path
 * is sync too, and the JSON.parse + dedupe lookup is sub-microsecond.
 */
const sentryAwareStream: pino.DestinationStream = {
  write(line: string): void {
    process.stdout.write(line);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (parsed && typeof parsed === 'object') {
      fingerprintAndCapture(parsed as Record<string, unknown>);
    }
  },
};

const logger = pino(
  {
    level: getLogLevel(),
    browser: {
      asObject: false,
    },
    formatters: {
      level: (label) => {
        return { level: label };
      },
    },
    serializers: {
      err: errSerializer,
      error: errSerializer,
    },
  },
  sentryAwareStream
);

export default logger;
