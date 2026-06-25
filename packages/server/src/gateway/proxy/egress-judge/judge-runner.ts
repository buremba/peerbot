import {
	createLogger,
	getErrorMessage,
} from "@lobu/core";
import { AnthropicJudgeClient } from "./anthropic-client.js";
import { VerdictCache } from "./cache.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import type { JudgeClient, JudgeVerdict } from "./types.js";
import {
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_TIMEOUT_MS,
  JudgeTimeoutError,
  envTimeoutMs,
  withTimeout,
} from "./judge-utils.js";

/**
 * Shared tuning knobs for any judge runner. Both the egress judge and the
 * text judge wrap a {@link JudgeClient} with the same verdict cache + circuit
 * breaker + per-call timeout shape; the defaults live here so the two stay in
 * sync when these values change.
 */
export interface JudgeRunnerOptions {
  client?: JudgeClient;
  defaultModel?: string;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  breakerFailureThreshold?: number;
  breakerCooldownMs?: number;
  judgeTimeoutMs?: number;
}

/**
 * Per-runner labels for the (otherwise identical) log lines and fail-closed
 * verdict reasons. The egress judge and text judge differ only in a name
 * prefix, the em-dash vs `--` separator, and `request denied` vs `denied`.
 */
export interface JudgeRunnerLabels {
  /** Logger name + the human prefix used in log messages, e.g. "egress-judge" / "Egress judge". */
  loggerName: string;
  logPrefix: string;
  /** Separator in the "<prefix> circuit open <sep> failing closed" lines. */
  separator: string;
  /** Suffix appended to the fail-closed reason, e.g. "request denied" or "denied". */
  deniedSuffix: string;
}

/**
 * Everything {@link JudgeRunner.run} needs to evaluate a single decision. The
 * three seams (cache key, prompts, result decoration) are supplied per-call so
 * the egress judge and text judge can share the cache/breaker/timeout/dedup
 * machinery while keeping their own key composition, prompt harness, and
 * return shape.
 */
export interface JudgeRunInput<TResult> {
  /** Tenant/policy-scoped verdict cache key. */
  cacheKey: string;
  /** Circuit-breaker key — trips independently per policy. */
  policyHash: string;
  /** Model override for this call; falls back to the runner default. */
  model?: string;
  /**
   * Extra structured fields the subclass wants in its warn/error logs
   * (e.g. `hostname` for egress). Merged into the fail-closed log records.
   */
  logFields?: Record<string, unknown>;
  /** Prompts handed to the underlying {@link JudgeClient}. */
  buildPrompts(): { systemPrompt: string; userPrompt: string };
  /**
   * Shape the verdict into the caller's result type. `source` distinguishes a
   * cache hit, a live judge call, a circuit-open fail-closed, and a
   * judge-error fail-closed so callers can emit accurate audit data.
   * `latencyMs` is the live call latency (0 for cache/circuit-open).
   */
  decorate(
    verdict: JudgeVerdict,
    meta: {
      source: "judge" | "cache" | "circuit-open" | "judge-error";
      latencyMs: number;
    }
  ): TResult;
}

/**
 * Generic judge runner: a {@link JudgeClient} fronted by a per-policy verdict
 * cache, a circuit breaker, an in-flight dedup map, and a per-call timeout.
 *
 * Subclasses expose their own `decide(...)` surface and translate it into a
 * {@link JudgeRunInput} passed to {@link run}. The control flow (cache → dedup
 * → breaker → timeout → fail-closed deny) and the fail-closed verdict payloads
 * are owned here so the two judges can't drift on their security-critical
 * paths.
 *
 * Thread-safety: single-threaded Node event loop; no locks. Concurrent calls
 * with the same cache key are coalesced via the in-flight map.
 */
export abstract class JudgeRunner<TResult> {
  private readonly cache: VerdictCache;
  private readonly breaker: CircuitBreaker;
  /** Undefined when EGRESS_JUDGE_MODEL is unset — callers must pass a model. */
  private readonly defaultModel: string | undefined;
  private readonly judgeTimeoutMs: number;
  private readonly inFlight = new Map<string, Promise<TResult>>();
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly labels: JudgeRunnerLabels;
  private _client: JudgeClient | undefined;

  constructor(labels: JudgeRunnerLabels, options: JudgeRunnerOptions = {}) {
    this.labels = labels;
    this.logger = createLogger(labels.loggerName);
    this.cache = new VerdictCache(
      options.cacheTtlMs ?? 5 * 60_000,
      options.cacheMaxEntries ?? 2000
    );
    this.breaker = new CircuitBreaker(
      options.breakerFailureThreshold ?? 5,
      options.breakerCooldownMs ?? 30_000
    );
    this.defaultModel = options.defaultModel ?? DEFAULT_JUDGE_MODEL;
    this.judgeTimeoutMs =
      options.judgeTimeoutMs ?? envTimeoutMs() ?? DEFAULT_JUDGE_TIMEOUT_MS;
    this._client = options.client;
  }

  /**
   * Defer client construction until the first call so callers with no judge
   * rules/guardrails never require ANTHROPIC_API_KEY.
   */
  private get client(): JudgeClient {
    if (!this._client) {
      this._client = new AnthropicJudgeClient();
    }
    return this._client;
  }

  /**
   * Cache lookup → in-flight dedup → live judge call. Returns the decorated
   * result. Cache hits and dedup'd concurrent calls reuse the shared machinery;
   * a live call goes through {@link runLiveJudge}.
   */
  protected async run(input: JudgeRunInput<TResult>): Promise<TResult> {
    // The verdict depends on the model, so the cache + in-flight keys must
    // include the effective model — otherwise two calls with the same
    // policy/text but different models (or the same guardrail after a model
    // edit) would reuse a verdict computed by the OTHER model. All default-model
    // calls share a bucket; explicit models each get their own.
    const model = input.model ?? this.defaultModel;
    const key = `${input.cacheKey}model:${model ?? ""}`;

    const cached = this.cache.get(key);
    if (cached) {
      return input.decorate(cached, { source: "cache", latencyMs: 0 });
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.runLiveJudge(input, key).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  /**
   * Single live judge call: breaker gate → timeout-bounded client call →
   * cache + decorate. Fails closed (deny) on an open circuit or any error,
   * recording a breaker failure in the latter case.
   */
  private async runLiveJudge(
    input: JudgeRunInput<TResult>,
    cacheKey: string
  ): Promise<TResult> {
    const { logPrefix, separator, deniedSuffix } = this.labels;

    // No model resolvable (EGRESS_JUDGE_MODEL unset and no per-call model).
    // This is a misconfiguration, not a transient fault, so fail closed
    // WITHOUT touching the breaker — the UI/API require a model up front, so
    // this is a defensive backstop.
    const model = input.model ?? this.defaultModel;
    if (!model) {
      this.logger.warn(
        `${logPrefix} no judge model configured ${separator} failing closed`,
        { policyHash: input.policyHash, ...input.logFields }
      );
      return input.decorate(
        {
          verdict: "deny",
          reason: `No judge model configured (set EGRESS_JUDGE_MODEL or specify a model); ${deniedSuffix}`,
        },
        { source: "judge-error", latencyMs: 0 }
      );
    }

    if (!this.breaker.canProceed(input.policyHash)) {
      this.logger.warn(`${logPrefix} circuit open ${separator} failing closed`, {
        policyHash: input.policyHash,
        ...input.logFields,
      });
      return input.decorate(
        {
          verdict: "deny",
          reason: `Judge unavailable (circuit breaker open); ${deniedSuffix}`,
        },
        { source: "circuit-open", latencyMs: 0 }
      );
    }

    const started = Date.now();
    const { systemPrompt, userPrompt } = input.buildPrompts();
    try {
      const verdict = await withTimeout(
        this.client.judge({ model, systemPrompt, userPrompt }),
        this.judgeTimeoutMs
      );
      const latencyMs = Date.now() - started;
      this.breaker.onSuccess(input.policyHash);
      this.cache.set(cacheKey, verdict);
      return input.decorate(verdict, { source: "judge", latencyMs });
    } catch (err) {
      this.breaker.onFailure(input.policyHash);
      const timedOut = err instanceof JudgeTimeoutError;
      this.logger.error(
        timedOut
          ? `${logPrefix} call timed out ${separator} failing closed`
          : `${logPrefix} call failed ${separator} failing closed`,
        {
          policyHash: input.policyHash,
          ...input.logFields,
          model,
          timeoutMs: timedOut ? this.judgeTimeoutMs : undefined,
          error: getErrorMessage(err),
        }
      );
      return input.decorate(
        {
          verdict: "deny",
          reason: timedOut
            ? `Judge call timed out; ${deniedSuffix}`
            : `Judge call failed; ${deniedSuffix}`,
        },
        { source: "judge-error", latencyMs: Date.now() - started }
      );
    }
  }
}
