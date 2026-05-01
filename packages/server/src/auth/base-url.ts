/**
 * Shared base URL resolution for auth module.
 *
 * Uses PUBLIC_WEB_URL as the canonical public origin, with LOBU_URL,
 * forwarded-header, and request-URL fallbacks for environments where it isn't set.
 */

import { getConfiguredPublicOrigin } from '../utils/public-origin';

/**
 * Parse a URL string and return the parsed URL object, or null on failure.
 */
export function safeParseUrl(value: string | undefined | null, base?: string): URL | null {
  if (!value) return null;
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

/**
 * Parse a URL string and return only its origin, or null on failure.
 */
export function safeOrigin(value: string | undefined | null): string | null {
  return safeParseUrl(value)?.origin ?? null;
}

interface ResolveBaseUrlOptions {
  /** Incoming request — used for forwarded headers and URL fallback. */
  request?: Request | null;
  /** Hono-style header accessor (alternative to a full Request). */
  header?: (name: string) => string | undefined;
  /** Hono-style request URL string (alternative to request.url). */
  url?: string;
  /** Fallback when nothing else resolves. Defaults to `http://localhost:8787`. */
  fallback?: string;
  /** Skip PUBLIC_WEB_URL / LOBU_URL env override — use the actual serving domain. */
  skipEnvOverride?: boolean;
}

/**
 * Resolve the public-facing base URL (origin) for the API.
 *
 * Resolution order:
 * 1. `PUBLIC_WEB_URL` environment variable
 * 2. `LOBU_URL` environment variable
 * 3. `x-forwarded-proto` + (`x-forwarded-host` || `host`) headers
 * 4. The request/URL origin
 * 5. The provided fallback (default: `http://localhost:8787`)
 */
export function resolveBaseUrl(options: ResolveBaseUrlOptions = {}): string {
  const { request, fallback = 'http://localhost:8787' } = options;

  // Helper to read a header from either a Request or a Hono-style accessor.
  const getHeader = (name: string): string | undefined => {
    if (options.header) return options.header(name);
    return request?.headers.get(name) ?? undefined;
  };

  // 1. PUBLIC_WEB_URL / LOBU_URL from environment
  if (!options.skipEnvOverride) {
    const fromEnv = getConfiguredPublicOrigin();
    if (fromEnv) return fromEnv;
  }

  // 2. Reverse-proxy forwarded headers
  const proto = getHeader('x-forwarded-proto');
  const host = getHeader('x-forwarded-host') || getHeader('host');
  if (proto && host) {
    const forwarded = safeOrigin(`${proto}://${host}`);
    if (forwarded) return forwarded;
  }

  // 3. Request URL origin
  const requestUrl = options.url ?? request?.url;
  const fromRequest = safeOrigin(requestUrl);
  if (fromRequest) return fromRequest;

  // 4. Fallback
  return fallback;
}
