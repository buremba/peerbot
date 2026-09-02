/**
 * Judge transport over the shared gateway completion client.
 *
 * Replaces the Anthropic SDK client. Credentials are OPERATOR-owned
 * (`resolveSystemJudgeTarget`), not the tenant's — see that module for why a
 * policy control must not run on the credential of the tenant it polices.
 *
 * Two properties this client must preserve, both security-relevant:
 *
 *  - A misconfiguration is not a fault. An unresolvable target means the
 *    operator has not installed a judge provider. That never recovers on its
 *    own, so it is raised as {@link JudgeConfigurationError} and the runner
 *    fails closed WITHOUT recording a circuit-breaker failure — matching how
 *    the runner already treats "no judge model configured". Counting it would
 *    open the breaker and then attribute every later denial to a transient
 *    outage that never happened.
 *  - The circuit breaker is the retry policy. This passes `maxRetries: 0`;
 *    retrying inside one judge call burns the caller's deadline and delays the
 *    fail-closed deny without changing it.
 */

import {
  GatewayCompletionTimeoutError,
  GatewayCompletionTruncatedError,
  gatewayCompletion,
} from "../../inference/gateway-completion.js";
import { resolveSystemJudgeTarget } from "../../inference/system-judge-target.js";
import { JudgeTimeoutError } from "./judge-utils.js";
import type { JudgeClient, JudgeVerdict } from "./types.js";
import { parseVerdict } from "./verdict-parser.js";

/**
 * The deployment cannot run a judge at all: no operator-keyed provider matches
 * the requested model ref. Permanent until an operator changes configuration,
 * so callers fail closed without touching the circuit breaker.
 */
export class JudgeConfigurationError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "JudgeConfigurationError";
  }
}

/**
 * Output ceiling for a verdict. A verdict is `{verdict, reason}` with the
 * reason capped at one short sentence by the prompt, so this is a backstop
 * against a model that starts narrating, not a tuning knob.
 *
 * It was 256 — what the Anthropic client sent. That did not survive the move
 * to arbitrary OpenAI-compatible providers, because a REASONING model's hidden
 * thinking tokens are charged against `max_tokens` while being excluded from
 * `completion_tokens`. Measured against `gemini/gemini-2.5-flash` with this
 * judge's own prompts: `finish_reason: "length"`, `completion_tokens: 40`, but
 * 252 tokens actually generated against the 256 ceiling — so whether a verdict
 * survived was a coin flip on how much the model thought, and a truncated one
 * fails closed and DENIES legitimate traffic.
 *
 * 1024 clears the observed thinking budget with room to spare while still
 * bounding a runaway. The judge is asked for one sentence; if a model needs
 * more than 1024 tokens to produce it, capping is the correct outcome.
 *
 * Note this bounds an OUTPUT budget, not billing on thinking — a chatty
 * reasoning model costs what it costs; the ceiling only decides whether we get
 * a usable answer for it.
 */
const JUDGE_MAX_TOKENS = 1024;

export class GatewayJudgeClient implements JudgeClient {
  private readonly timeoutMs: number;
  private readonly resolveTarget: typeof resolveSystemJudgeTarget;

  constructor(options?: {
    timeoutMs?: number;
    /** Injection seam for tests; production always uses the real resolver. */
    resolveTarget?: typeof resolveSystemJudgeTarget;
  }) {
    this.timeoutMs = options?.timeoutMs ?? 5000;
    this.resolveTarget = options?.resolveTarget ?? resolveSystemJudgeTarget;
  }

  async judge(args: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<JudgeVerdict> {
    const resolved = await this.resolveTarget(args.model);
    if (!resolved.ok) {
      throw new JudgeConfigurationError(resolved.detail);
    }

    let raw: string;
    try {
      raw = await gatewayCompletion({
        target: resolved.target,
        systemPrompt: args.systemPrompt,
        userPrompt: args.userPrompt,
        timeoutMs: this.timeoutMs,
        maxTokens: JUDGE_MAX_TOKENS,
        // The circuit breaker is the retry policy for a fail-closed control.
        maxRetries: 0,
      });
    } catch (err) {
      // Preserve the runner's timeout-vs-failure log distinction across the
      // transport swap. Unlike the SDK path, the underlying request is really
      // aborted here rather than abandoned to finish unobserved.
      if (err instanceof GatewayCompletionTimeoutError) {
        throw new JudgeTimeoutError(err.timeoutMs);
      }
      // A truncation is this deployment's ceiling, not the upstream's health,
      // so it must not read as a provider fault. Rethrown with the model named
      // because the ceiling only bites for particular (reasoning) models, and
      // that is the first thing an operator needs in order to act.
      if (err instanceof GatewayCompletionTruncatedError) {
        throw new Error(
          `judge model "${args.model}" did not fit the verdict inside the ${JUDGE_MAX_TOKENS}-token ceiling (${err.message}). A reasoning model spends this budget on hidden thinking; use a smaller-thinking model or raise the ceiling.`
        );
      }
      throw err;
    }

    return parseVerdict(raw);
  }
}
