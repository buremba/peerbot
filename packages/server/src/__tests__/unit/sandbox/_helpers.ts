import { expect } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { ClientSDK } from "../../../sandbox/client-sdk";
import { METHOD_METADATA } from "../../../sandbox/method-metadata";
import { runScript, type RunScriptOptions } from "../../../sandbox/run-script";
import { createValidatedSdkMethod } from "../../../sandbox/sdk-preflight";
import type { ToolContext } from "../../../tools/registry";
import { withValidatedArgs } from "../../../tools/validate-args";

const StubArgsSchema = Type.Object({ args: Type.Array(Type.Unknown()) });

function createTestSdkMethod(
  path: string,
  method: (...args: unknown[]) => unknown,
): (...args: unknown[]) => Promise<unknown> {
  const handler = withValidatedArgs(
    `test.${path}`,
    StubArgsSchema,
    async ({ args }) => method(...args),
  );
  return createValidatedSdkMethod(handler, [], {
    path,
    prepareArgs: (...args) => ({ args }),
    projectArgs: (validated) =>
      (validated as { args: unknown[] }).args,
  });
}

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
  for (const [namespaceName, namespace] of Object.entries(partial)) {
    if (!namespace || typeof namespace !== "object") continue;
    for (const [methodName, method] of Object.entries(namespace)) {
      const metadata = METHOD_METADATA[`${namespaceName}.${methodName}`];
      if (!metadata || metadata.access === "read" || typeof method !== "function") {
        continue;
      }
      (namespace as Record<string, unknown>)[methodName] = createTestSdkMethod(
        `${namespaceName}.${methodName}`,
        method as (...args: unknown[]) => unknown,
      );
    }
  }
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
