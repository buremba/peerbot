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
          return {
            notified_count: 1,
            event_id: 41,
            url: "/atlas/activity?event=41",
            run_id: 42,
          };
        },
      },
      log: () => undefined,
    } as unknown as ClientSDK;

    const result = await runScript({
      source:
        "export default async (ctx, client) => client.notifications.send({ title: 'Choose a plan', input_schema: { type: 'object', properties: { plan: { enum: ['legacy', 'new'] } }, required: ['plan'] }, behavior_source: { behavior_id: 7, window_id: 9 } });",
      sdk: stubSdk,
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({
      notified_count: 1,
      event_id: 41,
      url: "/atlas/activity?event=41",
      run_id: 42,
    });
    expect(result.sdkCalls).toBe(1);
    expect(captured).toEqual({
      title: "Choose a plan",
      input_schema: {
        type: "object",
        properties: { plan: { enum: ["legacy", "new"] } },
        required: ["plan"],
      },
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

function stubSDK(partial: Partial<ClientSDK> = {}): ClientSDK {
  return { log: () => undefined, ...partial } as ClientSDK;
}

describe("sandbox output budgets", () => {
  it("keeps a return value whose serialized size exactly matches the cap", async () => {
    const result = await runScript({
      source: "export default async () => 'a'.repeat(1048574);",
      sdk: stubSDK(),
    });

    expect(result.success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.returnValue), "utf8")).toBe(1_048_576);
    expect(result.returnTruncated).toBeUndefined();
  });

  it("truncates return values that serialize to over 1 MB instead of failing", async () => {
    const result = await runScript({
      source: "export default async () => 'a'.repeat(1200000);",
      sdk: stubSDK(),
    });

    expect(result.success).toBe(true);
    expect(typeof result.returnValue).toBe("string");
    expect(result.returnValue).toMatch(/^a+\u2026 \[truncated\]$/);
    expect(result.returnTruncated?.dropped_chars).toBeGreaterThan(0);
  });

  it("hard-fails an oversized extracted schema instead of truncating it", async () => {
    const result = await runScript({
      source: [
        "export const input = { type: 'string', description: 'x'.repeat(2000) };",
        "export default async () => undefined;",
      ].join("\n"),
      sdk: stubSDK(),
      extractExport: "input",
      limits: { outputBytes: 1024 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
    expect(result.returnTruncated).toBeUndefined();
  });

  it("keeps leading structure and reports the exact serialized size", async () => {
    const result = await runScript({
      source: [
        "export default async () => {",
        "  const rows = Array.from({ length: 50000 }, (_, i) => ({ id: i, body: 'x'.repeat(60) }));",
        "  return rows;",
        "};",
      ].join("\n"),
      sdk: stubSDK(),
    });

    expect(result.success).toBe(true);
    const kept = result.returnValue as unknown[];
    expect(Array.isArray(kept)).toBe(true);
    expect(kept[0]).toEqual({ id: 0, body: "x".repeat(60) });
    expect(result.returnTruncated?.dropped_elements).toBeGreaterThan(0);
    expect(result.returnTruncated?.kept_bytes).toBe(
      Buffer.byteLength(JSON.stringify(result.returnValue), "utf8"),
    );
  });

  it("reports the exact kept size when an atomic object value cannot fit", async () => {
    const result = await runScript({
      source: [
        "export default async () => {",
        "  const obj = {};",
        "  for (let i = 0; i < 100; i++) obj[String(i).padStart(3, '0')] = 123456789;",
        "  return obj;",
        "};",
      ].join("\n"),
      sdk: stubSDK(),
      limits: { outputBytes: 1024 },
    });

    expect(result.success).toBe(true);
    expect(result.returnTruncated?.dropped_keys).toBeGreaterThan(0);
    expect(result.returnTruncated?.kept_bytes).toBe(
      Buffer.byteLength(JSON.stringify(result.returnValue), "utf8"),
    );
  });

  it("drops console logs past the log cap without failing the run", async () => {
    const result = await runScript({
      source: [
        "export default async () => {",
        "  console.log('x'.repeat(70000));",
        "  console.log('y'.repeat(70000));",
        "  return 'ok';",
        "};",
      ].join("\n"),
      sdk: stubSDK(),
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe("ok");
    expect(result.returnTruncated).toBeUndefined();
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]?.message).toContain("console output truncated");
  });

  it("does not let a large SDK call result evict a small return value", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => ({ rows: "x".repeat(1_200_000) }),
      } as never,
    });
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  const big = await client.entities.list();",
        "  return { count: big.rows.length };",
        "};",
      ].join("\n"),
      sdk,
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({ count: 1_200_000 });
  });

  it("hard-fails and latches an oversized SDK result crossing budget", async () => {
    let hostCalls = 0;
    const sdk = stubSDK({
      entities: {
        list: async () => {
          hostCalls++;
          return { rows: "x".repeat(1_000_000) };
        },
      } as never,
    });
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  for (let i = 0; i < 6; i++) {",
        "    try { await client.entities.list(); } catch (e) {}",
        "  }",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk,
      limits: { crossingBytes: 2_000_000 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
    expect(hostCalls).toBe(2);
  });

  it("rejects an oversized SDK request payload before host work", async () => {
    let hostCalls = 0;
    const sdk = stubSDK({
      entities: {
        list: async () => {
          hostCalls++;
          return [];
        },
      } as never,
    });
    const result = await runScript({
      source:
        "export default async (_ctx, client) => { await client.entities.list({ q: 'x'.repeat(70000) }); return 'done'; };",
      sdk,
      limits: { crossingBytes: 65_536 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
    expect(hostCalls).toBe(0);
  });

  it("caps by serialized bytes, so escaped strings cannot exceed the budget", async () => {
    const result = await runScript({
      source: "export default async () => '\\n'.repeat(700000);",
      sdk: stubSDK(),
    });

    expect(result.success).toBe(true);
    const serialized = Buffer.byteLength(JSON.stringify(result.returnValue), "utf8");
    expect(serialized).toBeLessThanOrEqual(1_048_576);
    expect(result.returnTruncated?.dropped_chars).toBeGreaterThan(0);
    expect(result.returnTruncated?.kept_bytes).toBe(serialized);
  });

  it("hard-fails an interactive return over the crossing budget before parsing", async () => {
    const result = await runScript({
      source: "export default async () => 'x'.repeat(5000000);",
      sdk: stubSDK(),
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
    expect(result.returnTruncated).toBeUndefined();
  });

  it("preserves an own __proto__ key when truncating", async () => {
    const result = await runScript({
      source: [
        "export default async () => JSON.parse('{\"__proto__\":{\"a\":1},\"pad\":\"' + 'x'.repeat(1200000) + '\"}');",
      ].join("\n"),
      sdk: stubSDK(),
    });

    expect(result.success).toBe(true);
    const value = result.returnValue as Record<string, unknown>;
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect((value["__proto__"] as Record<string, unknown>).a).toBe(1);
    expect(result.returnTruncated?.dropped_chars).toBeGreaterThan(0);
  });

  it("does not split a UTF-16 surrogate pair at the string boundary", async () => {
    const result = await runScript({
      source: "export default async () => '😀'.repeat(600000);",
      sdk: stubSDK(),
    });

    expect(result.success).toBe(true);
    const value = result.returnValue as string;
    const suffix = "\u2026 [truncated]";
    const prefix = value.slice(0, -suffix.length);
    expect(value.endsWith(suffix)).toBe(true);
    expect(prefix.endsWith("😀")).toBe(true);
    expect(result.returnTruncated?.dropped_chars).toBe(1_200_000 - prefix.length);
  });

  it("truncates key-heavy objects in linear time", async () => {
    const result = await runScript({
      source: [
        "export default async () => {",
        "  const obj = {};",
        "  for (let i = 0; i < 150000; i++) obj['k' + i] = i;",
        "  return obj;",
        "};",
      ].join("\n"),
      sdk: stubSDK(),
    });

    expect(result.success).toBe(true);
    expect(result.returnTruncated?.dropped_keys).toBeGreaterThan(0);
    expect(result.returnTruncated?.kept_bytes).toBe(
      Buffer.byteLength(JSON.stringify(result.returnValue), "utf8"),
    );
  });

  it("latches console saturation so later SDK work never starts", async () => {
    let hostCalls = 0;
    const sdk = stubSDK({
      entities: {
        list: async () => {
          hostCalls++;
          return [{ ok: true }];
        },
      } as never,
    });
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  console.log('x'.repeat(4200000));",
        "  try { await client.entities.list(); } catch (e) {}",
        "  try { await client.entities.list(); } catch (e) {}",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk,
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
    expect(hostCalls).toBe(0);
  });
});
