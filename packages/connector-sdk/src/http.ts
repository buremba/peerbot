import ky, { type KyInstance, type Options } from 'ky';

/**
 * Shared HTTP client configuration for all feeds
 */

/**
 * Default retry configuration
 * - Max 2 retries (3 total attempts)
 * - Only retry transient errors (429, 5xx)
 * - Exponential backoff up to 5 seconds
 * - 30s timeout per request
 */
const defaultRetryConfig = {
  retry: {
    limit: 2, // Max 2 retries (3 total attempts)
    methods: ['get', 'post'],
    statusCodes: [
      408, // Request Timeout
      429, // Too Many Requests (rate limit)
      500, // Internal Server Error
      502, // Bad Gateway
      503, // Service Unavailable
      504, // Gateway Timeout
    ],
    backoffLimit: 5000, // Max 5 seconds delay between retries
  },
  timeout: 30000, // 30 second timeout per request
};

/**
 * Create a configured ky instance with custom options
 */
export function createHttpClient(options?: Options): KyInstance {
  return ky.create({
    ...defaultRetryConfig,
    ...options,
    // Merge retry config if provided
    retry: options?.retry
      ? {
          ...defaultRetryConfig.retry,
          ...(typeof options.retry === 'number' ? { limit: options.retry } : options.retry),
        }
      : defaultRetryConfig.retry,
  });
}

/**
 * Default HTTP client for feeds with standard User-Agent
 */
export const httpClient = createHttpClient({
  headers: {
    'User-Agent': 'UserResearchBot/1.0',
  },
});

/**
 * Create an HTTP client with authentication headers
 */
export function createAuthenticatedClient(
  authHeader: string,
  additionalHeaders?: Record<string, string>
): KyInstance {
  return createHttpClient({
    headers: {
      'User-Agent': 'UserResearchBot/1.0',
      Authorization: authHeader,
      ...additionalHeaders,
    },
  });
}

/**
 * HTTP client for JSON APIs
 */
export const jsonHttpClient = createHttpClient({
  headers: {
    'User-Agent': 'UserResearchBot/1.0',
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});
