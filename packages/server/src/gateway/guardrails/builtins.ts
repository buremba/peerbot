import type {
  Guardrail,
  GuardrailContext,
  GuardrailStage,
  InputGuardrailContext,
  OutputGuardrailContext,
  PreToolGuardrailContext,
} from "@lobu/core";
import { safeStringify } from "./safe-stringify.js";

/**
 * Built-in guardrails registered by the gateway at startup.
 */

// -- pii-scan ---------------------------------------------------------------

/**
 * Cheap shape patterns tried first; first match wins. Credit cards are
 * handled separately by `scanCreditCard` because we need `matchAll` to
 * iterate every candidate — a non-Luhn invoice number appearing before a
 * real PAN would otherwise shadow it.
 */
const PII_SHAPE_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  {
    kind: "email",
    pattern: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  },
  // Anchored with non-digit boundaries so it doesn't fire on long numeric runs.
  {
    kind: "us-phone",
    pattern:
      /(?:^|[^\d])(?:\+?1[-.\s]?)?\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/,
  },
];

/**
 * Candidate credit-card-shaped runs: 13-19 digits with optional single
 * space/hyphen separators. `g`-flagged for `matchAll`.
 */
const CC_CANDIDATE_PATTERN = /\b(?:\d[ -]?){12,18}\d\b/g;

function scanCreditCard(text: string): { kind: string; match: string } | null {
  for (const m of text.matchAll(CC_CANDIDATE_PATTERN)) {
    if (luhnValid(m[0])) return { kind: "credit-card", match: m[0] };
  }
  return null;
}

/**
 * Standard Luhn (mod-10) check. Strips spaces/hyphens, requires 13-19
 * digits, then walks right-to-left doubling every second digit. Real PANs
 * satisfy this; random 13-19 digit runs (invoice/tracking numbers) almost
 * never do.
 */
export function luhnValid(raw: string): boolean {
  const digits = raw.replace(/[ -]/g, "");
  if (!/^\d+$/.test(digits)) return false;
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits.charCodeAt(i) - 48; // '0' = 48
    let v = d;
    if (alt) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function scanForPii(text: string): { kind: string; match: string } | null {
  for (const { kind, pattern } of PII_SHAPE_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { kind, match: m[0] };
  }
  return scanCreditCard(text);
}

function extractTextForPii<S extends GuardrailStage>(
  stage: S,
  ctx: GuardrailContext[S]
): string {
  switch (stage) {
    case "input":
      return (ctx as InputGuardrailContext).message;
    case "output":
      return (ctx as OutputGuardrailContext).text;
    case "pre-tool":
      // safeStringify so BigInt / circular tool args don't throw — a thrown
      // guardrail is treated as a pass by the runner, which silently weakens
      // pii-scan exactly when the input is weird enough to deserve scrutiny.
      return safeStringify((ctx as PreToolGuardrailContext).arguments);
    default:
      return "";
  }
}

/**
 * Regex-backed PII scanner: emails, US-shaped phones, Luhn-valid 13-19
 * digit credit-card numbers. Trips on first pattern match. `metadata.kind`
 * identifies the family; the raw match is intentionally not surfaced in the
 * trip reason since it may end up in user-facing audit copy.
 */
export function createPiiScanGuardrail<S extends GuardrailStage>(
  stage: S,
  name = "pii-scan"
): Guardrail<S> {
  return {
    name,
    stage,
    async run(ctx) {
      const text = extractTextForPii(stage, ctx);
      const hit = scanForPii(text);
      if (!hit) return { tripped: false };
      return {
        tripped: true,
        reason: `Potential PII detected (${hit.kind})`,
        metadata: { kind: hit.kind },
      };
    },
  };
}

/**
 * Names of all built-in guardrail factories exported here. Lookup table for
 * the aggregator when a skill or agent references a builtin by name.
 */
export const BUILTIN_GUARDRAIL_FACTORIES: Record<
  string,
  <S extends GuardrailStage>(stage: S, name?: string) => Guardrail<S>
> = {
  "pii-scan": createPiiScanGuardrail,
};
