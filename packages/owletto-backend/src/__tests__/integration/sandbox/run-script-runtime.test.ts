/**
 * Sandbox runtime integration test.
 *
 * Asserts that the host runtime can actually load `isolated-vm` and run a
 * script end-to-end. Lives under integration/ and is invoked by the
 * `test:sandbox-runtime` package script — which CI runs under Node, the
 * production runtime.
 *
 * Background: `isolated-vm` is a V8 native addon. Bun (which uses
 * JavaScriptCore with a partial V8 ABI shim) cannot load it; the addon
 * throws at dlopen. The previous bun:test version of this suite hid that
 * gap by skipping when the runner reported `RuntimeUnavailable`. The
 * production app image silently regressed for months as a result.
 *
 * This file deliberately fails (not skips) when the runtime can't load
 * `isolated-vm` so the regression cannot ship again.
 */

import { describe, expect, it } from "vitest";
import type { ClientSDK } from "../../../sandbox/client-sdk";
import { getDefaultLimits, runScript } from "../../../sandbox/run-script";

describe("sandbox runtime", () => {
  it("loads isolated-vm and runs a trivial script", async () => {
    const stubSdk = { log: () => undefined } as unknown as ClientSDK;
    const result = await runScript({
      source: "export default async () => 1 + 2;",
      sdk: stubSdk,
    });
    if (result.error?.name === "RuntimeUnavailable") {
      throw new Error(
        "isolated-vm failed to load under the test runtime. " +
          "Production runs the backend under Node; this test must too. " +
          `Detail: ${result.error.message}`,
      );
    }
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(3);
    expect(result.sdkCalls).toBe(0);
  });

  it("exposes default resource limits", () => {
    const limits = getDefaultLimits();
    expect(limits.memoryMb).toBe(64);
    expect(limits.timeoutMs).toBe(60_000);
    expect(limits.sdkCallQuota).toBe(200);
    expect(limits.outputBytes).toBe(1_048_576);
  });

  it("returns structured result shape", async () => {
    const stubSdk = { log: () => undefined } as unknown as ClientSDK;
    const result = await runScript({
      source: "export default async () => 42;",
      sdk: stubSdk,
    });
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("logs");
    expect(result).toHaveProperty("durationMs");
    expect(result).toHaveProperty("sdkCalls");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("supports direct client.org(slug).namespace.method() chaining", async () => {
    const orgSdk = {
      entities: {
        get: async () => ({ org: "atlas", id: 123 }),
      },
      org: async () => {
        throw new Error("nested org not expected");
      },
      query: async () => [],
      log: () => undefined,
    } as unknown as ClientSDK;
    const stubSdk = {
      org: async (slug: string) => {
        expect(slug).toBe("atlas");
        return orgSdk;
      },
      query: async () => [],
      log: () => undefined,
    } as unknown as ClientSDK;

    const result = await runScript({
      source:
        'export default async (_ctx, client) => client.org("atlas").entities.get({ id: 123 });',
      sdk: stubSdk,
      allowCrossOrg: true,
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({ org: "atlas", id: 123 });
    expect(result.sdkCalls).toBe(1);
  });

  it("enforces wall-clock timeout while awaiting SDK calls", async () => {
    const stubSdk = {
      entities: {
        list: async () =>
          new Promise((resolve) => setTimeout(() => resolve([]), 200)),
      },
      log: () => undefined,
    } as unknown as ClientSDK;

    const result = await runScript({
      source:
        "export default async (_ctx, client) => client.entities.list({ limit: 1 });",
      sdk: stubSdk,
      limits: { timeoutMs: 25 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("TimeoutError");
    expect(result.sdkCalls).toBe(1);
  });
});
