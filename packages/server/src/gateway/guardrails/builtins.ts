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
 * Cheap regex patterns. Each is global / case-insensitive where appropriate
 * and is tried in order -- first match trips the guardrail.
 *
 * Credit-card matches are post-filtered through a Luhn check (see
 * {@link luhnValid}) so 13-19 digit invoice / tracking / order numbers don't
 * false-positive. The other two patterns are precise enough on shape alone.
 */
const PII_PATTERNS: ReadonlyArray<{
  kind: string;
  pattern: RegExp;
  /** Optional post-filter; when present, must return true for the match to
   *  be reported. The string passed is the raw regex match. */
  validate?: (raw: string) => boolean;
}> = [
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
  // Credit-card-shaped -- 13-19 digit runs allowing single space/hyphen
  // separators between groups. Validated with Luhn so a long order or
  // tracking number doesn't trip.
  {
    kind: "credit-card",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/,
    validate: (raw) => luhnValid(raw),
  },
];

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
  for (const { kind, pattern, validate } of PII_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    if (validate && !validate(m[0])) continue;
    return { kind, match: m[0] };
  }
  return null;
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
