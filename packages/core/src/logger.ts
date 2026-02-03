// Use simple console.log-based logger by default (unbuffered, 12-factor compliant)
// Set USE_WINSTON_LOGGER=true only if you need Winston features (file rotation, multiple transports)
const USE_WINSTON_LOGGER = process.env.USE_WINSTON_LOGGER === "true";
// Use JSON format for structured logging (better for Loki parsing in production)
const USE_JSON_FORMAT = process.env.LOG_FORMAT === "json";

import winston from "winston";
import { getSentry } from "./sentry";

export interface Logger {
  error: (message: any, ...args: any[]) => void;
  warn: (message: any, ...args: any[]) => void;
  info: (message: any, ...args: any[]) => void;
  debug: (message: any, ...args: any[]) => void;
}

// Simple console logger fallback for environments where Winston doesn't work (Bun + Alpine)
// Supports both formats: logger.info("message", data) AND pino-style logger.info({ data }, "message")
function createConsoleLogger(serviceName: string): Logger {
  const level = process.env.LOG_LEVEL || "info";
  const levels: Record<string, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  };
  const currentLevel = levels[level] ?? 2;

  const formatMessage = (lvl: string, message: any, ...args: any[]): string => {
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    let msgStr: string;
    let meta: any = null;

    // Handle pino-style format: logger.info({ key: value }, "message")
    if (
      typeof message === "object" &&
      message !== null &&
      !Array.isArray(message) &&
      !(message instanceof Error)
    ) {
      if (args.length > 0 && typeof args[0] === "string") {
        // First arg is metadata object, second arg is the actual message
        msgStr = args[0];
        meta = message;
        args = args.slice(1);
      } else {
        // Just an object, stringify it
        try {
          msgStr = JSON.stringify(message);
        } catch {
          msgStr = "[object]";
        }
      }
    } else {
      msgStr = String(message);
    }

    // Append remaining args
    if (args.length > 0) {
      try {
        msgStr += ` ${JSON.stringify(args.length === 1 ? args[0] : args)}`;
      } catch {
        msgStr += " [unserializable]";
      }
    }

    // Append metadata object
    if (meta) {
      try {
        msgStr += ` ${JSON.stringify(meta)}`;
      } catch {
        msgStr += " [meta unserializable]";
      }
    }

    return `[${timestamp}] [${lvl}] [${serviceName}] ${msgStr}`;
  };

  return {
    error: (message: any, ...args: any[]) => {
      if (currentLevel >= 0)
        console.error(formatMessage("error", message, ...args));
    },
    warn: (message: any, ...args: any[]) => {
      if (currentLevel >= 1)
        console.warn(formatMessage("warn", message, ...args));
    },
    info: (message: any, ...args: any[]) => {
      if (currentLevel >= 2)
        console.log(formatMessage("info", message, ...args));
    },
    debug: (message: any, ...args: any[]) => {
      if (currentLevel >= 3)
        console.log(formatMessage("debug", message, ...args));
    },
  };
}

/**
 * Custom Winston transport that sends errors to Sentry
 */
class SentryTransport extends winston.transports.Stream {
  constructor() {
    super({ stream: process.stdout });
  }

  log(info: any, callback: () => void) {
    setImmediate(() => {
      this.emit("logged", info);
    });

    // Only send errors and warnings to Sentry
    if (info.level === "error" || info.level === "warn") {
      const Sentry = getSentry();
      if (Sentry) {
        try {
          // Extract error object if present
          const errorObj =
            info.error || (info.message instanceof Error ? info.message : null);

          if (errorObj instanceof Error) {
            Sentry.captureException(errorObj, {
              level: info.level === "error" ? "error" : "warning",
              tags: {
                service: info.service,
              },
              extra: {
                ...info,
                message: info.message,
              },
            });
          } else {
            // Send as message if no Error object
            Sentry.captureMessage(String(info.message), {
              level: info.level === "error" ? "error" : "warning",
              tags: {
                service: info.service,
              },
              extra: info,
            });
          }
        } catch (_err) {
          // Ignore Sentry errors to avoid breaking logging
        }
      }
    }

    callback();
  }
}

/**
 * Creates a logger instance for a specific service
 * Provides consistent logging format across all packages with level and timestamp
 * @param serviceName The name of the service using the logger
 * @returns A console logger by default, or Winston logger if USE_WINSTON_LOGGER=true
 */
export function createLogger(serviceName: string): Logger {
  // Use simple console.log logger by default (unbuffered, 12-factor compliant)
  // Set USE_WINSTON_LOGGER=true for Winston features (file rotation, multiple transports)
  if (!USE_WINSTON_LOGGER) {
    return createConsoleLogger(serviceName);
  }

  const isProduction = process.env.NODE_ENV === "production";
  const level = process.env.LOG_LEVEL || "info";

  // JSON format for structured logging (better for Loki/Grafana parsing)
  const jsonFormat = winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
    winston.format.json()
  );

  // Human-readable format for development
  const humanFormat = winston.format.combine(
    ...(isProduction ? [] : [winston.format.colorize()]),
    winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
      let metaStr = "";
      if (Object.keys(meta).length) {
        try {
          metaStr = ` ${JSON.stringify(meta, null, 0)}`;
        } catch (_err) {
          // Handle circular structures with a safer approach
          try {
            const seen = new WeakSet();
            metaStr = ` ${JSON.stringify(meta, (_key, value) => {
              if (typeof value === "object" && value !== null) {
                if (seen.has(value)) {
                  return "[Circular Reference]";
                }
                seen.add(value);

                if (value instanceof Error) {
                  return {
                    name: value.name,
                    message: value.message,
                    stack: value.stack?.split("\n")[0], // Only first line of stack
                  };
                }
              }
              return value;
            })}`;
          } catch (_err2) {
            // Final fallback if even the circular handler fails
            metaStr = " [Object too complex to serialize]";
          }
        }
      }
      return `[${timestamp}] [${level}] [${service}] ${message}${metaStr}`;
    })
  );

  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: USE_JSON_FORMAT ? jsonFormat : humanFormat,
    }),
  ];

  const logger = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      winston.format.errors({ stack: true }),
      winston.format.splat()
    ),
    defaultMeta: { service: serviceName },
    transports,
  });

  // Add Sentry transport in production or if SENTRY_DSN is set
  // Deferred to avoid circular dependency with sentry.ts
  // The check is inside setImmediate to ensure SentryTransport class is fully initialized
  setImmediate(() => {
    if (isProduction || process.env.SENTRY_DSN) {
      try {
        const transport = new SentryTransport();
        logger.add(transport);
      } catch {
        // Ignore errors during Sentry transport setup
      }
    }
  });

  return logger;
}

// Default logger instance for backward compatibility
export const logger = createLogger("shared");
