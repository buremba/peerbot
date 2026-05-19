import type {
  Guardrail,
  GuardrailContext,
  GuardrailStage,
  InputGuardrailContext,
  OutputGuardrailContext,
  PreToolGuardrailContext,
} from "@lobu/core";

/**
 * Built-in guardrails registered by the gateway at startup. PR A wires these
 * into the {@link GuardrailRegistry}; PR B (this file) defines them.
 */

// ── pii-scan ────────────────────────────────────────────────────────────────

/**
 * Regex patterns the pii-scan guardrail uses. Each pattern is global +
 * case-insensitive where appropriate and is tried in order — first match
 * trips the guardrail.
 *
 * The patterns are intentionally conservative: we'd rather miss a edge case
 * than block on a 14-digit invoice number. Operators who want exhaustive
 * coverage should pair pii-scan with a judge guardrail.
 */
const PII_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  // Email — lowercase RFC-light pattern (case-insensitive flag covers upper).
  {
    kind: "email",
    pattern: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  },
  // US phone — handles (XXX) XXX-XXXX, XXX-XXX-XXXX, XXX.XXX.XXXX, +1 prefix.
  // Anchored with non-digit boundaries so it doesn't fire on long numeric runs.
  {
    kind: "us-phone",
    pattern:
      /(?:^|[^\d])(?:\+?1[-.\s]?)?\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/,
  },
  // Credit-card-shaped — 13–19 digit runs allowing single space/hyphen
  // separators between groups. We don't validate Luhn — that's a defense in
  // depth question for downstream tools; matching shape is sufficient to
  // flag accidental paste.
  {
    kind: "credit-card",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/,
  },
];

function scanForPii(text: string): { kind: string; match: string } | null {
  for (const { kind, pattern } of PII_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      return { kind, match: m[0] };
    }
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
      // when they paste user data into a tool call.
      return JSON.stringify(c.arguments);
    }
    default:
      return "";
  }
}

/**
 * Regex-backed PII scanner. Detects email addresses, US-shaped phone
 * numbers, and 13–19 digit credit-card-shaped runs. Works at every stage —
 * the inspected text differs (user message / agent output / serialized tool
 * args).
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
