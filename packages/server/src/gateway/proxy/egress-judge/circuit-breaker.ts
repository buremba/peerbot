/**
 * Per-policy circuit breaker. When a judge policy has seen `failureThreshold`
 * consecutive transport failures, the breaker trips for `cooldownMs` and all
 * further requests fail closed (deny) without calling the judge.
 *
 * Closed (healthy): requests hit the judge; failures increment the counter.
 * Open (tripped): requests short-circuit to deny until cooldown expires.
 * Half-open (probe): after cooldown, one request is allowed through; if it
 *   succeeds the breaker closes, if it fails the breaker re-opens.
 *
 * The breaker is keyed by policy hash, not by agent — if a skill's policy
 * is broken (e.g. malformed), only requests using that policy are denied.
 */
/**
 * Cap on tracked policy hashes. With churn (agents redeployed frequently
 * with new policies) the state map would otherwise grow forever. When the
 * cap is hit we evict the oldest inserted entry — a no-op for any policy
 * that's been healthy long enough to fall out of the window.
 */
const MAX_TRACKED_POLICIES = 1000;

export class CircuitBreaker {
  private readonly state = new Map<
    string,
    {
      consecutiveFailures: number;
      openUntil: number;
      halfOpenInFlight: boolean;
    }
  >();

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number
  ) {}

  /**
   * Called before issuing a judge request. Returns `true` if the caller
   * should proceed to invoke the judge, or `false` if the breaker is open
   * and the caller should fail closed.
   */
  canProceed(policyHash: string): boolean {
    const entry = this.state.get(policyHash);
    if (!entry) return true;
    if (entry.openUntil === 0) return true; // closed
    if (Date.now() >= entry.openUntil) {
      // Half-open: allow at most one probe in flight.
      if (entry.halfOpenInFlight) return false;
      entry.halfOpenInFlight = true;
      return true;
    }
    return false;
  }

  onSuccess(policyHash: string): void {
    this.state.delete(policyHash);
  }

  onFailure(policyHash: string): void {
    const entry =
      this.state.get(policyHash) ??
      ({
        consecutiveFailures: 0,
        openUntil: 0,
        halfOpenInFlight: false,
      } as const);
    const next = {
      consecutiveFailures: entry.consecutiveFailures + 1,
      openUntil: entry.openUntil,
      halfOpenInFlight: false,
    };
    if (next.consecutiveFailures >= this.failureThreshold) {
      next.openUntil = Date.now() + this.cooldownMs;
    }
    if (
      !this.state.has(policyHash) &&
      this.state.size >= MAX_TRACKED_POLICIES
    ) {
      const oldest = this.state.keys().next().value;
      if (oldest !== undefined) this.state.delete(oldest);
    }
    this.state.set(policyHash, next);
  }

  /** For tests. */
  isOpen(policyHash: string): boolean {
    const entry = this.state.get(policyHash);
    if (!entry) return false;
    return entry.openUntil > 0 && Date.now() < entry.openUntil;
  }

  /** For tests. */
  reset(): void {
    this.state.clear();
  }
}
