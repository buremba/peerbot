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
});

export default logger;
