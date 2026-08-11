/**
 * Derived feed-health semantics.
 *
 * Execution mode, attention state, and incident eligibility are DERIVED from
 * existing feed/connection/device columns at read time — never stored. The
 * stored columns keep their historical meaning; this module only classifies.
 *
 * ## Why derive instead of store
 *
 * A feed's execution nature (`virtual` vs `streaming` vs `scheduled` vs
 * `manual`) is a pure function of `kind`/`virtual`/`schedule`. Its attention
 * state is a pure function of lifecycle/sync state, auth-profile status, and
 * device liveness. Storing these would duplicate state that already lives on
 * the row and drift when the source columns move (auto-pause, backoff, resume).
 * Read-time derivation is O(1) per feed and cannot diverge.
 *
 * ## The three outputs
 *
 * - `executionMode` — how this feed is *supposed* to run:
 *   - `virtual` — a virtual (live-pushdown) feed evaluated on demand.
 *   - `streaming` — a chat channel populated by incoming messages.
 *   - `scheduled` — a non-virtual feed with an active schedule.
 *   - `manual` — a non-virtual feed without a schedule.
 * - `attention` — what a human/UI should be told about the feed right now,
 *   ordered so the most actionable state wins:
 *   - `needs_auth` — the connection/auth profile is not usable (pending_auth,
 *     revoked, auth profile not active).
 *   - `paused` — operator- or auto-paused; not running until resumed.
 *   - `misconfigured` — the connection is in an error state, or (when the
 *     caller opts in) a feed expected to carry a schedule does not.
 *   - `device_offline` — the feed is pinned to a device that has not polled
 *     within the liveness window.
 *   - `last_attempt_failed` — the most recent attempt failed (failing state,
 *     including backoff episodes).
 *   - `never_run` — never synced.
 *   - `healthy` — everything else.
 * - `incidentEligible` — whether this feed, if failing, should count as an
 *   UNATTENDED INCIDENT. True only for an active SCHEDULED feed that is
 *   expected to run unattended and is currently failing for a platform-relevant
 *   reason. Always false for:
 *   - manual feeds (e.g. Midas — a failed manual attempt is user-visible but
 *     not a scheduled-feed incident)
 *   - paused feeds
 *   - virtual feeds (evaluated on demand)
 *   - known `needs_auth` / manual-login conditions (the user must act; not an
 *     infra incident)
 */

type FeedExecutionMode = "virtual" | "streaming" | "scheduled" | "manual";

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
  /** `feeds.schedule` — cron; NULL means manual-only. */
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
  incidentEligible: boolean;
}

const isVirtual = (input: FeedHealthSemanticsInput): boolean =>
  input.kind === "virtual" || input.virtual === true;

const isStreaming = (input: FeedHealthSemanticsInput): boolean =>
  input.kind === "streaming";

const isScheduled = (input: FeedHealthSemanticsInput): boolean =>
  !isVirtual(input) &&
  typeof input.schedule === "string" &&
  input.schedule.length > 0;

const isActive = (status?: string | null): boolean => status === "active";

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
 * Derive execution mode + attention state + incident eligibility from the
 * stored feed/connection/device columns. Pure: the caller feeds the joined row
 * fields and gets back the classification. Order of checks fixes the
 * precedence (the most actionable state wins).
 */
export function deriveFeedHealthSemantics(
  input: FeedHealthSemanticsInput
): FeedHealthSemantics {
  // Virtual feeds are evaluated on demand; they have no unattended runtime.
  if (isVirtual(input)) {
    return {
      executionMode: "virtual",
      attention: nonCollectorAttention(input),
      incidentEligible: false,
    };
  }

  // Streaming feeds are chat channels backed by channel_messages, not
  // collector jobs. They have no sync history or schedule to classify.
  if (isStreaming(input)) {
    return {
      executionMode: "streaming",
      attention: nonCollectorAttention(input),
      incidentEligible: false,
    };
  }

  const executionMode: FeedExecutionMode = isScheduled(input)
    ? "scheduled"
    : "manual";

  // A feed counts as unattended only when it is an active scheduled capability
  // on an active connection — never manual, paused, virtual, or broken.
  const unattended =
    executionMode === "scheduled" &&
    isActive(input.status) &&
    isActive(input.connection_status);

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

  // Unattended scheduled feeds are incident-eligible when currently failing
  // for a platform-relevant reason: a failed attempt, a failure episode, or a
  // pinned device that has gone offline (the unattended capability is down).
  // Auth-waiting feeds are excluded — the user must act, it is not an infra
  // incident.
  const incidentEligible =
    unattended &&
    !needsAuth(input) &&
    (lastAttemptFailed(input) || deviceOffline(input));

  return { executionMode, attention, incidentEligible };
}
