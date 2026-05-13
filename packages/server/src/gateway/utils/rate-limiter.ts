import { getDb } from "../../db/client.js";

/**
 * Extract the client IP for rate-limit / abuse-tracking purposes from the
 * inbound proxy headers. Prefers the first hop in `x-forwarded-for`, falling
 * back to `x-real-ip`, and finally to a constant "unknown" sentinel so we
 * never key a rate-limit bucket on `null`.
 */
export function getClientIp(headers: {
  forwardedFor?: string;
  realIp?: string;
}): string {
  const forwarded = headers.forwardedFor?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded;

  const realIp = headers.realIp?.trim().toLowerCase();
  if (realIp) return realIp;

  return "unknown";
}

/**
 * Sweep expired `public.rate_limits` rows. Safe to call periodically.
 *
 * The `rate_limits` table is a fixed-window counter — one row per key, with
 * `(count, window_started_at, expires_at)`. This helper just drains stale rows
 * so the table doesn't grow unbounded.
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
