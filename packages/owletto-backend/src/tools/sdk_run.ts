import { type Static, Type } from "@sinclair/typebox";
import type { Env } from "../index";
import { buildClientSDK, type SDKMode } from "../sandbox/client-sdk";
import { runScript } from "../sandbox/run-script";
import type { ToolContext } from "./registry";

const SCRIPT_FIELDS = {
  script: Type.String({
    description:
      "TypeScript source. Must `export default async (ctx, client) => { ... }`. Use `search` to discover SDK methods.",
    minLength: 1,
    maxLength: 100_000,
  }),
  timeout_ms: Type.Optional(
    Type.Number({
      description: "Wall-clock budget. Default 60000 (max 60000).",
      minimum: 100,
      maximum: 60_000,
    }),
  ),
};

export const RunSchema = Type.Object(SCRIPT_FIELDS);
export const QuerySchema = Type.Object(SCRIPT_FIELDS);
export type RunArgs = Static<typeof RunSchema>;
export type QueryArgs = Static<typeof QuerySchema>;

async function runSandbox(
  mode: SDKMode,
  args: RunArgs,
  env: Env,
  ctx: ToolContext,
): Promise<unknown> {
  const allowCrossOrg = ctx.allowCrossOrg;
  const result = await runScript({
    source: args.script,
    sdk: (abortSignal) => buildClientSDK(ctx, env, { mode, allowCrossOrg, abortSignal }),
    sdkMode: mode,
    allowCrossOrg,
    context: {
      organization_id: ctx.organizationId,
      user_id: ctx.userId,
      mode: mode === "read" ? "query" : "run",
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
  };
}

export const runSdkScript = (args: RunArgs, env: Env, ctx: ToolContext) =>
  runSandbox("full", args, env, ctx);

export const querySdkScript = (args: QueryArgs, env: Env, ctx: ToolContext) =>
  runSandbox("read", args, env, ctx);
