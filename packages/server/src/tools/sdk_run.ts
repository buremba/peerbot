import { type Static, Type } from "@sinclair/typebox";
import { resolveMaxAccessLevel } from "../auth/tool-access";
import type { Env } from "../index";
import { buildClientSDK, type SDKMode } from "../sandbox/client-sdk";
import { MAX_SCRIPT_TIMEOUT_MS, runScript } from "../sandbox/run-script";
import type { ToolContext } from "./registry";
import { withValidatedArgs } from "./validate-args";

const SCRIPT_FIELDS = {
  script: Type.String({
    description:
      "TypeScript source. Must `export default async (ctx, client) => { ... }` — `ctx` is `{ organization_id, user_id, mode }`, `client` is the ClientSDK. The script's return value comes back as `return_value` in the result. Use `search_sdk` to discover SDK methods.",
    minLength: 1,
    maxLength: 100_000,
  }),
  timeout_ms: Type.Optional(
    Type.Number({
      description:
        "Wall-clock budget. Default 60000 (max 180000 — device-bound operations may wait ~155s).",
      minimum: 100,
      maximum: MAX_SCRIPT_TIMEOUT_MS,
    }),
  ),
};

export const RunSchema = Type.Object({
  ...SCRIPT_FIELDS,
  dry_run: Type.Optional(
    Type.Boolean({
      description:
        "Preview mode. Read SDK calls still execute, but write/external SDK calls are skipped and returned in side_effect_preview.",
    }),
  ),
});
export const QuerySchema = Type.Object(SCRIPT_FIELDS);
type RunArgs = Static<typeof RunSchema>;
type QueryArgs = Static<typeof QuerySchema>;

const SdkCallTraceEntrySchema = Type.Object({
  path: Type.String({ description: "Dotted SDK method path (e.g. entities.list)." }),
  orgPath: Type.Array(Type.String(), {
    description: "Org slugs traversed via client.org(...) before the call, if any.",
  }),
  access: Type.Union(
    [Type.Literal("read"), Type.Literal("write"), Type.Literal("external"), Type.Literal("unknown")],
    { description: "Access class of the method." },
  ),
  args: Type.Array(Type.Unknown(), { description: "Call arguments (redacted + truncated)." }),
  skipped: Type.Boolean({
    description: "true when dry_run skipped this write/external call.",
  }),
});

/**
 * Result of `run_sdk` / `query_sdk` — mirrors the object assembled in
 * `runSandbox` from `RunScriptResult` (run-script.ts). Advertised as the
 * tools' `outputSchema` so clients know where the script's return value and
 * the dry-run preview land; a runtime mismatch degrades to text-only
 * (`validateToolResult`), never a failed call.
 */
export const SdkScriptResultSchema = Type.Object({
  success: Type.Boolean({ description: "Whether the script ran to completion." }),
  return_value: Type.Optional(
    Type.Unknown({ description: "The script's default-export return value." }),
  ),
  logs: Type.Array(
    Type.Object({
      level: Type.Union([Type.Literal("log"), Type.Literal("warn"), Type.Literal("error")]),
      message: Type.String(),
      data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      ts: Type.Number(),
    }),
    { description: "console.log/warn/error output captured from the script." },
  ),
  error: Type.Optional(
    Type.Object(
      {
        name: Type.String(),
        message: Type.String(),
        stack: Type.Optional(Type.String()),
        line: Type.Optional(Type.Number()),
        column: Type.Optional(Type.Number()),
      },
      { description: "Present when success=false: the thrown error, with script position." },
    ),
  ),
  duration_ms: Type.Number(),
  sdk_calls: Type.Integer({ description: "Number of SDK calls the script made." }),
  sdk_call_trace: Type.Array(SdkCallTraceEntrySchema, {
    description: "Every SDK call the script made, in order.",
  }),
  side_effect_preview: Type.Array(SdkCallTraceEntrySchema, {
    description: "Write/external calls that were skipped because dry_run=true.",
  }),
  dry_run: Type.Boolean(),
});

async function runSandbox(
  mode: SDKMode,
  args: RunArgs | QueryArgs,
  env: Env,
  ctx: ToolContext,
): Promise<unknown> {
  const allowCrossOrg = ctx.allowCrossOrg;
  const result = await runScript({
    source: args.script,
    sdk: (abortSignal) => buildClientSDK(ctx, env, { mode, allowCrossOrg, abortSignal }),
    sdkMode: mode,
    allowCrossOrg,
    maxAccessLevel: resolveMaxAccessLevel(ctx.memberRole, ctx.scopes),
    dryRun: mode === "full" && "dry_run" in args && args.dry_run === true,
    context: {
      organization_id: ctx.organizationId,
      user_id: ctx.userId,
      mode: mode === "read" ? "query_sdk" : "run_sdk",
    },
    limits: args.timeout_ms ? { timeoutMs: args.timeout_ms } : undefined,
  });
  return {
    success: result.success,
    return_value: result.returnValue,
    logs: result.logs,
    error: result.error,
    duration_ms: result.durationMs,
    sdk_calls: result.sdkCalls,
    sdk_call_trace: result.sdkCallTrace,
    side_effect_preview: result.sideEffectPreview,
    dry_run: mode === "full" && "dry_run" in args && args.dry_run === true,
  };
}

export const runSdkScript = withValidatedArgs(
  "run_sdk",
  RunSchema,
  (args: RunArgs, env: Env, ctx: ToolContext) => runSandbox("full", args, env, ctx),
);

export const querySdkScript = withValidatedArgs(
  "query_sdk",
  QuerySchema,
  (args: QueryArgs, env: Env, ctx: ToolContext) => runSandbox("read", args, env, ctx),
);
