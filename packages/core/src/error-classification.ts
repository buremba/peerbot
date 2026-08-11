/**
 * Read-time error classification for runs.
 *
 * Maps a run's stored failure signals (`error_message`, `status`, auth-signal
 * hints, execution mode) to a bounded operational category WITHOUT writing any
 * new column. Nothing here rewrites history: classification is a pure function
 * of the row fields the caller already has, so it can be applied on any API/UI/
 * metrics read path and never drifts from the stored truth.
 *
 * Two decision outputs ride alongside the category:
 *
 *  - `retryable` — the failure is worth retrying as-is (transient quota
 *    throttling, upstream 5xx, network). Never true for human-actionable or
 *    terminal-intent categories.
 *  - `operationalIncident` — the failure should count against platform /
 *    integration uptime (an unattended infra fault). Never true for a human
 *    decision, a cancelled action, or an invalid-input request.
 *
 * Category semantics:
 *  - `auth_required` — credentials/session missing or expired; a human must
 *    re-auth. Not an infra incident.
 *  - `permission_required` — the acting identity lacks permission. Not an
 *    incident (policy, not outage).
 *  - `invalid_input` — the request itself was malformed. Not an incident.
 *  - `target_gone` — the resource being acted on no longer exists (deleted
 *    post, revoked token's owner, removed entity). Not an incident.
 *  - `provider_quota` — provider exhausted credits/quota or is throttling.
 *    `retryable` only when it is a transient 429 (vs an exhausted-balance
 *    stop). An outage of the PROVIDER, not Lobu; `operationalIncident` reflects
 *    that it blocked unattended work.
 *  - `transient_external` — a retryable upstream failure (5xx, network,
 *    timeout) that is not a provider-quota condition.
 *  - `device_unavailable` — the pinned device/browser is offline. Blocks
 *    unattended device work; the fix is human (bring the device online).
 *  - `timeout` — the run lapsed. `retryable` true when it was never claimed
 *    (queue would accept a retry); false when it was claimed and died.
 *  - `cancelled` — a human or policy decision ended the run. Never an
 *    incident, never retried.
 *  - `internal` — Lobu's own runtime fault (worker died, enqueue failed,
 *    sandbox/config). An infra incident, but NOT a provider incident.
 *
 * The classification is deliberately conservative: it reads only stable
 * signals (status + message patterns + explicit hints) and never invents
 * structure the row does not carry. Unknown messages default to `internal` so
 * a genuinely unexplained failure is visible, never silently excused.
 */

export type RunErrorCategory =
  | "auth_required"
  | "permission_required"
  | "invalid_input"
  | "target_gone"
  | "provider_quota"
  | "transient_external"
  | "device_unavailable"
  | "timeout"
  | "cancelled"
  | "internal";

export interface RunErrorClassification {
  category: RunErrorCategory;
  retryable: boolean;
  operationalIncident: boolean;
}

/** Stable, shared message patterns — every match is intentional and tested. */
const AUTH_RE =
  /(sign[\s-]?in|re-?auth|reauthenticat|session\s+(?:expired|needs|invalid|timed)|cookies?[\s\S]{0,30}expired|authentication\s+failed|unauthor(?:ized)?|login\s+required|not\s+logged\s*in|credential|oauth|token\s+expired|authwall|auth wall|needs_auth|AUTH_MISSING|AUTH_INVALID|setup_required|pending_auth)/i;

const PERMISSION_RE =
  /(permission\s+denied|forbidden|not\s+authorized|insufficient\s+permissions|403)/i;

const INVALID_INPUT_RE =
  /(invalid\s+(?:input|argument|request)|validation\s+failed|missing\s+required\s+field|malformed|bad\s+request|400\b|4\d{2}\s+bad)/i;

const TARGET_GONE_RE =
  /(not\s+found|no\s+such|does\s+not\s+exist|deleted\s+post|removed|gone|410\b|404\b|target_gone|stale\s+ref)/i;

const PROVIDER_QUOTA_RE =
  /(quota|insufficient\s+balance|insufficient\s+credits|no\s+credits?\s+remaining|billing|payment\s+required|429|rate\s+limit|too\s+many\s+requests|overloaded|limit\s+(?:exhausted|reached)|PROVIDER_QUOTA|provider\s+quota)/i;

const TRANSIENT_RE =
  /(5\d{2}|502|503|504|service\s+unavailable|upstream|network\s+error|connection\s+(?:refused|reset|lost)|fetch\s+failed|socket|timed?\s*out|timeout|ECONN|temporary)/i;

const DEVICE_UNAVAILABLE_RE =
  /(no\s+online\s+paired|browser\b.{0,40}offline|chrome\s+extension\b.{0,40}offline|device\b.{0,40}(?:offline|unavailable)|(?:never|not)\s+claimed\s+by\s+any|did\s+not\s+complete\s+in\s+time)/i;

/** Deliberately non-actionable input (e.g. prepare_comment on a generic feed
 *  URL with no durable post id). Never an incident, never retried. */
const NOT_ACTIONABLE_RE =
  /not_actionable|not\s+actionable|missing_durable_post_id|no\s+durable\s+(?:post|target|identifier)\s*id/i;

const WORKER_INTERNAL_RE =
  /(worker\s+(?:died|unresponsive|startup|crashed)|enqueue\s+failed|no\s+local\s+agent\s+executor|sandbox|config|internal|infrastructure)/i;

/** Transient statuses that a queue would sensibly retry. */
const TRANSIENT_STATUSES = new Set(["pending", "claimed", "running"]);

/**
 * Classify a run from its stored fields. `status` and `errorMessage` are the
 * primary inputs; `authSignal` and `executionMode` sharpen the call when the
 * caller has them (e.g. an `auth_signal` on the row, or a manual vs scheduled
 * feed context).
 */
export function classifyRunError(input: {
  status?: string | null;
  errorMessage?: string | null;
  errorCode?: string | null;
  /** e.g. runs.auth_signal JSON payload — presence implies auth involvement. */
  authSignal?: unknown;
  /** e.g. 'virtual' | 'scheduled' | 'manual' — used to temper incident flags. */
  executionMode?: string | null;
}): RunErrorClassification {
  const status = input.status ?? "";
  const message = input.errorMessage ?? "";
  const authInvolved = input.authSignal != null || input.errorCode != null;

  // Terminal human/policy decisions are never incidents and never retried.
  if (status === "cancelled" || status === "expired") {
    return {
      category: "cancelled",
      retryable: false,
      operationalIncident: false,
    };
  }

  // Explicit timeout status (reaper / watcher sweep / device wait).
  if (status === "timeout") {
    // A never-claimed timeout is a queue-retry candidate; a claimed-then-dead
    // one is a platform fault already surfaced. Both are infra incidents.
    return {
      category: "timeout",
      retryable:
        message.includes("never claimed") || message.includes("not claimed"),
      operationalIncident: true,
    };
  }

  if (status === "completed") {
    return {
      category: "internal",
      retryable: false,
      operationalIncident: false,
    };
  }

  // Failed / running / pending: classify from message + hints.
  if (authInvolved && AUTH_RE.test(message)) {
    return {
      category: "auth_required",
      retryable: false,
      operationalIncident: false,
    };
  }
  if (AUTH_RE.test(message)) {
    return {
      category: "auth_required",
      retryable: false,
      operationalIncident: false,
    };
  }
  if (PERMISSION_RE.test(message)) {
    return {
      category: "permission_required",
      retryable: false,
      operationalIncident: false,
    };
  }
  if (NOT_ACTIONABLE_RE.test(message)) {
    return {
      category: "invalid_input",
      retryable: false,
      operationalIncident: false,
    };
  }
  if (TARGET_GONE_RE.test(message)) {
    return {
      category: "target_gone",
      retryable: false,
      operationalIncident: false,
    };
  }
  if (INVALID_INPUT_RE.test(message)) {
    return {
      category: "invalid_input",
      retryable: false,
      operationalIncident: false,
    };
  }
  if (PROVIDER_QUOTA_RE.test(message)) {
    // Distinguish a transient throttle (429/rate limit → retryable) from an
    // exhausted-balance stop (billing/quota → retry is pointless).
    const transientThrottle =
      /\b429\b|rate\s+limit|too\s+many\s+requests|overloaded/i.test(message);
    return {
      category: "provider_quota",
      retryable: transientThrottle,
      // Blocks unattended scheduled work — an incident of the PROVIDER.
      operationalIncident: input.executionMode === "scheduled",
    };
  }
  if (DEVICE_UNAVAILABLE_RE.test(message)) {
    return {
      category: "device_unavailable",
      retryable: true,
      operationalIncident: input.executionMode === "scheduled",
    };
  }
  if (TRANSIENT_RE.test(message)) {
    return {
      category: "transient_external",
      retryable: true,
      operationalIncident: input.executionMode === "scheduled",
    };
  }
  if (WORKER_INTERNAL_RE.test(message)) {
    return {
      category: "internal",
      retryable: TRANSIENT_STATUSES.has(status),
      operationalIncident: true,
    };
  }
  if (message.length === 0) {
    // Failed with no message at all: we cannot see a cause, so classify as an
    // internal visibility failure that is safe to retry (the queue may surface
    // a message on the next attempt).
    return { category: "internal", retryable: true, operationalIncident: true };
  }

  // Unknown failure with a message: fail toward visibility.
  return { category: "internal", retryable: true, operationalIncident: true };
}
