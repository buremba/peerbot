/**
 * Derived feed-health semantics.
 *
 * Execution mode and attention state are DERIVED from existing
 * feed/connection/device columns at read time — never stored. The stored
 * columns keep their historical meaning; this module only classifies.
 *
 * ## Why derive instead of store
 *
 * A feed's execution nature (`virtual` vs `streaming` vs `scheduled` vs
 * `no_schedule`) is a pure function of `kind`/`virtual`/`schedule`. Its
 * attention state is a pure function of lifecycle/sync state, auth-profile
 * status, and device liveness. Storing these would duplicate state that already
 * lives on the row and drift when the source columns move (auto-pause, backoff,
 * resume). Read-time derivation is O(1) per feed and cannot diverge.
 *
 * ## The two outputs
 *
 * - `executionMode` — what the row says about how this feed runs:
 *   - `virtual` — a virtual (live-pushdown) feed evaluated on demand.
 *   - `streaming` — a chat channel populated by incoming messages.
 *   - `scheduled` — a non-virtual feed with a cron in `feeds.schedule`.
 *   - `no_schedule` — a non-virtual feed with no cron. This says the feed has
 *     no cron and NOTHING MORE. It was called `manual` until 2026-08-12, which
 *     read an intent into it that the column does not carry: measured on prod
 *     that day, 196 of 215 active collected feeds have no cron, and many are
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

type FeedExecutionMode = "virtual" | "streaming" | "scheduled" | "no_schedule";

type FeedAttentionState =
  | "healthy"
  | "paused"
  | "needs_auth"
  | "last_attempt_failed"
  | "never_run"
  | "device_offline"
  | "misconfigured";

interface FeedHealthSemanticsInput {
  /** `feeds.kind` — 'collected' | 'streaming' | 'virtual'. */
  kind?: string | null;
  /** Legacy `feeds.virtual` boolean (two-phase migration keeps both). */
  virtual?: boolean | null;
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

const isVirtual = (input: FeedHealthSemanticsInput): boolean =>
  input.kind === "virtual" || input.virtual === true;

const isStreaming = (input: FeedHealthSemanticsInput): boolean =>
  input.kind === "streaming";

const isScheduled = (input: FeedHealthSemanticsInput): boolean =>
  !isVirtual(input) &&
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
  input: FeedHealthSemanticsInput
): FeedHealthSemantics {
  // Virtual feeds are evaluated on demand; they have no unattended runtime.
  if (isVirtual(input)) {
    return {
      executionMode: "virtual",
      attention: nonCollectorAttention(input),
    };
  }

  // Streaming feeds are chat channels backed by channel_messages, not
  // collector jobs. They have no sync history or schedule to classify.
  if (isStreaming(input)) {
    return {
      executionMode: "streaming",
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
