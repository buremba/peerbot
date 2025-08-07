import winston from 'winston';

// Create a simple console transport that always works
const consoleTransport = new winston.transports.Console({
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `[${timestamp}] [${level}] ${message}${metaStr}`;
    })
  )
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.splat()
  ),
  defaultMeta: { service: 'dispatcher' },
  transports: [consoleTransport],
  // Force immediate output
  exitOnError: false
});

// Ensure logger methods work in bundled environment by adding console.log fallback
const logMethods = {
  error: (...args: any[]) => {
    console.error('[dispatcher]', ...args);
    try {
      logger.error(...args);
    } catch (e) {
      // Fallback if Winston fails
    }
  },
  warn: (...args: any[]) => {
    console.warn('[dispatcher]', ...args);
    try {
      logger.warn(...args);
    } catch (e) {
      // Fallback if Winston fails
    }
  },
  info: (...args: any[]) => {
    console.log('[dispatcher]', ...args);
    try {
      logger.info(...args);
    } catch (e) {
      // Fallback if Winston fails
    }
  },
  debug: (...args: any[]) => {
    if (process.env.LOG_LEVEL === 'debug') {
      console.log('[dispatcher] [debug]', ...args);
    }
    try {
      logger.debug(...args);
    } catch (e) {
      // Fallback if Winston fails
    }
  }
};

export default logMethods;