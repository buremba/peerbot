/**
 * Centralized retry utilities using p-retry
 *
 * Provides retry strategies for HTTP operations (external APIs).
 */

import pRetry, { AbortError } from 'p-retry';
import { sdkLogger } from './logger.js';

/**
 * Error detection helpers
 */

function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  const networkKeywords = [
    'network',
    'econnrefused',
    'etimedout',
    'enotfound',
    'econnreset',
    'fetch failed',
    'socket',
    'dns',
  ];

  return networkKeywords.some((keyword) => lowerMessage.includes(keyword));
}

function isDatabaseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  const databaseKeywords = [
    'connection pool',
    'too many connections',
    'connection limit',
    'connection reset',
    'connection refused',
    'server closed',
    'connection terminated',
    'connection timeout',
    'deadlock',
    'lock timeout',
    'query timeout',
    'statement timeout',
    'transaction',
    'postgres',
    'postgresql',
    'pg_',
    'relation does not exist',
    'syntax error',
  ];

  return databaseKeywords.some((keyword) => lowerMessage.includes(keyword));
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  return (
    lowerMessage.includes('rate limit') ||
    lowerMessage.includes('429') ||
    lowerMessage.includes('too many requests')
  );
}

function isServerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  const serverErrorCodes = ['500', '502', '503', '504'];
  const serverKeywords = ['server error', 'service unavailable', 'gateway timeout'];

  return (
    serverErrorCodes.some((code) => lowerMessage.includes(code)) ||
    serverKeywords.some((keyword) => lowerMessage.includes(keyword))
  );
}

function isRetryableError(error: unknown): boolean {
  return (
    isNetworkError(error) ||
    isDatabaseError(error) ||
    isRateLimitError(error) ||
    isServerError(error)
  );
}

function isPermanentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  const permanentKeywords = [
    'not found',
    '404',
    'unauthorized',
    '401',
    'forbidden',
    '403',
    'invalid',
    'bad request',
    '400',
  ];

  return permanentKeywords.some((keyword) => lowerMessage.includes(keyword));
}

interface RetryOptions {
  operation?: string;
  context?: Record<string, any>;
  onRetry?: (error: Error, attempt: number) => void;
}

/**
 * HTTP retry strategy
 * Exponential backoff with jitter for external API calls
 * - 5 retries
 * - 1s, 2s, 4s, 8s, 16s delays (with jitter)
 */
export async function withHttpRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  return pRetry(
    async (_attemptNumber) => {
      try {
        return await fn();
      } catch (error) {
        // Abort on permanent errors (404, 401, 403, etc.)
        if (isPermanentError(error)) {
          throw new AbortError(error instanceof Error ? error : new Error(String(error)));
        }

        // Retry on network, rate limit, or server errors
        if (!isRetryableError(error)) {
          throw new AbortError(error instanceof Error ? error : new Error(String(error)));
        }

        throw error;
      }
    },
    {
      retries: 5,
      factor: 2,
      minTimeout: 1000,
      maxTimeout: 16000,
      randomize: true,
      onFailedAttempt: (error) => {
        const underlyingError = error as any;
        if (options?.onRetry) {
          options.onRetry(underlyingError, error.attemptNumber);
        }

        sdkLogger.debug(
          {
            operation: options?.operation || 'HTTP operation',
            attempt: error.attemptNumber,
            retriesLeft: error.retriesLeft,
            error: underlyingError.message || String(underlyingError),
            context: options?.context,
          },
          `[Retry:HTTP] Attempt ${error.attemptNumber} failed, ${error.retriesLeft} retries left`
        );
      },
    }
  );
}
