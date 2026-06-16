/**
 * Centralized, env-overridable timing constants for the server's scheduling /
 * reaping loops.
 *
 * Every value is exposed as a lazy getter so overrides via `process.env` take
 * effect no matter when the module was imported (tests set env in
 * `beforeAll`, operators set it before boot — both work). Defaults are the
 * exact values previously hardcoded at the call sites.
 *
 * Other areas of the server (SSE keep-alive, due-feed cooldowns, …) can add
 * their constants here as they migrate — keep one getter per constant, name
 * the env var after the subsystem, and document the rationale for the
 * default.
 */

/** Positive number from env (rounded to an integer, matching the `::int`
 *  casts the SQL call sites apply); falls back when unset/invalid. */
function parseEnvInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : fallback;
}

/** Strict `<n> <unit>` Postgres interval literals only — these values are
 *  inlined into SQL by the stale-run sweeper, so anything fancier (or
 *  malformed) falls back to the default instead of reaching the database. */
export const PG_INTERVAL_PATTERN = /^\d+ (second|minute|hour|day)s?$/;

/** Postgres interval literal (e.g. '3 minutes') from env; falls back when
 *  unset or not a simple `<n> <unit>` literal. */
function parseEnvInterval(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw && PG_INTERVAL_PATTERN.test(raw) ? raw : fallback;
}

export const intervals = {
  /** Stale threshold (seconds) for the connector-lane run reaper.
   *  120s leaves room for the 30s worker heartbeat to miss ~3 ticks before
   *  the reaper writes the row off — a real worker stutter (GC pause, network
   *  blip) gets a grace window, but a crashed worker frees the feed within
   *  a couple of minutes instead of five. */
  get runsReaperStaleAfterSeconds(): number {
    return parseEnvInt('RUNS_REAPER_STALE_AFTER_SECONDS', 120);
  },

  /** How often the gateway-boot setInterval calls `reapStaleRuns`. */
  get runsReaperTickMs(): number {
    return parseEnvInt('RUNS_REAPER_TICK_MS', 30_000);
  },

  /** Coarse TTL for watcher runs that never heartbeat — generous (2h) so a
   *  long but live non-heartbeating turn isn't killed prematurely. */
  get watcherRunStaleInterval(): string {
    return parseEnvInterval('WATCHER_RUN_STALE_INTERVAL', '2 hours');
  },

  /** ~4 missed 30s device heartbeats. A heartbeating executor that goes
   *  silent this long is crashed/abandoned; a live one (beats every ~30s)
   *  never lapses. */
  get watcherRunHeartbeatStaleInterval(): string {
    return parseEnvInterval('WATCHER_RUN_HEARTBEAT_STALE_INTERVAL', '3 minutes');
  },

  /** Stale-claim threshold for watcher orphan recovery: a run stuck in
   *  `claimed` this long without progressing to `running` is taken to be from
   *  a crashed dispatcher (real session-create + fetch + POST takes seconds,
   *  not minutes). Any tighter and we'd race a legitimate slow dispatch on
   *  the same row. */
  get watcherOrphanedClaimThreshold(): string {
    return parseEnvInterval('WATCHER_ORPHANED_CLAIM_THRESHOLD', '5 minutes');
  },

  /** Poll cadence for the embedded in-process connector-worker daemon. */
  get embeddedWorkerPollIntervalMs(): number {
    return parseEnvInt('EMBEDDED_WORKER_POLL_INTERVAL_MS', 5_000);
  },

  /** Grace window (ms) an embedded worker subprocess gets after SIGTERM
   *  before the orchestrator escalates to SIGKILL. */
  get workerKillTimeoutMs(): number {
    return parseEnvInt('WORKER_KILL_TIMEOUT_MS', 5_000);
  },

  /** Default turn-liveness deadline. Comfortably exceeds the worker's 20s
   *  status_update interval so a live worker (which extends the deadline on
   *  every status_update — plus on the 30s SSE-ping ACK and delivery receipts)
   *  is never falsely failed; a silent/dead worker lapses within this window of
   *  its last worker-driven signal. */
  get turnDefaultDeadlineMs(): number {
    return parseEnvInt('TURN_DEFAULT_DEADLINE_MS', 60_000);
  },

  /** How often each replica sweeps for lapsed turn-liveness markers. */
  get turnLivenessSweepIntervalMs(): number {
    return parseEnvInt('TURN_LIVENESS_SWEEP_INTERVAL_MS', 15_000);
  },

  /** Runs-queue claim visibility timeout: rows in `claimed` for longer than
   *  this without a heartbeat are reset to pending so a fresh claim can pick
   *  them up. Must stay well above the claim heartbeat interval. */
  get runsClaimVisibilityTimeoutMs(): number {
    return parseEnvInt('RUNS_CLAIM_VISIBILITY_TIMEOUT_MS', 5 * 60 * 1000);
  },

  /** How often an in-flight runs-queue handler refreshes `claimed_at` to
   *  prove it's still alive. Must be << runsClaimVisibilityTimeoutMs so the
   *  sweeper doesn't race a healthy handler. */
  get runsClaimHeartbeatIntervalMs(): number {
    return parseEnvInt('RUNS_CLAIM_HEARTBEAT_INTERVAL_MS', 60 * 1000);
  },

  /** Runs-queue worker poll cadence between empty claims (a NOTIFY for the
   *  channel cuts the sleep short). */
  get runsPollIntervalMs(): number {
    return parseEnvInt('RUNS_POLL_INTERVAL_MS', 200);
  },

  /** TTL for per-agent SSE backlog entries (pruned lazily on read/write). */
  get sseBacklogTtlMs(): number {
    return parseEnvInt('SSE_BACKLOG_TTL_MS', 2 * 60 * 1000);
  },

  /** Max retained SSE backlog entries per agent (most-recent wins). */
  get sseBacklogLimit(): number {
    return parseEnvInt('SSE_BACKLOG_LIMIT', 100);
  },
};
