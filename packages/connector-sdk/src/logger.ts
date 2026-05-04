import { createLogger, type Logger } from '@lobu/core';

/**
 * SDK logger instance — uses the shared @lobu/core logger so connector-sdk
 * output participates in the same formatting, log-level, and Sentry routing
 * as the rest of the platform.
 */
export const sdkLogger: Logger = createLogger('connector-sdk');
