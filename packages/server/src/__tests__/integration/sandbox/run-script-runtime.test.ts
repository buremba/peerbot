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
import { runScript } from "../../../sandbox/run-script";

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

  it("exposes bounded ctx.sleep without exposing unrestricted timers", async () => {
    const stubSdk = { log: () => undefined } as unknown as ClientSDK;
    const started = Date.now();
    const result = await runScript({
      source:
        "export default async (ctx) => { await ctx.sleep(15); return { timer: typeof setTimeout }; };",
      sdk: stubSdk,
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({ timer: "undefined" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
  });

  it("rejects a sleep longer than the per-call limit", async () => {
    const stubSdk = { log: () => undefined } as unknown as ClientSDK;
    const result = await runScript({
      source: "export default async (ctx) => ctx.sleep(30001);",
      sdk: stubSdk,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("SleepLimitExceeded");
    expect(result.error?.message).toContain("30000ms");
  });

  it("aborts ctx.sleep at the overall script deadline", async () => {
    const stubSdk = { log: () => undefined } as unknown as ClientSDK;
    const started = Date.now();
    const result = await runScript({
      source: "export default async (ctx) => { await ctx.sleep(200); return 'late'; };",
      sdk: stubSdk,
      limits: { timeoutMs: 25 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("TimeoutError");
    expect(Date.now() - started).toBeLessThan(150);
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
        'export default async (_ctx, client) => client.org("atlas").entities.get({ entity_id: 123 });',
      sdk: stubSdk,
      allowCrossOrg: true,
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({ org: "atlas", id: 123 });
    expect(result.sdkCalls).toBe(1);
  });

  it("dispatches client.notifications.send from a reaction script", async () => {
    // Guards the gap fix: before `notifications.send` was added to the SDK +
    // method-metadata, the sandbox proxy wouldn't advertise it and a reaction
    // calling it threw. This proves a reaction can now push a notification.
    let captured: unknown;
    const stubSdk = {
      notifications: {
        send: async (input: unknown) => {
          captured = input;
          return { notified_count: 1 };
        },
      },
      log: () => undefined,
    } as unknown as ClientSDK;

    const result = await runScript({
      source:
        "export default async (ctx, client) => client.notifications.send({ title: 'Digest', body: 'x', behavior_source: { behavior_id: 7, window_id: 9 } });",
      sdk: stubSdk,
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({ notified_count: 1 });
    expect(result.sdkCalls).toBe(1);
    expect(captured).toEqual({
      title: "Digest",
      body: "x",
      behavior_source: { behavior_id: 7, window_id: 9 },
    });
  });

  it("read mode: notification mutations are absent while list is callable", async () => {
    const stubSdk = {
      notifications: {
        list: async () => ({ notifications: [], nextCursor: null }),
      },
      query: async () => [],
      log: () => undefined,
    } as unknown as ClientSDK;

    const listed = await runScript({
      source:
        "export default async (_ctx, client) => client.notifications.list({ unread_only: true });",
      sdk: stubSdk,
      sdkMode: "read",
    });
    expect(listed.success).toBe(true);
    expect(listed.returnValue).toEqual({ notifications: [], nextCursor: null });

    for (const call of [
      "client.notifications.markRead(1)",
      "client.notifications.send({ title: 'x' })",
    ]) {
      const result = await runScript({
        source: `export default async (_ctx, client) => ${call};`,
        sdk: stubSdk,
        sdkMode: "read",
      });

      expect(result.success).toBe(false);
      expect(result.error?.message ?? "").toMatch(/not a function|undefined/i);
      // The mutation must fail guest-side without dispatching to the host.
      expect(result.sdkCalls).toBe(0);
    }
  });

  it("read mode: a genuinely unknown namespace stays undefined (not a false stub)", async () => {
    const stubSdk = {
      query: async () => [],
      log: () => undefined,
    } as unknown as ClientSDK;

    const result = await runScript({
      source:
        "export default async (_ctx, client) => ({ t: typeof client.totallyMadeUp });",
      sdk: stubSdk,
      sdkMode: "read",
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({ t: "undefined" });
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
