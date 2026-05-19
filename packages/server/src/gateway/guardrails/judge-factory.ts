import { createHash } from "node:crypto";
import type {
  Guardrail,
  GuardrailContext,
  GuardrailStage,
  InputGuardrailContext,
  OutputGuardrailContext,
  PreToolGuardrailContext,
} from "@lobu/core";
import { TextJudge } from "../proxy/egress-judge/text-judge.js";
import { safeStringify } from "./safe-stringify.js";

/**
 * Lazily-constructed singleton TextJudge so multiple judge guardrails share
 * one cache + circuit breaker. Tests can pass a custom judge via
 * {@link createJudgeGuardrail} `options.judge`.
 */
let sharedJudge: TextJudge | undefined;
function getSharedJudge(): TextJudge {
  if (!sharedJudge) sharedJudge = new TextJudge();
  return sharedJudge;
}

/** Reset for tests — clears the shared judge so the next call rebuilds it. */
export function _resetSharedJudgeForTests(): void {
  sharedJudge = undefined;
}

/** Allow tests to inject a fake without going through the singleton. */
export function _setSharedJudgeForTests(judge: TextJudge): void {
  sharedJudge = judge;
}

/**
 * Extract the inspectable text from each stage's context. `pre-tool` has no
 * single text field, so we serialize the tool name + arguments so the judge
 * can reason about it.
 */
function extractText<S extends GuardrailStage>(
  stage: S,
  ctx: GuardrailContext[S]
): string {
  switch (stage) {
    case "input":
      return (ctx as InputGuardrailContext).message;
    case "output":
      return (ctx as OutputGuardrailContext).text;
    case "pre-tool": {
      const c = ctx as PreToolGuardrailContext;
      // safeStringify so BigInt / circular args don't throw — a thrown
      // guardrail is treated as a pass by the runner.
      return `tool: ${c.toolName}\narguments: ${safeStringify(c.arguments)}`;
    }
    default:
      throw new Error(`Unknown guardrail stage: ${String(stage)}`);
  }
}

/**
 * Short stable id for an inline judge — first 8 chars of
 * sha256(policy +"\u001F" + sortedTools.join(",")). Used in the generated `inline:<stage>:<hash8>`
 * name so operators can target it via `guardrails_disabled`.
 *
 * `tools` is part of the hash so two inline judges with the same English
 * policy but different tool scopes (e.g. `["fs.write"]` vs `["fs.delete"]`)
 * get distinct names — otherwise the aggregator's name-keyed dedup would
 * silently drop the second narrowing. Tools are sorted so `["a","b"]` and
 * `["b","a"]` collapse to the same name. Empty / undefined `tools` are
 * canonically equivalent.
 */
export function inlineJudgeHash(
  policy: string,
  tools?: readonly string[]
): string {
  const h = createHash("sha256");
  h.update(policy);
  const normalizedTools =
    tools && tools.length > 0 ? [...tools].sort().join(",") : "";
  // U+001F separator (matches TextJudge's cache hash); won't appear in
  // normal policy or tool-name content.
  h.update("\u001F");
  h.update(normalizedTools);
  return h.digest("hex").slice(0, 8);
}

export interface JudgeGuardrailOptions {
  /**
   * Override the auto-generated `inline:<stage>:<hash8>` name. Used by the
   * aggregator to give skill-provided inline judges a name that survives the
   * dedup pass.
   */
  name?: string;
  /** Override the shared TextJudge — primarily for tests. */
  judge?: TextJudge;
  /** Optional judge model override (per-call). */
  model?: string;
  /**
   * For `pre-tool` only: when set, the guardrail no-ops on tool calls whose
   * `toolName` isn't in this list. Empty / undefined = run on every tool.
   */
  tools?: string[];
}

/**
 * Factory for a {@link Guardrail} backed by the shared {@link TextJudge}.
 *
 * Stage semantics:
 *   - `input`    — judges the user message
 *   - `output`   — judges the worker's text
 *   - `pre-tool` — judges `tool: <name>\narguments: <json>`; optionally
 *                  narrowed by `options.tools`
 *
 * The guardrail trips (`tripped: true`) when the judge returns `allow: false`,
 * with the judge's `reason` surfaced as the trip reason.
 */
export function createJudgeGuardrail<S extends GuardrailStage>(
  stage: S,
  policy: string,
  options: JudgeGuardrailOptions = {}
): Guardrail<S> {
  // See `inlineJudgeHash` for why `tools` factors into the default name.
  // Caller-supplied `options.name` wins (aggregator gives skill-inline
  // judges a stable prefix).
  const name =
    options.name ?? `inline:${stage}:${inlineJudgeHash(policy, options.tools)}`;
  const toolFilter =
    stage === "pre-tool" && options.tools && options.tools.length > 0
      ? new Set(options.tools)
      : null;

  return {
    name,
    stage,
    async run(ctx) {
      if (stage === "pre-tool" && toolFilter) {
        const c = ctx as PreToolGuardrailContext;
        if (!toolFilter.has(c.toolName)) {
          return { tripped: false };
        }
      }
      const judge = options.judge ?? getSharedJudge();
      const text = extractText(stage, ctx);
      const verdict = await judge.decide(policy, text, { model: options.model });
      if (verdict.allow) {
        return { tripped: false };
      }
      return {
        tripped: true,
        reason: verdict.reason,
        metadata: { source: "judge", stage },
      };
    },
  };
}
