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
 * Built-in guardrails registered by the gateway at startup. PR A wires these
 * into the {@link GuardrailRegistry}; PR B (this file) defines them.
 */

// -- pii-scan ---------------------------------------------------------------

/**
 * Cheap shape patterns for the non-credit-card families. Tried first
 * (cheaper than the Luhn-validated CC scan), in order; first match wins.
 *
 * Credit cards are handled separately by {@link scanCreditCard} because the
 * single-match `.match()` approach has a real bug for multi-PAN text: if a
 * text contains `1234567890123456 ... 4111111111111111`, the first 16-digit
 * run Luhn-fails and the real PAN that follows escapes detection. The CC
 * scan uses `matchAll` to iterate every shaped candidate.
 */
const PII_SHAPE_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  // Email -- lowercase RFC-light pattern (case-insensitive flag covers upper).
  {
    kind: "email",
    pattern: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  },
  // US phone -- handles (XXX) XXX-XXXX, XXX-XXX-XXXX, XXX.XXX.XXXX, +1 prefix.
  // Anchored with non-digit boundaries so it doesn't fire on long numeric runs.
  {
    kind: "us-phone",
    pattern:
      /(?:^|[^\d])(?:\+?1[-.\s]?)?\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/,
  },
];

/**
 * Global regex for candidate credit-card-shaped runs: 13-19 digits with
 * optional single space/hyphen separators. Must be `g`-flagged so `matchAll`
 * walks every candidate, not just the first.
 */
const CC_CANDIDATE_PATTERN = /\b(?:\d[ -]?){12,18}\d\b/g;

/**
 * Find the first Luhn-valid credit-card-shaped run anywhere in the text.
 * Iterates every candidate (not just the first) so a non-Luhn invoice
 * number appearing before a real PAN doesn't shadow it.
 */
function scanCreditCard(text: string): { kind: string; match: string } | null {
  for (const m of text.matchAll(CC_CANDIDATE_PATTERN)) {
    if (luhnValid(m[0])) return { kind: "credit-card", match: m[0] };
  }
  return null;
}

/**
 * Standard Luhn (mod-10) check. Strips spaces / hyphens, then walks digits
 * right-to-left doubling every second one (subtracting 9 if > 9) and verifies
 * the total is divisible by 10. Real credit-card PANs satisfy this; random
 * 13-19 digit runs (invoice numbers, tracking codes, account refs) almost
 * never do.
 *
 * Length must be 13-19 after stripping separators. Returns false otherwise
 * so callers don't have to recheck.
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
    case "pre-tool": {
      const c = ctx as PreToolGuardrailContext;
      // Tool arguments are the high-value target: agents leak PII most often
      // when they paste user data into a tool call. Use safeStringify so a
      // BigInt or circular argument doesn't throw -- a thrown guardrail is
      // treated as a pass by the runner, which would silently weaken
      // pii-scan in exactly the case that produced the weird input.
      return safeStringify(c.arguments);
    }
    default:
      return "";
  }
}

/**
 * Regex-backed PII scanner. Detects email addresses, US-shaped phone
 * numbers, and Luhn-valid 13-19 digit credit-card numbers. Works at every
 * stage -- the inspected text differs (user message / agent output /
 * serialized tool args).
 *
 * The guardrail trips on first pattern match. `metadata.kind` identifies
 * which family matched ("email" | "us-phone" | "credit-card"); the raw
 * match is intentionally not surfaced in the trip reason because the reason
 * is logged and may itself end up in user-facing audit copy.
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
