/**
 * Rate Limiting Module
 *
 * In-memory sliding window counter algorithm.
 * O(1) space per key — stores only prev_count, curr_count, and window_start.
 *
 * Replaces the PostgreSQL `check_rate_limit()` stored procedure.
 */

interface RateLimitConfig {
  /** Maximum number of requests allowed in the window */
  limit: number;
  /** Time window in seconds */
  windowSeconds: number;
  /** Optional custom error message */
  errorMessage?: string;
}

interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Current interpolated count of requests in the window */
  count: number;
  /** Maximum requests allowed */
  limit: number;
  /** Seconds until the rate limit resets */
  resetInSeconds: number;
  /** Error message if rate limit exceeded */
  errorMessage?: string;
}

interface WindowState {
  prevCount: number;
  currCount: number;
  windowStart: number; // epoch seconds
}

/**
 * In-memory Rate Limiter using sliding window counter.
 *
 * Same algorithm as the old PostgreSQL `check_rate_limit()`:
 * - Maintains prev_count and curr_count per key
 * - Interpolates between windows for smooth limiting
 * - Periodic cleanup of stale entries
 */
class RateLimiter {
  private windows = new Map<string, WindowState>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Clean up stale entries every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60_000);
    // Allow Node to exit even if timer is active
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Check if a request is within rate limit.
   * Uses in-memory sliding window counter (same algorithm as the old PG stored proc).
   *
   * Concurrency safety: This method is synchronous (no awaits), so it runs to
   * completion in a single microtask. In single-threaded Node.js, concurrent
   * callers cannot interleave between the read and write of the window state.
   */
  checkLimit(key: string, config: RateLimitConfig): RateLimitResult {
    const now = Math.floor(Date.now() / 1000);
    const currentWindow = now - (now % config.windowSeconds);

    let state = this.windows.get(key);

    if (!state) {
      // First request for this key
      state = { prevCount: 0, currCount: 1, windowStart: currentWindow };
      this.windows.set(key, state);
    } else {
      // Update window state
      if (currentWindow > state.windowStart + config.windowSeconds) {
        // More than 1 window passed, reset prev
        state.prevCount = 0;
        state.currCount = 1;
        state.windowStart = currentWindow;
      } else if (currentWindow > state.windowStart) {
        // Window rolled over, curr becomes prev
        state.prevCount = state.currCount;
        state.currCount = 1;
        state.windowStart = currentWindow;
      } else {
        // Same window, increment
        state.currCount++;
      }
    }

    // Calculate elapsed time in current window
    const elapsed = now - state.windowStart;

    // Interpolate: weight previous window by remaining time
    const effectiveCount =
      state.prevCount * Math.max(0, (config.windowSeconds - elapsed) / config.windowSeconds) +
      state.currCount;

    const allowed = effectiveCount <= config.limit;
    const resetInSeconds = Math.max(0, config.windowSeconds - elapsed);

    return {
      allowed,
      count: Math.ceil(effectiveCount),
      limit: config.limit,
      resetInSeconds,
      errorMessage: allowed
        ? undefined
        : config.errorMessage || `Rate limit exceeded. Try again in ${resetInSeconds} seconds.`,
    };
  }

  /**
   * Cleanup stale rate limit entries (default: older than 24h).
   */
  cleanup(maxAgeSeconds: number = 86400): number {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
    let deleted = 0;

    for (const [key, state] of this.windows) {
      if (state.windowStart < cutoff) {
        this.windows.delete(key);
        deleted++;
      }
    }

    return deleted;
  }

  /** Stop the cleanup timer (for graceful shutdown). */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

/**
 * Predefined rate limit configurations (only those actively used)
 */
export const RateLimitPresets = {
  /** API requests per IP: 60/minute */
  API_PER_IP_MINUTE: {
    limit: 60,
    windowSeconds: 60,
    errorMessage: 'API rate limit exceeded. Maximum 60 requests per minute.',
  } as RateLimitConfig,

  /** Discovery: 5/hour per IP (expensive operation) */
  DISCOVERY_PER_IP_HOUR: {
    limit: 5,
    windowSeconds: 3600,
    errorMessage: 'Discovery rate limit exceeded. Maximum 5 discoveries per hour.',
  } as RateLimitConfig,

  /** OAuth client registration: 10/hour per IP */
  OAUTH_REGISTER_PER_IP_HOUR: {
    limit: 10,
    windowSeconds: 3600,
    errorMessage:
      'OAuth client registration rate limit exceeded. Maximum 10 registrations per hour.',
  } as RateLimitConfig,

  /** Invitation preview lookup: 5/minute per IP (unauthenticated) */
  INVITATION_PREVIEW_PER_IP_MINUTE: {
    limit: 5,
    windowSeconds: 60,
    errorMessage: 'Too many invitation lookups. Try again shortly.',
  } as RateLimitConfig,

  /** Self-serve join public org: 10/hour per IP */
  JOIN_PUBLIC_ORG_PER_IP_HOUR: {
    limit: 10,
    windowSeconds: 3600,
    errorMessage: 'Join rate limit exceeded. Maximum 10 join attempts per hour.',
  } as RateLimitConfig,

  /** Public template-agent install: 20/hour per user */
  INSTALL_AGENT_PER_USER_HOUR: {
    limit: 20,
    windowSeconds: 3600,
    errorMessage: 'Install rate limit exceeded. Maximum 20 installs per hour.',
  } as RateLimitConfig,
};

/** Module-level singleton rate limiter. */
let _rateLimiter: RateLimiter | null = null;

/** Get the shared in-memory rate limiter instance. */
export function getRateLimiter(): RateLimiter {
  if (!_rateLimiter) {
    _rateLimiter = new RateLimiter();
  }
  return _rateLimiter;
}

/**
 * Get client IP from request
 */
export function getClientIP(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0] ||
    request.headers.get('X-Real-IP') ||
    'unknown'
  );
}
