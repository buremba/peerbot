/**
 * HTTP retry helper for connector SDK.
 *
 * HTTP-aware retry semantics on top of a generic exponential backoff: full
 * jitter (5 retries, 1s → 16s), retry on transient network/rate-limit/server
 * errors, abort on permanent client errors (401/403/404/etc.).
 *
 * The backoff is implemented here rather than imported from `@lobu/core`:
 * core's root entry drags winston, Sentry and OpenTelemetry into every
 * connector bundle, and the package root must stay loadable inside a V8
 * isolate. It mirrors `@lobu/core`'s `retryWithBackoff` semantics exactly.
 */

import { sdkLogger } from './logger.js';

interface BackoffOptions {
  maxRetries?: number;
  baseDelay?: number;
  /** Maximum delay between retries (caps the computed delay before jitter). */
  maxDelay?: number;
  strategy?: 'exponential' | 'linear';
  /** `false`: none; `true`: additive 0–1000ms; `'full'`: multiply by [1, 2). */
  jitter?: boolean | 'full';
  shouldRetry?: (error: Error, attempt: number) => boolean;
  onRetry?: (attempt: number, error: Error) => void;
}

async function retryWithBackoff<T>(fn: () => Promise<T>, options: BackoffOptions = {}): Promise<T> {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay,
    strategy = 'exponential',
    jitter = false,
    shouldRetry,
    onRetry,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // A buggy predicate that throws must not mask the real error or skip
      // remaining retries — log and fall back to the default (retry).
      if (shouldRetry) {
        let allowRetry = true;
        try {
          allowRetry = shouldRetry(lastError, attempt + 1);
        } catch (predicateError) {
          sdkLogger.warn('shouldRetry predicate threw; defaulting to retry', {
            error: predicateError instanceof Error ? predicateError.message : String(predicateError),
          });
        }
        if (!allowRetry) throw lastError;
      }

      if (attempt < maxRetries) {
        let delay = strategy === 'exponential' ? baseDelay * 2 ** attempt : baseDelay * (attempt + 1);
        if (maxDelay !== undefined) delay = Math.min(delay, maxDelay);

        let finalDelay: number;
        if (jitter === 'full') {
          finalDelay = delay * (1 + Math.random());
        } else if (jitter === true) {
          finalDelay = delay + Math.random() * 1000;
        } else {
          finalDelay = delay;
        }

        if (onRetry) {
          try {
            onRetry(attempt + 1, lastError);
          } catch (callbackError) {
            sdkLogger.warn('onRetry callback threw', {
              error: callbackError instanceof Error ? callbackError.message : String(callbackError),
            });
          }
        } else {
          sdkLogger.warn(`Retry attempt ${attempt + 1}/${maxRetries} after ${Math.round(finalDelay)}ms`, {
            error: lastError.message,
          });
        }

        await new Promise((resolve) => setTimeout(resolve, finalDelay));
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
    strategy: 'exponential',
    jitter: 'full',
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
