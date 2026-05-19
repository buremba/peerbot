import { createHash } from "node:crypto";
import { createLogger } from "@lobu/core";
import { AnthropicJudgeClient } from "./anthropic-client.js";
import { VerdictCache } from "./cache.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import type { JudgeClient, JudgeVerdict } from "./types.js";

const logger = createLogger("text-judge");

/**
 * Default Haiku model -- same model the egress judge uses.
 */
const DEFAULT_JUDGE_MODEL = "claude-haiku-4-5-20251001";

/**
 * Hard ceiling on a single judge call. Same default as the egress judge.
 */
const DEFAULT_JUDGE_TIMEOUT_MS = 8_000;

/**
 * Separator between policy and text when hashing the cache key. ASCII 0x1F
 * (Unit Separator) so a policy ending in "foo" + text "bar" can't collide
 * with policy "f" + text "oobar". Written as the JS escape "\u001F" rather than a literal
 * control byte so the file stays plain ASCII (a literal 0x1F makes git
 * treat the source as binary).
 */
const HASH_SEPARATOR = "\u001F";

function envTimeoutMs(): number | undefined {
  const raw = process.env.EGRESS_JUDGE_TIMEOUT_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

class JudgeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Text judge call exceeded ${timeoutMs}ms`);
    this.name = "JudgeTimeoutError";
  }
}

const TEXT_JUDGE_SYSTEM_PROMPT = `You are a safety judge for an autonomous AI agent's text outputs and inputs.

You decide whether a single piece of text is safe to pass, given the policy the operator has configured. The text may be a user message inbound to the agent, the agent's outbound response, or a tool-call argument bundle the agent is about to execute.

Return ONLY a JSON object matching this exact shape:
{ "verdict": "allow" | "deny", "reason": "<short sentence>" }

- "allow" means the text is within policy.
- "deny" means the text violates policy and the action must be blocked.
- "reason" is a short sentence (under 30 words). Do not include chain of thought.
- If the policy is ambiguous, fail closed: deny with a reason explaining the ambiguity.
- Output must be parseable JSON. No prose outside the JSON object.`;

function buildUserPrompt(policy: string, text: string): string {
  return `Policy:
${policy.trim()}

Text:
${text}`;
}

function hashTextJudgeKey(policy: string, text: string): string {
  const h = createHash("sha256");
  h.update(policy);
  h.update(HASH_SEPARATOR);
  h.update(text);
  return h.digest("hex");
}

function hashPolicy(policy: string): string {
  return createHash("sha256").update(policy).digest("hex");
}

export interface TextJudgeOptions {
  client?: JudgeClient;
  defaultModel?: string;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  breakerFailureThreshold?: number;
  breakerCooldownMs?: number;
  judgeTimeoutMs?: number;
}

/**
 * Reusable text judge: takes a policy + a chunk of text and returns
 * `{ allow, reason }`. Shares the same Anthropic client, verdict cache and
 * circuit breaker shape as the egress judge -- the cache is scoped to text
 * judges (separate instance) so verdicts from request-shaped requests can't
 * satisfy text-shaped ones.
 *
 * Single-threaded Node event loop; no locks. Concurrent calls for the same
 * `(policy, text)` are deduped via the in-flight map.
 */
export class TextJudge {
  private readonly cache: VerdictCache;
  private readonly breaker: CircuitBreaker;
  private readonly inFlight = new Map<string, Promise<JudgeVerdict>>();
  private readonly defaultModel: string;
  private readonly judgeTimeoutMs: number;
  private _client: JudgeClient | undefined;

  constructor(options: TextJudgeOptions = {}) {
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
   * Defer client construction until first call so callers with no judge
   * guardrails never require ANTHROPIC_API_KEY.
   */
  private get client(): JudgeClient {
    if (!this._client) {
      this._client = new AnthropicJudgeClient();
    }
    return this._client;
  }

  /**
   * Evaluate a chunk of text against a policy. Returns `{ allow, reason }`
   * -- `allow: false` means the policy was tripped (or the call failed
   * closed).
   *
   * Cache key is `(policyHash, textHash)`. The caller passes the policy
   * text, not a hash, because callers don't need to track the hash
   * themselves. Editing the policy invalidates prior verdicts automatically.
   */
  async decide(
    policy: string,
    text: string,
    options: { model?: string } = {}
  ): Promise<{ allow: boolean; reason: string }> {
    const policyHash = hashPolicy(policy);
    const cacheKey = VerdictCache.key({
      orgId: "text-judge",
      policyHash,
      // VerdictCache uses `hostname` as its third component but treats it as
      // an opaque string (lowercase + join). Here we pass a sha256 of the
      // (policy, text) pair — the field name is borrowed from the egress
      // judge, not load-bearing here.
      hostname: hashTextJudgeKey(policy, text),
    });

    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { allow: cached.verdict === "allow", reason: cached.reason };
    }

    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      const v = await existing;
      return { allow: v.verdict === "allow", reason: v.reason };
    }

    const pending = this.runJudge(
      policy,
      text,
      policyHash,
      cacheKey,
      options
    ).finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, pending);
    const v = await pending;
    return { allow: v.verdict === "allow", reason: v.reason };
  }

  private async runJudge(
    policy: string,
    text: string,
    policyHash: string,
    cacheKey: string,
    options: { model?: string }
  ): Promise<JudgeVerdict> {
    if (!this.breaker.canProceed(policyHash)) {
      logger.warn("Text judge circuit open -- failing closed", { policyHash });
      return {
        verdict: "deny",
        reason: "Judge unavailable (circuit breaker open); denied",
      };
    }

    const model = options.model ?? this.defaultModel;
    try {
      const verdict = await this.withTimeout(
        this.client.judge({
          model,
          systemPrompt: TEXT_JUDGE_SYSTEM_PROMPT,
          userPrompt: buildUserPrompt(policy, text),
        })
      );
      this.breaker.onSuccess(policyHash);
      this.cache.set(cacheKey, verdict);
      return verdict;
    } catch (err) {
      this.breaker.onFailure(policyHash);
      const timedOut = err instanceof JudgeTimeoutError;
      logger.error(
        timedOut
          ? "Text judge call timed out -- failing closed"
          : "Text judge call failed -- failing closed",
        {
          policyHash,
          model,
          timeoutMs: timedOut ? this.judgeTimeoutMs : undefined,
          error: err instanceof Error ? err.message : String(err),
        }
      );
      return {
        verdict: "deny",
        reason: timedOut
          ? "Judge call timed out; denied"
          : "Judge call failed; denied",
      };
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new JudgeTimeoutError(this.judgeTimeoutMs)),
        this.judgeTimeoutMs
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}
