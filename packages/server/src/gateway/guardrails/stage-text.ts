import type {
  GuardrailContext,
  GuardrailStage,
  InputGuardrailContext,
  OutputGuardrailContext,
  PreToolGuardrailContext,
} from "@lobu/core";
import { safeStringify } from "./safe-stringify.js";

/**
 * Extract the inspectable text from a guardrail stage's context. Shared by the
 * built-in pii-scan and the judge-factory so the two never drift on what gets
 * scanned per stage.
 *
 * `pre-tool` has no single text field, so the tool arguments are serialized.
 * `safeStringify` is used so BigInt / circular tool args don't throw — a
 * thrown guardrail is treated as a pass by the runner, which would silently
 * weaken the check exactly when the input is weird enough to deserve scrutiny.
 *
 * `includeToolName` prefixes the serialized arguments with `tool: <name>` so a
 * judge can reason about which tool is being called (the pii-scan path leaves
 * it off and scans the arguments alone).
 *
 * `throwOnUnknown` controls the (statically unreachable) default branch: the
 * judge path throws — failing open via the runner's error handling rather than
 * silently scanning an empty string — while pii-scan returns "".
 */
export function extractStageText<S extends GuardrailStage>(
  stage: S,
  ctx: GuardrailContext[S],
  options: { includeToolName?: boolean; throwOnUnknown?: boolean } = {}
): string {
  switch (stage) {
    case "input":
      return (ctx as InputGuardrailContext).message;
    case "output":
      return (ctx as OutputGuardrailContext).text;
    case "pre-tool": {
      const c = ctx as PreToolGuardrailContext;
      const args = safeStringify(c.arguments);
      return options.includeToolName
        ? `tool: ${c.toolName}\narguments: ${args}`
        : args;
    }
    case "egress":
      // Egress has no message text — the judge inspects hostname/method/path,
      // not free-form content. This extractor is only used by the
      // message-pipeline scanners (pii-scan / judge-factory), which never run
      // at the egress stage, so an empty string is the correct no-op.
      return "";
    default:
      if (options.throwOnUnknown) {
        throw new Error(`Unknown guardrail stage: ${String(stage)}`);
      }
      return "";
  }
}
