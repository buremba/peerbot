/**
 * Worker-side live token manager.
 *
 * Background: every worker token (the deployment-lifetime WORKER_TOKEN minted at
 * spawn, and the per-run runJobToken minted per message) carries a fixed
 * `timestamp` and is rejected by the gateway 2h later (WORKER_TOKEN_TTL_MS — an
 * intentional security property; the short TTL is the leak-revocation path). A
 * worker can outlive that window:
 *   - across turns: each new turn already mints a fresh per-run token (the
 *     per-turn adoption in OpenClawWorker.execute() swaps it into env + the
 *     transport), so the cross-turn case is covered without this manager.
 *   - within ONE turn running >2h (long autonomous / watcher run): even the
 *     turn's runJobToken expires mid-turn. THIS is what the manager fixes.
 *
 * The manager holds the current live token and refreshes it against the gateway
 * `/worker/token/refresh` endpoint, which mints a fresh 2h token with the same
 * claims ONLY while the deployment still has an in-flight turn (deployment-
 * liveness revocation model). Two triggers:
 *   - proactive: when the token is close to expiry (checked before each gateway
 *     call), refresh ahead of the 401.
 *   - reactive: a 401 from any gateway call triggers a single refresh + retry.
 *
 * On a successful refresh the manager updates its in-memory token AND
 * `process.env.WORKER_TOKEN`, so every per-turn env-reader (session-context,
 * snapshot hydrate/clear, deliverFinalResult's hint) and any subsequently-read
 * consumer picks up the live token. Callers that captured the token elsewhere
 * (e.g. HttpWorkerTransport's field) register an onRefresh listener to stay in
 * sync.
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

export type RefreshListener = (token: string) => void;

export class WorkerTokenManager {
  private token: string;
  /** Wall-clock ms when the current token was issued/adopted (≈ its mint time
   *  for a freshly-refreshed token; for the boot/per-run token it's when the
   *  manager first saw it — a conservative under-estimate of remaining life,
   *  which only makes the proactive refresh fire earlier, never later). */
  private issuedAtMs: number;
  private readonly gatewayUrl: string;
  private readonly listeners: RefreshListener[] = [];
  /** De-dupe concurrent refreshes: many gateway calls can race a 401. */
  private inFlight: Promise<string | null> | null = null;

  constructor(initialToken: string, gatewayUrl: string, issuedAtMs?: number) {
    this.token = initialToken;
    this.gatewayUrl = gatewayUrl;
    this.issuedAtMs = issuedAtMs ?? Date.now();
  }

  getToken(): string {
    return this.token;
  }

  /** Adopt a new token from outside (e.g. the per-turn runJobToken swap at the
   *  start of each turn). Resets the issued-at clock. */
  adopt(token: string, issuedAtMs: number = Date.now()): void {
    this.token = token;
    this.issuedAtMs = issuedAtMs;
  }

  onRefresh(listener: RefreshListener): void {
    this.listeners.push(listener);
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
      // Keep every env-reader and registered consumer on the live token.
      process.env.WORKER_TOKEN = body.token;
      for (const l of this.listeners) {
        try {
          l(body.token);
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "Worker token refresh listener threw"
          );
        }
      }
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

/** Test-only: reset the process-wide manager. */
export function __resetWorkerTokenManagerForTests(): void {
  manager = null;
}
