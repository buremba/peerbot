import { expect } from "bun:test";
import type { ClientSDK } from "../../../sandbox/client-sdk";
import { runScript, type RunScriptOptions } from "../../../sandbox/run-script";
import type { ToolContext } from "../../../tools/registry";

export const baseCtx: ToolContext = {
  organizationId: "org_test",
  userId: "user_test",
  memberRole: "owner",
  isAuthenticated: true,
  tokenType: "oauth",
  scopedToOrg: false,
  allowCrossOrg: true,
};

export function ctx(overrides: Partial<ToolContext>): ToolContext {
  return { ...baseCtx, ...overrides };
}

export function stubSDK(partial: Partial<ClientSDK> = {}): ClientSDK {
  return { log: () => undefined, ...partial } as ClientSDK;
}

/** Run a script and skip the assertion if isolated-vm isn't loadable here. */
export async function runOrSkip(
  options: RunScriptOptions,
): Promise<Awaited<ReturnType<typeof runScript>> | null> {
  const result = await runScript(options);
  if (result.error?.name === "RuntimeUnavailable") return null;
  return result;
}

export function expectReturnValue<T>(
  result: Awaited<ReturnType<typeof runScript>> | null,
  value: T,
): void {
  if (!result) return;
  expect(result.success).toBe(true);
  expect(result.returnValue).toEqual(value as never);
}
