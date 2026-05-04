/**
 * HTTP retry helper for connector SDK.
 *
 * Thin wrapper around `@lobu/core`'s generic `retryWithBackoff` that provides
 * HTTP-aware retry semantics: exponential backoff with full jitter (5 retries,
 * 1s → 16s), retry on transient network/rate-limit/server errors, abort on
 * permanent client errors (401/403/404/etc.).
 */

import { retryWithBackoff } from '@lobu/core';
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
      // Abort on permanent errors (404, 401, 403, etc.) or anything we don't
      // recognise as transient.
      if (isPermanentError(error)) return false;
      return isRetryableError(error);
    },
    onRetry: (attempt, error) => {
      if (options?.onRetry) {
        options.onRetry(error, attempt);
      }

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
