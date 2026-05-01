import pino from 'pino';

/**
 * SDK logger instance
 * Uses its own pino instance, separate from the main app logger
 */
export const sdkLogger = pino({
  name: 'connector-sdk',
  level: process.env.LOG_LEVEL || 'info',
});
