/**
 * Worker-side live token manager — the single source of truth for the current
 * worker token. Worker tokens carry a fixed timestamp and are rejected 2h later
 * (the short TTL is the leak-revocation property); this manager keeps a >2h
 * single turn alive by refreshing against `/worker/token/refresh`. The
 * server-side per-turn liveness gate (and the cross-turn case) is documented at
 * the gateway route + its route tests.
 *
 * Callers read getToken() (or go through fetchWithRefresh). Refresh has three
 * triggers: timer (proactive — renews even when the turn makes NO gateway call,
 * the load-bearing path since the route rejects an already-expired bearer),
 * pre-call ensureFresh(), and reactive (a 401 → one refresh + retry). On success
 * it mirrors the token into `process.env.WORKER_TOKEN` for env-readers.
 */

import { createLogger, ensureBaseUrl, getOptionalEnv } from "@lobu/core";

const logger = createLogger("worker-token-manager");

/**
 * Default assumed token TTL (must mirror the gateway's WORKER_TOKEN_TTL_MS
 * default of 2h). Override via WORKER_TOKEN_TTL_MS so a deployment that tunes
 * the gateway TTL keeps the proactive window aligned. The reactive 401 path is
 * the safety net if this drifts.
 */
function assumedTtlMs(): number {
  const raw = parseInt(process.env.WORKER_TOKEN_TTL_MS ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 2 * 60 * 60 * 1000;
}

/**
 * Refresh proactively once the token is within this fraction of its assumed
 * lifetime from expiry. 0.2 → refresh in the last ~24min of a 2h token, leaving
 * ample margin before the hard cutoff.
 */
const PROACTIVE_REFRESH_FRACTION = 0.2;

/** Retry cadence for the timer-driven refresh after a transient denial/failure
 *  near the window edge, so one miss doesn't permanently disable auto-refresh. */
const AUTO_REFRESH_RETRY_MS = 30_000;

export class WorkerTokenManager {
  private token: string;
  /** Wall-clock ms when the current token was issued/adopted (≈ its mint time
   *  for a freshly-refreshed token; for the boot/per-run token it's when the
   *  manager first saw it — a conservative under-estimate of remaining life,
   *  which only makes the proactive refresh fire earlier, never later). */
  private issuedAtMs: number;
  private readonly gatewayUrl: string;
  /** De-dupe concurrent refreshes: many gateway calls can race a 401. */
  private inFlight: Promise<string | null> | null = null;
  /** Timer that fires a refresh at the start of the proactive window, so the
   *  token is renewed even when the worker makes NO gateway call before expiry
   *  (the >2h single-turn case where on-demand refresh would otherwise fire
   *  too late — the bearer would already be expired and the route rejects it
   *  before the liveness gate). */
  private autoRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private autoRefreshEnabled = false;

  constructor(initialToken: string, gatewayUrl: string, issuedAtMs?: number) {
    this.token = initialToken;
    this.gatewayUrl = gatewayUrl;
    this.issuedAtMs = issuedAtMs ?? Date.now();
  }

  getToken(): string {
    return this.token;
  }

  /** Adopt a new token from outside (e.g. the per-turn runJobToken swap at the
   *  start of each turn). Resets the issued-at clock and re-arms the timer. */
  adopt(token: string, issuedAtMs: number = Date.now()): void {
    this.token = token;
    this.issuedAtMs = issuedAtMs;
    if (this.autoRefreshEnabled) this.armAutoRefresh();
  }

  /**
   * Start timer-driven proactive refresh. The worker enables this for the
   * duration of a turn so a long-running turn that makes no gateway calls still
   * renews its token BEFORE it hard-expires (refresh must travel with a still-
   * valid bearer — the route rejects an already-expired token before the
   * liveness gate). Idempotent; safe to call every turn.
   */
  enableAutoRefresh(): void {
    this.autoRefreshEnabled = true;
    this.armAutoRefresh();
  }

  /** Stop the timer (turn end / shutdown / tests). */
  disableAutoRefresh(): void {
    this.autoRefreshEnabled = false;
    if (this.autoRefreshTimer) {
      clearTimeout(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  /** (Re)schedule the next proactive refresh at the start of the proactive
   *  window. If already inside the window, fire on the next tick. */
  private armAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearTimeout(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
    const ttl = assumedTtlMs();
    const fireAt = this.issuedAtMs + ttl * (1 - PROACTIVE_REFRESH_FRACTION);
    const delay = Math.max(0, fireAt - Date.now());
    const timer = setTimeout(() => {
      this.autoRefreshTimer = null;
      // refresh() re-arms via adopt() on success; on failure (e.g. deployment
      // not yet/no-longer live) re-arm a short retry so a transient denial near
      // the window edge doesn't permanently disable the timer.
      void this.refresh().then((tok) => {
        if (!tok && this.autoRefreshEnabled && !this.autoRefreshTimer) {
          this.autoRefreshTimer = setTimeout(
            () => this.armAutoRefresh(),
            AUTO_REFRESH_RETRY_MS
          );
          this.autoRefreshTimer.unref?.();
        }
      });
    }, delay);
    timer.unref?.();
    this.autoRefreshTimer = timer;
  }

  /** True when the token is within the proactive-refresh window of expiry. */
  private isNearExpiry(): boolean {
    const ttl = assumedTtlMs();
    const age = Date.now() - this.issuedAtMs;
    return age >= ttl * (1 - PROACTIVE_REFRESH_FRACTION);
  }

  /**
   * Ensure the token is fresh before a gateway call. Refreshes only when near
   * expiry (cheap no-op otherwise). Never throws — a failed proactive refresh
   * leaves the existing token in place and lets the reactive 401 path handle it.
   */
  async ensureFresh(): Promise<void> {
    if (this.isNearExpiry()) {
      await this.refresh();
    }
  }

  /**
   * Force a refresh (the reactive 401 path). Returns the new token on success,
   * or null when refresh was denied (deployment no longer live) / failed.
   * Concurrent callers share one in-flight request.
   */
  async refresh(): Promise<string | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<string | null> {
    try {
      const url = `${ensureBaseUrl(this.gatewayUrl)}/worker/token/refresh`;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        // 403 = deployment no longer live (refresh revoked) or token ineligible;
        // 401 = current token already expired/revoked. Either way we can't get a
        // fresh token — the caller's gateway call will fail and the turn ends.
        logger.warn(
          { status: res.status },
          "Worker token refresh rejected by gateway"
        );
        return null;
      }
      const body = (await res.json()) as { token?: string };
      if (!body.token) {
        logger.warn("Worker token refresh returned no token");
        return null;
      }
      this.adopt(body.token);
      // Mirror into the env so the env-reading consumers (session-context,
      // snapshot hydrate/clear, the audio-permission hint) use the live token.
      process.env.WORKER_TOKEN = body.token;
      logger.info("Refreshed worker token");
      return body.token;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Worker token refresh failed"
      );
      return null;
    }
  }

  /**
   * Run a gateway fetch with proactive + reactive refresh. `doFetch` receives
   * the current token and must use it for the Authorization header. On a 401 we
   * refresh once and retry; a second 401 (or refresh denial) is returned as-is.
   */
  async fetchWithRefresh(
    doFetch: (token: string) => Promise<Response>
  ): Promise<Response> {
    await this.ensureFresh();
    let res = await doFetch(this.token);
    if (res.status === 401) {
      const fresh = await this.refresh();
      if (fresh) {
        res = await doFetch(fresh);
      }
    }
    return res;
  }
}

/**
 * Process-wide manager. The worker is a single-conversation subprocess, so one
 * instance per process is correct. Constructed lazily from the env on first use
 * and re-anchored each turn via {@link adoptWorkerToken}.
 */
let manager: WorkerTokenManager | null = null;

export function getWorkerTokenManager(): WorkerTokenManager {
  if (!manager) {
    manager = new WorkerTokenManager(
      getOptionalEnv("WORKER_TOKEN", ""),
      getOptionalEnv("DISPATCHER_URL", "")
    );
  }
  return manager;
}

/** Adopt a freshly-minted per-run token at turn start (resets the TTL clock).
 *  Also mirrors it into process.env.WORKER_TOKEN for env-readers. */
export function adoptWorkerToken(token: string): void {
  process.env.WORKER_TOKEN = token;
  getWorkerTokenManager().adopt(token);
}

/** Test-only: reset the process-wide manager (clears any pending timer). */
export function __resetWorkerTokenManagerForTests(): void {
  manager?.disableAutoRefresh();
  manager = null;
}
