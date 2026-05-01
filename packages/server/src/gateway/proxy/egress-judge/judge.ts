import { createLogger } from "@lobu/core";
import type { ResolvedJudgeRule } from "../../permissions/policy-store.js";
import { AnthropicJudgeClient } from "./anthropic-client.js";
import { VerdictCache } from "./cache.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { buildSystemPrompt, buildUserPrompt } from "./policy-composer.js";
import type { JudgeClient, JudgeDecision, JudgeRequest } from "./types.js";

const logger = createLogger("egress-judge");

/**
 * Default Haiku model for the judge. Fast + cheap; invoked only when a
 * rule with `action: "judge"` matches, so most traffic never touches it.
 */
export const DEFAULT_JUDGE_MODEL = "claude-haiku-4-5-20251001";

export interface EgressJudgeOptions {
  client?: JudgeClient;
  /** Judge model identifier (overridable per-agent via `egressConfig.judgeModel`). */
  defaultModel?: string;
  /** Verdict cache TTL. Default: 5 min. */
  cacheTtlMs?: number;
  /** Max verdict cache entries. Default: 2000. */
  cacheMaxEntries?: number;
  /** Consecutive-failure threshold before the circuit trips. Default: 5. */
  breakerFailureThreshold?: number;
  /** Cooldown before the circuit half-opens again. Default: 30s. */
  breakerCooldownMs?: number;
}

/**
 * Egress judge: wraps a JudgeClient with a per-policy verdict cache and
 * circuit breaker, and composes prompts from skill/operator policy + the
 * request.
 *
 * Thread-safety: single-threaded Node event loop; no locks needed. The
 * in-flight dedup map coalesces concurrent judge calls for the same
 * cache key so a burst of identical requests costs exactly one API call.
 */
export class EgressJudge {
  private readonly cache: VerdictCache;
  private readonly breaker: CircuitBreaker;
  private readonly inFlight = new Map<string, Promise<JudgeDecision>>();
  private readonly defaultModel: string;
  private _client: JudgeClient | undefined;

  constructor(options: EgressJudgeOptions = {}) {
    this.cache = new VerdictCache(
      options.cacheTtlMs ?? 5 * 60_000,
      options.cacheMaxEntries ?? 2000
    );
    this.breaker = new CircuitBreaker(
      options.breakerFailureThreshold ?? 5,
      options.breakerCooldownMs ?? 30_000
    );
    this.defaultModel = options.defaultModel ?? DEFAULT_JUDGE_MODEL;
    this._client = options.client;
  }

  /**
   * Defer Anthropic client construction until the first judge call so
   * gateways with no `judge`-action rules never require ANTHROPIC_API_KEY.
   */
  private get client(): JudgeClient {
    if (!this._client) {
      this._client = new AnthropicJudgeClient();
    }
    return this._client;
  }

  async decide(
    request: JudgeRequest,
    rule: ResolvedJudgeRule
  ): Promise<JudgeDecision> {
    const cacheKey = VerdictCache.key({
      policyHash: rule.policyHash,
      hostname: request.hostname,
      method: request.method,
      path: request.path,
    });

    const cached = this.cache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        source: "cache",
        latencyMs: 0,
        policyHash: rule.policyHash,
        judgeName: rule.judgeName,
      };
    }

    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const pending = this.runJudge(request, rule, cacheKey).finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, pending);
    return pending;
  }

  private async runJudge(
    request: JudgeRequest,
    rule: ResolvedJudgeRule,
    cacheKey: string
  ): Promise<JudgeDecision> {
    if (!this.breaker.canProceed(rule.policyHash)) {
      logger.warn("Egress judge circuit open — failing closed", {
        policyHash: rule.policyHash,
        hostname: request.hostname,
      });
      return {
        verdict: "deny",
        reason: "Judge unavailable (circuit breaker open); request denied",
        source: "circuit-open",
        latencyMs: 0,
        policyHash: rule.policyHash,
        judgeName: rule.judgeName,
      };
    }

    const started = Date.now();
    const model = rule.judgeModel ?? this.defaultModel;
    try {
      const verdict = await this.client.judge({
        model,
        systemPrompt: buildSystemPrompt(),
        userPrompt: buildUserPrompt({ policy: rule.policy, request }),
      });
      const latencyMs = Date.now() - started;
      this.breaker.onSuccess(rule.policyHash);
      this.cache.set(cacheKey, verdict);
      return {
        ...verdict,
        source: "judge",
        latencyMs,
        policyHash: rule.policyHash,
        judgeName: rule.judgeName,
      };
    } catch (err) {
      this.breaker.onFailure(rule.policyHash);
      logger.error("Egress judge call failed — failing closed", {
        policyHash: rule.policyHash,
        hostname: request.hostname,
        model,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        verdict: "deny",
        reason: "Judge call failed; request denied",
        source: "circuit-open",
        latencyMs: Date.now() - started,
        policyHash: rule.policyHash,
        judgeName: rule.judgeName,
      };
    }
  }
}
