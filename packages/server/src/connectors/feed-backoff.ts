/**
 * Failure backoff + hard auto-pause policy for scheduled connector feeds.
 *
 * A feed that keeps failing (device offline, revoked auth, connector bug) used
 * to re-enqueue every plain cron cadence: the reschedule path and the
 * claim-timeout reaper both stamped `next_run_at = nextRunAtFromCron(...)`
 * regardless of `consecutive_failures`. On a 5-minute feed that is a failing
 * run every 5 minutes, forever — hammering the connector, the worker lane, and
 * (for GitHub etc.) the upstream API rate limit.
 *
 * This module centralises two policies so the reschedule path (run-lifecycle.ts)
 * and the claim-timeout reaper (check-stalled-executions.ts) apply the SAME math:
 *
 *  1. Exponential backoff on `next_run_at` after a failure, so a failing feed
 *     retries progressively less often instead of every cadence.
 *  2. A hard consecutive-failure threshold that pauses the feed outright and
 *     emits a `feed.auto_paused` Behavior signal so orgs can react with a
 *     normal Behavior (see behaviors/platform-events.ts).
 *
 * All timings are env-overridable for tests/operators via lazy getters (same
 * convention as config/intervals.ts).
 */

/** Positive number from env (rounded to int); falls back when unset/invalid. */
function parseEnvInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : fallback;
}

export const feedBackoff = {
  /** Base backoff delay applied after the first failure (doubles each
   *  subsequent consecutive failure). 60s keeps a single transient blip cheap
   *  while still spacing out a genuinely broken feed. */
  get baseMs(): number {
    return parseEnvInt('FEED_BACKOFF_BASE_MS', 60_000);
  },

  /** Cap on the exponential backoff. 6h means a chronically-failing feed still
   *  retries a few times a day (in case the upstream recovers) but never sits
   *  on the plain cadence. */
  get maxMs(): number {
    return parseEnvInt('FEED_BACKOFF_MAX_MS', 6 * 60 * 60 * 1000);
  },

  /** Consecutive-failure count at which a feed is hard-paused
   *  (`status='paused'`, `next_run_at=NULL`) and `feed.auto_paused` is emitted.
   *  20 failures is deliberately conservative: at the capped 6h backoff that is
   *  several days of a feed being down before we stop scheduling it entirely,
   *  so a feed is never paused for a transient outage. Operators can lower it
   *  via env if they want to give up sooner. */
  get pauseThreshold(): number {
    return parseEnvInt('FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES', 20);
  },
};

/**
 * Exponential backoff delay (ms) for a feed with `consecutiveFailures` failures
 * (the count INCLUDING the failure that just happened, i.e. >= 1). Returns 0
 * for a healthy feed (0 failures) so the caller keeps the plain cron cadence.
 *
 * delay = min(baseMs * 2^(failures-1), maxMs)
 */
export function feedBackoffDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  // Guard the shift so a huge failure count can't overflow to a tiny/negative
  // value — anything past the cap is clamped anyway.
  const exponent = Math.min(consecutiveFailures - 1, 30);
  const delay = feedBackoff.baseMs * 2 ** exponent;
  return Math.min(delay, feedBackoff.maxMs);
}

/**
 * Whether a feed with `consecutiveFailures` failures has crossed the hard
 * auto-pause threshold and should be paused (`status='paused'`,
 * `next_run_at=NULL`).
 */
export function shouldHardPauseFeed(consecutiveFailures: number): boolean {
  return consecutiveFailures >= feedBackoff.pauseThreshold;
}
