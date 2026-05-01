/**
 * A request the proxy wants the judge to evaluate.
 *
 * For HTTPS CONNECT requests, only the hostname is visible — method and
 * path are not available because TLS is end-to-end.
 */
export interface JudgeRequest {
  agentId: string;
  hostname: string;
  method?: string;
  path?: string;
}

/**
 * A judge's verdict for a single request. `reason` is surfaced to the
 * worker when the verdict is "deny" so the agent can replan; it is not
 * shown to end users.
 */
export interface JudgeVerdict {
  verdict: "allow" | "deny";
  reason: string;
}

/**
 * A decision with provenance — distinguishes a cached verdict from a live
 * judge call and marks the circuit-breaker fail-closed path so callers can
 * emit accurate audit events.
 */
export interface JudgeDecision extends JudgeVerdict {
  source: "judge" | "cache" | "circuit-open";
  latencyMs: number;
  policyHash: string;
  judgeName: string;
}

/**
 * Pluggable judge transport. Extracted so the proxy can inject a fake for
 * tests without running the Anthropic SDK.
 */
export interface JudgeClient {
  /**
   * Call the judge model and return a structured verdict. Implementations
   * must fail fast on transport/API errors — the circuit breaker is the
   * retry policy, not this method.
   */
  judge(args: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<JudgeVerdict>;
}
