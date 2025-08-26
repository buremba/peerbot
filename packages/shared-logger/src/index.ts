import winston from 'winston';

interface LoggerConfig {
  service: string;
  useBundled?: boolean;
}

function createLogger(config: LoggerConfig) {
  if (config.useBundled) {
    // Simple console-based logger for bundled environments
    const logMethods = {
      error: (message: any, ...args: any[]) => {
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
        console.error(`[${timestamp}] [error] ${message}`, ...args);
      },
      warn: (message: any, ...args: any[]) => {
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
        console.warn(`[${timestamp}] [warn] ${message}`, ...args);
      },
      info: (message: any, ...args: any[]) => {
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
        console.log(`[${timestamp}] [info] ${message}`, ...args);
      },
      debug: (message: any, ...args: any[]) => {
        if (process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'DEBUG') {
          const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
          console.log(`[${timestamp}] [debug] ${message}`, ...args);
        }
      }
    };
    return logMethods;
  }

  // Winston-based logger for standard environments
  const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.splat()
    ),
    defaultMeta: { service: config.service },
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            let metaStr = '';
            if (Object.keys(meta).length) {
              try {
                metaStr = ` ${JSON.stringify(meta, null, 0)}`;
              } catch (err) {
                // Handle circular structures by using a replacer function
                metaStr = ` ${JSON.stringify(meta, (_, value) => {
                  if (typeof value === 'object' && value !== null) {
                    if (value instanceof Error) {
                      return {
                        name: value.name,
                        message: value.message,
                        stack: value.stack?.split('\n')[0] // Only first line of stack
                      };
                    }
                  }
                  return value;
                })}`;
              }
            }
            return `[${timestamp}] [${level}] ${message}${metaStr}`;
          })
        )
      })
    ]
  });

  return logger;
}

export { createLogger };
export type { LoggerConfig };