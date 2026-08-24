/**
 * Derived feed-health semantics.
 *
 * Execution mode and attention state are DERIVED from existing
 * feed/connection/device columns at read time — never stored. The stored
 * columns keep their historical meaning; this module only classifies.
 *
 * ## Why derive instead of store
 *
 * A feed's execution nature (`source_only` vs `streaming` vs `scheduled` vs
 * `no_schedule`) is a pure function of its declared operations and schedule. Its
 * attention state is a pure function of lifecycle/sync state, auth-profile
 * status, and device liveness. Storing these would duplicate state that already
 * lives on the row and drift when the source columns move (auto-pause, backoff,
 * resume). Read-time derivation is O(1) per feed and cannot diverge.
 *
 * ## The two outputs
 *
 * - `executionMode` — what the row says about how this feed runs:
 *   - `source_only` — a feed that supports direct reads but not sync.
 *   - `streaming` — a chat channel populated by incoming messages.
 *   - `scheduled` — a syncable feed with a cron in `feeds.schedule`.
 *   - `no_schedule` — a syncable feed with no cron. This says the feed has
 *     no cron and NOTHING MORE. It was called `manual` until 2026-08-12, which
 *     read an intent into it that the column does not carry: measured on prod
 *     that day, 196 of 215 active sync-capable feeds have no cron, and many are
 *     driven unattended through other dispatch paths (github `issue_comments` =
 *     4551 sync runs in 14 days with `schedule` and `next_run_at` both NULL).
 *     Do not reintroduce the intent reading under a new name.
 * - `attention` — what a human/UI should be told about the feed right now,
 *   ordered so the most actionable state wins:
 *   - `needs_auth` — the connection/auth profile is not usable (pending_auth,
 *     revoked, auth profile not active).
 *   - `paused` — operator- or auto-paused; not running until resumed.
 *   - `misconfigured` — the connection is in an error state.
 *   - `device_offline` — the feed is pinned to a device that has not polled
 *     within the liveness window.
 *   - `last_attempt_failed` — the most recent attempt failed (failing state,
 *     including backoff episodes).
 *   - `overdue` — a scheduled feed has had no active run for more than an hour
 *     past `next_run_at`.
 *   - `never_run` — never synced.
 *   - `healthy` — everything else.
 *
 * ## There is deliberately no `incidentEligible` here
 *
 * An earlier version derived one, defined as "an active SCHEDULED feed failing
 * for a platform-relevant reason". It rested on the cron inference above, and
 * nothing consumed it — `list_feeds` copied it into its output and no caller
 * ever read it, while the alerter that actually pages disagreed with it. "Is
 * this failure worth paging someone about" is a decision, not a property of a
 * row; it lives in `connectors/connector-health.ts`, the one place that acts on
 * it, alongside the prod measurements justifying its predicate. Do not
 * reintroduce a second copy here without a stored signal that distinguishes an
 * unattended event-driven feed from a human-triggered one.
 */

type FeedExecutionMode = "source_only" | "streaming" | "scheduled" | "no_schedule";

type FeedAttentionState =
  | "healthy"
  | "paused"
  | "needs_auth"
  | "last_attempt_failed"
  | "overdue"
  | "never_run"
  | "device_offline"
  | "misconfigured";

interface FeedHealthSemanticsInput {
  /** Operations derived from the selected connector feed handlers. */
  operations?: Array<'sync' | 'read'> | null;
  /** Storage plane. Channel feeds read transcripts rather than connector events. */
  store?: 'events' | 'channel_messages' | null;
  /** `feeds.status` — 'active' | 'paused' | 'error'. */
  status?: string | null;
  /** `feeds.schedule` — cron; NULL means no cron is configured, which does NOT
   *  imply the feed is human-triggered (see the header). */
  schedule?: string | null;
  /** `feeds.last_sync_status` — 'success' | 'failed' | 'pending' | NULL. */
  last_sync_status?: string | null;
  /** `feeds.last_sync_at`. */
  last_sync_at?: Date | string | null;
  /** `feeds.consecutive_failures`. */
  consecutive_failures?: number | null;
  /** `feeds.next_run_at` — only meaningful when schedule is present. */
  next_run_at?: Date | string | null;
  /** Number of pending/claimed/running sync runs selected by list_feeds. */
  active_runs?: number | null;
  /** `connections.status` — 'active' | 'paused' | 'error' | 'revoked' |
   *  'pending_auth'. */
  connection_status?: string | null;
  /** `auth_profiles.status` — 'active' | 'pending_auth' | 'error' | 'revoked'. */
  auth_profile_status?: string | null;
  /** `connections.device_worker_id` — NULL when not device-pinned. */
  device_worker_id?: string | null;
  /** Derived `device_online` flag (device polled within the liveness window). */
  device_online?: boolean | null;
}

interface FeedHealthSemantics {
  executionMode: FeedExecutionMode;
  attention: FeedAttentionState;
}

const isStreaming = (input: FeedHealthSemanticsInput): boolean =>
  input.store === "channel_messages";

const isScheduled = (input: FeedHealthSemanticsInput): boolean =>
  input.operations?.includes('sync') === true &&
  typeof input.schedule === "string" &&
  input.schedule.length > 0;

/** The connection or auth profile is not usable without human action. */
function needsAuth(input: FeedHealthSemanticsInput): boolean {
  if (
    input.connection_status === "pending_auth" ||
    input.connection_status === "revoked"
  ) {
    return true;
  }
  return (
    input.auth_profile_status != null &&
    input.auth_profile_status !== "" &&
    input.auth_profile_status !== "active"
  );
}

/** The feed is pinned to a device that has not recently polled. */
function deviceOffline(input: FeedHealthSemanticsInput): boolean {
  return (
    input.device_worker_id != null &&
    input.device_worker_id.length > 0 &&
    input.device_online === false
  );
}

/** The most recent attempt failed, or a failure episode is underway. */
function lastAttemptFailed(input: FeedHealthSemanticsInput): boolean {
  return (
    input.last_sync_status === "failed" ||
    (input.consecutive_failures ?? 0) > 0
  );
}

const FEED_OVERDUE_MARGIN_MS = 60 * 60 * 1000;

function scheduledExecutionOverdue(
  input: FeedHealthSemanticsInput,
  now: number
): boolean {
  if (!isScheduled(input) || (input.active_runs ?? 0) > 0) return false;
  if (input.next_run_at == null) return false;
  const nextRun =
    input.next_run_at instanceof Date
      ? input.next_run_at.getTime()
      : new Date(input.next_run_at).getTime();
  return Number.isFinite(nextRun) && nextRun < now - FEED_OVERDUE_MARGIN_MS;
}

/** The feed is paused, by operator or auto-pause. */
function isPaused(input: FeedHealthSemanticsInput): boolean {
  return input.status === "paused" || input.connection_status === "paused";
}

/** Attention for feed kinds that do not run collector sync jobs. */
function nonCollectorAttention(
  input: FeedHealthSemanticsInput
): FeedAttentionState {
  if (needsAuth(input)) return "needs_auth";
  if (isPaused(input)) return "paused";
  if (input.status === "error" || input.connection_status === "error") {
    return "misconfigured";
  }
  if (deviceOffline(input)) return "device_offline";
  return "healthy";
}

/**
 * Derive execution mode + attention state from the stored feed/connection/device
 * columns. Pure: the caller feeds the joined row fields and gets back the
 * classification. Order of checks fixes the precedence (the most actionable
 * state wins).
 */
export function deriveFeedHealthSemantics(
  input: FeedHealthSemanticsInput,
  now: number = Date.now()
): FeedHealthSemantics {
  // Storage decides presentation. A chat channel remains streaming even if a
  // connector later adds a direct read operation for that transcript.
  if (isStreaming(input)) {
    return {
      executionMode: "streaming",
      attention: nonCollectorAttention(input),
    };
  }

  // Read-only feeds are evaluated on demand; they have no sync lifecycle.
  if (
    input.operations?.includes('read') === true &&
    input.operations.includes('sync') === false
  ) {
    return {
      executionMode: "source_only",
      attention: nonCollectorAttention(input),
    };
  }

  const executionMode: FeedExecutionMode = isScheduled(input)
    ? "scheduled"
    : "no_schedule";

  let attention: FeedAttentionState;
  if (needsAuth(input)) {
    attention = "needs_auth";
  } else if (isPaused(input)) {
    attention = "paused";
  } else if (input.status === "error" || input.connection_status === "error") {
    attention = "misconfigured";
  } else if (deviceOffline(input)) {
    attention = "device_offline";
  } else if (lastAttemptFailed(input)) {
    attention = "last_attempt_failed";
  } else if (scheduledExecutionOverdue(input, now)) {
    attention = "overdue";
  } else if (
    input.last_sync_at == null &&
    input.last_sync_status !== "success"
  ) {
    attention = "never_run";
  } else {
    attention = "healthy";
  }

  return { executionMode, attention };
}
