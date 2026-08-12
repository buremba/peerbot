import { type Static, Type } from "@sinclair/typebox";
import { classifyToolError, isRetryable } from "@lobu/core";
import { resolveMaxAccessLevel } from "../auth/tool-access";
import type { Env } from "../index";
import { buildClientSDK, type SDKMode } from "../sandbox/client-sdk";
import { MAX_SCRIPT_TIMEOUT_MS, runScript } from "../sandbox/run-script";
import type { ToolContext } from "./registry";
import { withValidatedArgs } from "./validate-args";

const SCRIPT_FIELDS = {
  script: Type.String({
    description:
      "TypeScript source. Must `export default async (ctx, client) => { ... }` — `ctx` is `{ organization_id, user_id, mode, sleep(ms) }`, where `await ctx.sleep(ms)` provides a bounded, abort-aware 0–30000ms polling delay; unrestricted timer globals are unavailable. `client` is the ClientSDK. The script's return value comes back as `return_value`; return it only for computed results and bounded samples. For bulk data prefer `client.query` / `query_sql` or paginated SDK reads — a return over the output cap is replaced by a `return_value_preview` head and a `return_truncated` report instead of shipping the full set to the model. Use `search_sdk` to discover SDK methods and `ctx.sleep`.",
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
  title: Type.Optional(
    Type.String({
      description:
        'Optional human-friendly heading for this result (e.g. "Company pipeline"). When set, the UI renders it above the execution status.',
      maxLength: 200,
    }),
  ),
};

export const RunSchema = Type.Object({
  ...SCRIPT_FIELDS,
  dry_run: Type.Optional(
    Type.Boolean({
      description:
        "Preview mode. Read SDK calls still execute, but write/admin/external SDK calls are skipped and returned in side_effect_preview. Dry-run validates the SDK method path and access tier, but it does not execute the skipped handler or fully validate that handler's payload shape.",
    }),
  ),
});
export const QuerySchema = Type.Object(SCRIPT_FIELDS);
type RunArgs = Static<typeof RunSchema>;
type QueryArgs = Static<typeof QuerySchema>;

const PublicSideEffectPreviewEntrySchema = Type.Object({
  path: Type.String({ description: "Dotted SDK method path for the proposed action." }),
  access: Type.Union(
    [
      Type.Literal("write"),
      Type.Literal("external"),
      Type.Literal("admin"),
      Type.Literal("unknown"),
    ],
    { description: "Access class of the proposed action." },
  ),
  args: Type.Array(Type.Unknown(), {
    description: "Redacted, bounded arguments for the proposed action.",
  }),
});

/**
 * Public MCP result for `run_sdk` / `query_sdk`.
 *
 * The sandbox internally captures logs, timings, stack traces, org traversal,
 * and a bounded SDK-call trace. The execution and audit pipeline consumes that
 * richer result before the MCP boundary. ChatGPT receives only the requested
 * return value, a concise script error, and (for dry-run) the actions the user
 * is being asked to review.
 */
export const SdkScriptResultSchema = Type.Object({
  title: Type.Optional(
    Type.String({
      description: "The caller-supplied human-friendly heading for this result, echoed back for the UI.",
      maxLength: 200,
    }),
  ),
  success: Type.Boolean({ description: "Whether the script ran to completion." }),
  return_value: Type.Optional(
    Type.Unknown({
      description:
        "The script's default-export return value. Omitted when it exceeded the output cap.",
    }),
  ),
  return_value_preview: Type.Optional(
    Type.String({
      description:
        "UTF-8-safe head of an oversized serialized return value. Rerun with filtering or pagination for the rest.",
    }),
  ),
  return_truncated: Type.Optional(
    Type.Object(
      {
        total_bytes: Type.Integer(),
        kept_bytes: Type.Integer(),
      },
      { description: "Present when return_value_preview is only a partial result." },
    ),
  ),
  error: Type.Optional(
    Type.Object(
      {
        name: Type.String(),
        message: Type.String(),
        code: Type.Optional(Type.String()),
        retryable: Type.Optional(Type.Boolean()),
      },
      { description: "Concise script failure information, without stack traces or internal diagnostics." },
    ),
  ),
  skipped_calls: Type.Integer({
    description: "Number of write/admin/external calls skipped by dry-run.",
  }),
  side_effect_preview: Type.Array(PublicSideEffectPreviewEntrySchema, {
    description: "Proposed write/admin/external calls skipped because dry_run=true.",
  }),
  side_effect_preview_truncated: Type.Optional(
    Type.Object({
      dropped_entries: Type.Integer({ minimum: 1 }),
    }),
  ),
  dry_run: Type.Boolean(),
});

type PublicSideEffectPreviewEntry = Static<typeof PublicSideEffectPreviewEntrySchema>;

function asPublicPreviewEntry(value: unknown): PublicSideEffectPreviewEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.path !== "string" || !Array.isArray(row.args)) return null;
  const access =
    row.access === "write" ||
    row.access === "external" ||
    row.access === "admin" ||
    row.access === "unknown"
      ? row.access
      : "unknown";
  return { path: row.path, access, args: row.args };
}

/**
 * Minimize a rich internal SDK result for the MCP/model boundary. The raw
 * object remains available to executeTool's audit seam before this function is
 * called, so removing diagnostics here does not weaken Lobu's audit trail.
 */
export function toMcpPublicSdkScriptResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const row = result as Record<string, unknown>;
  const preview = Array.isArray(row.side_effect_preview)
    ? row.side_effect_preview
        .map(asPublicPreviewEntry)
        .filter((entry): entry is PublicSideEffectPreviewEntry => entry !== null)
    : [];
  const skippedCalls =
    typeof row.skipped_calls === "number" && Number.isSafeInteger(row.skipped_calls)
      ? Math.max(0, row.skipped_calls)
      : preview.length;

  const out: Record<string, unknown> = {
    success: row.success === true,
    skipped_calls: skippedCalls,
    side_effect_preview: preview,
    dry_run: row.dry_run === true,
  };

  // Echo the caller-supplied heading so MCP App / ChatGPT result cards can
  // render it above status. Documented on the input schema and on
  // SdkScriptResultSchema — dropping it here breaks that contract.
  if (typeof row.title === "string" && row.title.trim()) {
    out.title = row.title.trim();
  }

  if (Object.hasOwn(row, "return_value") && row.return_value !== undefined) {
    out.return_value = row.return_value;
  }
  if (typeof row.return_value_preview === "string") {
    out.return_value_preview = row.return_value_preview;
  }
  if (row.return_truncated && typeof row.return_truncated === "object") {
    const truncated = row.return_truncated as Record<string, unknown>;
    if (
      typeof truncated.total_bytes === "number" &&
      typeof truncated.kept_bytes === "number"
    ) {
      out.return_truncated = {
        total_bytes: truncated.total_bytes,
        kept_bytes: truncated.kept_bytes,
      };
    }
  }

  if (row.error && typeof row.error === "object" && !Array.isArray(row.error)) {
    const error = row.error as Record<string, unknown>;
    if (typeof error.message === "string") {
      out.error = {
        name: typeof error.name === "string" ? error.name : "Error",
        message: error.message,
        ...(typeof error.code === "string" ? { code: error.code } : {}),
        ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
      };
    }
  }

  if (skippedCalls > preview.length) {
    out.side_effect_preview_truncated = { dropped_entries: skippedCalls - preview.length };
  }
  return out;
}

/**
 * Whether the sandbox runs in its skip-and-record path for this call.
 *
 * An eval replay captures whether the agent asks to or not: the sandbox
 * already skips every non-read method under `dryRun` and records it with its
 * arguments (sandbox/run-script.ts), and capture mode is that same path forced
 * by the server from the signed `executionMode` token claim.
 *
 * Capture is OR'd with the agent's own opt-in and never overridden by it — a
 * capture run cannot be talked back into executing by passing
 * `dry_run: false`. Exported so that property is pinned by a test against the
 * real expression rather than a copy of it.
 */
export function resolveSandboxDryRun(args: {
  executionMode?: "live" | "capture" | null;
  sdkMode: SDKMode;
  agentDryRun: boolean;
}): boolean {
  const captureSideEffects = args.executionMode === "capture";
  return captureSideEffects || (args.sdkMode === "full" && args.agentDryRun);
}

/**
 * SDK paths a CAPTURE run still dispatches, because the handler behind them
 * enforces capture itself (see `RunScriptOptions.dryRunDispatchPaths`).
 *
 * `behaviors.completeWindow` is the finalize step the dispatch prompt asks for
 * (watchers/automation.ts). Skipping it would leave every eval replay with no
 * window — which the finalize-nudge reads as "the agent never called run_sdk",
 * costing a second full replay before failing the run with a misleading error.
 * `handleCompleteWindow` reads the same `executionMode` and records the
 * extraction on `runs.dry_run_preview` instead of writing the canvas.
 *
 * Empty for an agent-requested `dry_run` — there, skipping IS the answer.
 */
export const CAPTURE_DISPATCH_PATHS: readonly string[] = [
  "behaviors.completeWindow",
];

async function runSandbox(
  mode: SDKMode,
  args: RunArgs | QueryArgs,
  env: Env,
  ctx: ToolContext,
): Promise<unknown> {
  const allowCrossOrg = ctx.allowCrossOrg;
  const agentDryRun = "dry_run" in args ? args.dry_run === true : false;
  const dryRun = resolveSandboxDryRun({
    executionMode: ctx.executionMode,
    sdkMode: mode,
    agentDryRun,
  });
  const result = await runScript({
    source: args.script,
    sdk: (abortSignal) => buildClientSDK(ctx, env, { mode, allowCrossOrg, abortSignal }),
    sdkMode: mode,
    allowCrossOrg,
    maxAccessLevel: resolveMaxAccessLevel(ctx.memberRole, ctx.scopes),
    dryRun,
    dryRunDispatchPaths:
      ctx.executionMode === "capture" ? CAPTURE_DISPATCH_PATHS : undefined,
    context: {
      organization_id: ctx.organizationId,
      user_id: ctx.userId,
      mode: mode === "read" ? "query_sdk" : "run_sdk",
    },
    limits: args.timeout_ms ? { timeoutMs: args.timeout_ms } : undefined,
  });
  // Attach a structured code/retryable to a script error so the agent can tell a
  // transient upstream failure (worth re-running) from a permanent script fault.
  // run_sdk is never auto-retried by the wrapper (arbitrary side effects), so this
  // is purely advisory.
  const error = result.error
    ? (() => {
        const code = classifyToolError({ message: result.error?.message });
        return { ...result.error, code, retryable: isRetryable(code) };
      })()
    : result.error;
  const title = args.title?.trim() || undefined;
  return {
    ...(title ? { title } : {}),
    success: result.success,
    return_value: result.returnValue,
    return_value_preview: result.returnValuePreview,
    return_truncated: result.returnTruncated,
    logs: result.logs,
    error,
    duration_ms: result.durationMs,
    sdk_calls: result.sdkCalls,
    skipped_calls: result.skippedCalls,
    sdk_call_trace: result.sdkCallTrace,
    side_effect_preview: result.sideEffectPreview,
    sdk_call_trace_truncated:
      result.traceDropped > 0 ? { dropped_entries: result.traceDropped } : undefined,
    // Effective sandbox dry-run, including capture-mode enforcement. Must match
    // the dryRun flag passed to runScript so skipped_calls / side_effect_preview
    // never appear under dry_run:false.
    dry_run: dryRun,
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
