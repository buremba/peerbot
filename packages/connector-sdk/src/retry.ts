/**
 * HTTP retry helper for connector SDK.
 *
 * Exponential backoff with full jitter (5 retries, 1s → 16s), retry on
 * transient network/rate-limit/server errors, abort on permanent client errors
 * (401/403/404/etc.).
 *
 * The backoff loop lives here rather than being imported from `@lobu/core`:
 * core's root entry drags winston, Sentry and OpenTelemetry into every
 * connector bundle, and the package root must stay loadable inside a V8
 * isolate. It keeps the semantics of core's `retryWithBackoff` for the one
 * configuration `withHttpRetry` uses: exponential, capped, full jitter.
 */

import { sdkLogger } from './logger.js';

interface BackoffOptions {
  maxRetries: number;
  baseDelay: number;
  /** Cap on the computed delay, applied before jitter. */
  maxDelay: number;
  shouldRetry: (error: Error) => boolean;
  onRetry: (attempt: number, error: Error) => void;
}

async function retryWithBackoff<T>(fn: () => Promise<T>, options: BackoffOptions): Promise<T> {
  const { maxRetries, baseDelay, maxDelay, shouldRetry, onRetry } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (!shouldRetry(lastError)) throw lastError;

      if (attempt < maxRetries) {
        // Full jitter: the capped exponential delay multiplied by [1, 2).
        const delay = Math.min(baseDelay * 2 ** attempt, maxDelay) * (1 + Math.random());

        // A throwing caller callback must not swallow the retry.
        try {
          onRetry(attempt + 1, lastError);
        } catch (callbackError) {
          sdkLogger.warn('onRetry callback threw', {
            error: callbackError instanceof Error ? callbackError.message : String(callbackError),
          });
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

const TRANSIENT_KEYWORDS = [
  // network
  'network',
  'econnrefused',
  'etimedout',
  'enotfound',
  'econnreset',
  'fetch failed',
  'socket',
  'dns',
  // database
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
  // rate limit
  'rate limit',
  '429',
  'too many requests',
  // server
  '500',
  '502',
  '503',
  '504',
  'server error',
  'service unavailable',
  'gateway timeout',
];

const PERMANENT_KEYWORDS = [
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

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
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
 * - 1s, 2s, 4s, 8s, 16s base delays (with multiplicative jitter)
 */
export async function withHttpRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const operation = options?.operation || 'HTTP operation';
  const totalRetries = 5;

  return retryWithBackoff(fn, {
    maxRetries: totalRetries,
    baseDelay: 1000,
    maxDelay: 16000,
    shouldRetry: (error) => {
      const msg = errorMessage(error);
      if (PERMANENT_KEYWORDS.some((k) => msg.includes(k))) return false;
      return TRANSIENT_KEYWORDS.some((k) => msg.includes(k));
    },
    onRetry: (attempt, error) => {
      options?.onRetry?.(error, attempt);
      sdkLogger.debug(
        {
          operation,
          attempt,
          retriesLeft: totalRetries - attempt,
          error: error.message || String(error),
          context: options?.context,
        },
        `[Retry:HTTP] Attempt ${attempt} failed, ${totalRetries - attempt} retries left`
      );
    },
  });
}
