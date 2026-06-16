import type {
  Guardrail,
  GuardrailContext,
  GuardrailRegistry,
  GuardrailStage,
  InputGuardrailContext,
  OutputGuardrailContext,
  PreToolGuardrailContext,
} from "@lobu/core";
import { safeStringify } from "./safe-stringify.js";

/**
 * Built-in guardrails registered by the gateway at startup. Three primitives:
 *  - `secret-scan`     (output, stage-locked)  — credential-shape regex scan
 *  - `pii-scan`        (any stage)             — emails / phones / Luhn PANs
 *  - `forbidden-tools` (pre-tool, stage-locked) — destructive-tool deny list
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
 * Standard Luhn check on a 13-19 digit string, separators stripped.
 */
export function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/[^\d]/g, "");
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

// -- secret-scan (output, stage-locked) -------------------------------------

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Allow hyphens so prefixed keys (Anthropic `sk-ant-…`, OpenAI `sk-proj-…`)
  // are matched, not truncated at the first hyphen.
  { name: "openai-key", re: /sk-[a-zA-Z0-9-]{20,}/ },
  { name: "github-pat", re: /ghp_[a-zA-Z0-9]{36}/ },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  {
    name: "jwt",
    re: /eyJ[A-Za-z0-9_-]{40,}\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  },
];

const secretScanGuardrail: Guardrail<"output"> = {
  name: "secret-scan",
  stage: "output",
  async run(ctx: OutputGuardrailContext) {
    const text = ctx.text;
    if (!text) return { tripped: false };
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(text)) {
        return {
          tripped: true,
          reason: `Output contains a value that looks like a ${name}`,
          metadata: { pattern: name },
        };
      }
    }
    return { tripped: false };
  },
};

// -- forbidden-tools (pre-tool, stage-locked) -------------------------------

const FORBIDDEN_TOOLS = new Set<string>([
  "delete_repo",
  "delete_branch",
  "drop_table",
]);

const forbiddenToolsGuardrail: Guardrail<"pre-tool"> = {
  name: "forbidden-tools",
  stage: "pre-tool",
  async run(ctx: PreToolGuardrailContext) {
    if (FORBIDDEN_TOOLS.has(ctx.toolName)) {
      return {
        tripped: true,
        // Internal-only reason; proxy MUST surface a generic block message
        // to the worker (leaking specifics is an evasion surface).
        reason: `Tool "${ctx.toolName}" is on the built-in deny list`,
        metadata: { toolName: ctx.toolName },
      };
    }
    return { tripped: false };
  },
};

// -- lookup tables ----------------------------------------------------------

/**
 * Factory map used by the aggregator to instantiate built-ins by name.
 * Stage-locked builtins (secret-scan, forbidden-tools) ignore the stage
 * parameter and return their canonical stage instance cast to the caller's
 * generic; the aggregator only requests them at their natural stage.
 */
export const BUILTIN_GUARDRAIL_FACTORIES: Record<
  string,
  <S extends GuardrailStage>(stage: S, name?: string) => Guardrail<S>
> = {
  "pii-scan": createPiiScanGuardrail,
  "secret-scan": <S extends GuardrailStage>(_stage: S, _name?: string) =>
    secretScanGuardrail as unknown as Guardrail<S>,
  "forbidden-tools": <S extends GuardrailStage>(_stage: S, _name?: string) =>
    forbiddenToolsGuardrail as unknown as Guardrail<S>,
};

/**
 * Register all gateway built-ins on the shared registry exactly once at boot.
 * Duplicate registration is a programmer error (the registry throws).
 */
export function registerBuiltinGuardrails(registry: GuardrailRegistry): void {
  registry.register(secretScanGuardrail);
  registry.register(forbiddenToolsGuardrail);
  registry.register(createPiiScanGuardrail("input"));
  registry.register(createPiiScanGuardrail("output"));
  registry.register(createPiiScanGuardrail("pre-tool"));
}
