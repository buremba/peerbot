import { getDb } from "../../db/client.js";

interface FixedWindowRateLimitOptions {
  key: string;
  limit: number;
  windowSeconds: number;
}

interface FixedWindowRateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: number;
}

/**
 * Fixed-window rate limiter backed by `public.rate_limits`.
 *
 * Each row is `(key, count, window_started_at, expires_at)` — one row per
 * key. consume() does an upsert that:
 *   - inserts (count=1, window_started_at=now, expires_at=now+windowSeconds)
 *     when no row exists,
 *   - resets the row when the existing window has already expired,
 *   - bumps `count` when the window is still live.
 *
 * Same fixed-window-counter semantics as a typical INCR + EXPIRE loop.
 */
export class FixedWindowRateLimiter {
  async consume(
    options: FixedWindowRateLimitOptions
  ): Promise<FixedWindowRateLimitResult> {
    const sql = getDb();
    const windowSeconds = options.windowSeconds;
    const intervalMs = windowSeconds * 1000;

    // ON CONFLICT: if the row's window already expired, reset count and
    // window markers; otherwise bump count by 1. The CASE expression keeps
    // this atomic in a single statement.
    const rows = await sql`
      INSERT INTO rate_limits (key, count, window_started_at, expires_at, updated_at)
      VALUES (
        ${options.key},
        1,
        now(),
        now() + (${intervalMs} || ' milliseconds')::interval,
        now()
      )
      ON CONFLICT (key) DO UPDATE SET
        count = CASE
          WHEN rate_limits.expires_at <= now() THEN 1
          ELSE rate_limits.count + 1
        END,
        window_started_at = CASE
          WHEN rate_limits.expires_at <= now() THEN now()
          ELSE rate_limits.window_started_at
        END,
        expires_at = CASE
          WHEN rate_limits.expires_at <= now()
            THEN now() + (${intervalMs} || ' milliseconds')::interval
          ELSE rate_limits.expires_at
        END,
        updated_at = now()
      RETURNING count, expires_at
    `;

    const row = rows[0] as { count: number; expires_at: Date | string };
    const expiresAt =
      row.expires_at instanceof Date
        ? row.expires_at.getTime()
        : Date.parse(String(row.expires_at));
    const ttlSeconds = Math.max(
      1,
      Math.ceil((expiresAt - Date.now()) / 1000)
    );
    return this.buildResult(options, row.count, ttlSeconds, expiresAt);
  }

  async reset(key: string): Promise<void> {
    const sql = getDb();
    await sql`DELETE FROM rate_limits WHERE key = ${key}`;
  }

  private buildResult(
    options: FixedWindowRateLimitOptions,
    count: number,
    ttlSeconds: number,
    expiresAtMs: number
  ): FixedWindowRateLimitResult {
    return {
      allowed: count <= options.limit,
      count,
      limit: options.limit,
      remaining: Math.max(0, options.limit - count),
      retryAfterSeconds: Math.max(1, ttlSeconds),
      resetAt: expiresAtMs,
    };
  }
}

export function getClientIp(headers: {
  forwardedFor?: string;
  realIp?: string;
}): string {
  const forwarded = headers.forwardedFor?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) {
    return forwarded;
  }

  const realIp = headers.realIp?.trim().toLowerCase();
  if (realIp) {
    return realIp;
  }

  return "unknown";
}

/**
 * Sweep expired rate_limits rows. Safe to call periodically.
 */
export async function sweepExpiredRateLimits(): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    WITH deleted AS (
      DELETE FROM rate_limits WHERE expires_at <= now() RETURNING key
    )
    SELECT count(*)::int AS count FROM deleted
  `;
  return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
}
