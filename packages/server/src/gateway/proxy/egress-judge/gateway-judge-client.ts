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
 * Output ceiling for a verdict. A verdict is `{verdict, reason}` with the reason
 * capped at one short sentence by the prompt, so this is a backstop against a
 * model that starts narrating, not a tuning knob. Matches what the Anthropic
 * client sent.
 */
const JUDGE_MAX_TOKENS = 256;

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
      throw err;
    }

    return parseVerdict(raw);
  }
}
