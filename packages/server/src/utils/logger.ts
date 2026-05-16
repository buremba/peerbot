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

/**
 * Create a Pino logger instance
 */
// pino's default error serializer only fires for the `err` key, so
// `logger.error({ error }, '...')` silently logs `error: {}` (Error's own
// fields are non-enumerable). Register the same serializer on the `error`
// key too so either spelling produces a real stack/message. Found during
// the 2026-05-16 prod outage where every queue failure logged `error: {}`
// and hid `column "events.search_tsv" does not exist`.
const errSerializer = pino.stdSerializers.err;

const logger = pino({
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
});

export default logger;
