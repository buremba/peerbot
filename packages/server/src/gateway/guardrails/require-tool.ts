/**
 * Generic `require-tool` output guardrail.
 *
 * Looks up this turn's `toolsUsed` (stamped by the worker on the terminal
 * completion row) and trips when any of the operator-listed tool names is
 * missing — or not, depending on fail-open / fail-closed.
 *
 * Config lives on `guardrailsInline` with `kind: "require-tool"` and a
 * manual `tools` array (e.g. `["suggest_actions"]`). No model call, no
 * second LLM fill — pure pass/fail policy.
 *
 * Server-side only (not a core built-in registry entry): materialised by
 * the aggregator per agent, same as inline judges.
 */

import type {
  AgentInlineGuardrail,
  Guardrail,
  OutputGuardrailContext,
} from "@lobu/core";

export type RequireToolOnMissing = "fail-closed" | "fail-open";
export type RequireToolOnUnknown = "fail-closed" | "fail-open";

export interface RequireToolOptions {
  name: string;
  /** Tool names that must appear in `ctx.toolsUsed` this turn. */
  tools: readonly string[];
  /**
   * When a required tool is absent from a known toolsUsed list.
   * Default: fail-closed (trip).
   */
  onMissing?: RequireToolOnMissing;
  /**
   * When toolsUsed is undefined (worker didn't stamp it).
   * Default: fail-open (pass) so rolling deploys don't block.
   */
  onUnknown?: RequireToolOnUnknown;
}

export function isRequireToolEntry(
  entry: AgentInlineGuardrail
): entry is AgentInlineGuardrail & { kind: "require-tool" } {
  return entry.kind === "require-tool";
}

/**
 * Materialise a require-tool guardrail. Stage is always `output` — "was this
 * tool called this turn" is only meaningful at the terminal boundary.
 */
export function createRequireToolGuardrail(
  options: RequireToolOptions
): Guardrail<"output"> {
  const required = [
    ...new Set(options.tools.map((t) => t.trim()).filter(Boolean)),
  ];
  const onMissing: RequireToolOnMissing = options.onMissing ?? "fail-closed";
  const onUnknown: RequireToolOnUnknown = options.onUnknown ?? "fail-open";

  return {
    name: options.name,
    stage: "output",
    async run(ctx: OutputGuardrailContext) {
      if (required.length === 0) {
        return { tripped: false, metadata: { requireTool: true, empty: true } };
      }

      if (ctx.toolsUsed === undefined) {
        if (onUnknown === "fail-closed") {
          return {
            tripped: true,
            reason: `Required tool(s) unknown (worker did not report toolsUsed): ${required.join(", ")}`,
            metadata: {
              requireTool: true,
              required,
              toolsUsed: null,
              onUnknown,
            },
          };
        }
        return {
          tripped: false,
          metadata: {
            requireTool: true,
            required,
            toolsUsed: null,
            onUnknown,
            skipped: "unknown",
          },
        };
      }

      const used = new Set(ctx.toolsUsed);
      const missing = required.filter((t) => !used.has(t));
      if (missing.length === 0) {
        return {
          tripped: false,
          metadata: { requireTool: true, required, toolsUsed: [...used] },
        };
      }

      if (onMissing === "fail-open") {
        return {
          tripped: false,
          metadata: {
            requireTool: true,
            required,
            missing,
            toolsUsed: [...used],
            onMissing,
            // Soft miss — operator chose audit-only.
            skipped: "missing",
          },
        };
      }

      return {
        tripped: true,
        reason: `Required tool(s) not called this turn: ${missing.join(", ")}`,
        metadata: {
          requireTool: true,
          required,
          missing,
          toolsUsed: [...used],
          onMissing,
        },
      };
    },
  };
}

/** Build from a validated inline settings entry. */
export function createRequireToolGuardrailFromEntry(
  entry: AgentInlineGuardrail
): Guardrail<"output"> | null {
  if (!isRequireToolEntry(entry)) return null;
  const tools = entry.tools ?? [];
  if (tools.length === 0) return null;
  return createRequireToolGuardrail({
    name: entry.name,
    tools,
    onMissing: entry.onMissing,
    onUnknown: entry.onUnknown,
  });
}
