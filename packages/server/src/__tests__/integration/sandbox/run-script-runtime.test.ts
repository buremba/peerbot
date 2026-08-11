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
    expect(result.returnValuePreview).toBeUndefined();
    expect(result.returnTruncated).toBeUndefined();
  });

  it("replaces an oversized return with a bounded preview instead of shipping it", async () => {
    const result = await runScript({
      source: "export default async () => 'a'.repeat(1200000);",
      sdk: stubSDK(),
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBeUndefined();
    expect(typeof result.returnValuePreview).toBe("string");
    expect(result.returnValuePreview).toMatch(/^"a+\u2026 \[truncated\]$/);
    expect(result.returnTruncated).toBeDefined();
    expect(result.returnTruncated!.total_bytes).toBeGreaterThan(1_048_576);
    expect(result.returnTruncated!.kept_bytes).toBe(
      Buffer.byteLength(result.returnValuePreview!, "utf8"),
    );
  });

  it("keeps the preview within a lowered output cap", async () => {
    const result = await runScript({
      source: "export default async () => 'a'.repeat(2000);",
      sdk: stubSDK(),
      limits: { outputBytes: 1024 },
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBeUndefined();
    expect(result.returnTruncated!.total_bytes).toBeGreaterThan(
      result.returnTruncated!.kept_bytes,
    );
    expect(
      Buffer.byteLength(result.returnValuePreview!, "utf8"),
    ).toBeLessThanOrEqual(1024);
  });

  it("hard-fails an oversized extracted schema instead of previewing it", async () => {
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
    expect(result.returnValuePreview).toBeUndefined();
  });

  it("previews an oversized array as a text head and reports byte sizes", async () => {
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
    expect(result.returnValue).toBeUndefined();
    const preview = result.returnValuePreview!;
    expect(preview.startsWith("[")).toBe(true);
    expect(result.returnTruncated).toBeDefined();
    expect(result.returnTruncated!.total_bytes).toBeGreaterThan(
      result.returnTruncated!.kept_bytes,
    );
    expect(result.returnTruncated!.kept_bytes).toBe(
      Buffer.byteLength(preview, "utf8"),
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

  it("stops forwarding console calls after the log cap fills", async () => {
    const result = await runScript({
      source: [
        "export default async () => {",
        "  const line = 'x'.repeat(1024);",
        "  for (let i = 0; i < 1000000; i++) console.log(line);",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk: stubSDK(),
      limits: { timeoutMs: 1000 },
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe("done");
    expect(result.logs).toHaveLength(65);
    expect(result.logs.at(-1)?.message).toContain("console output truncated");
  });

  it("terminates a guest that bypasses the saturated console latch", async () => {
    const result = await runScript({
      source: [
        "export default async () => {",
        "  const line = 'x'.repeat(1024);",
        "  for (let i = 0; i < 1000; i++) {",
        "    try { __console_call.applySync(undefined, ['log', line]); } catch (e) {}",
        "  }",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk: stubSDK(),
      limits: { timeoutMs: 5000 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
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

  it("hard-fails a single oversized SDK result message", async () => {
    let hostCalls = 0;
    const sdk = stubSDK({
      entities: {
        list: async () => {
          hostCalls++;
          return { rows: "x".repeat(5_000_000) };
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
      limits: { messageBytes: 65_536 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
    // Only the first result ran host work before the message cap terminated.
    expect(hostCalls).toBe(1);
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
      limits: { messageBytes: 65_536 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
    expect(hostCalls).toBe(0);
  });

  it("hard-fails an interactive return over the message cap before parsing", async () => {
    const result = await runScript({
      source: "export default async () => 'x'.repeat(5000000);",
      sdk: stubSDK(),
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
    expect(result.returnValuePreview).toBeUndefined();
  });

  it("does not split a UTF-16 surrogate pair at the preview boundary", async () => {
    const result = await runScript({
      source: "export default async () => '😀'.repeat(600000);",
      sdk: stubSDK(),
    });

    expect(result.success).toBe(true);
    const preview = result.returnValuePreview!;
    const suffix = "\u2026 [truncated]";
    expect(preview.endsWith(suffix)).toBe(true);
    const prefix = preview.slice(0, -suffix.length);
    expect(prefix.endsWith("😀")).toBe(true);
    for (let i = 0; i < prefix.length; i++) {
      const c = prefix.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = prefix.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
    }
  });

  it("terminates on console output over the message cap before any SDK work", async () => {
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
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk,
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
    expect(hostCalls).toBe(0);
  });

  it("makes quota exhaustion terminal (uncatchable)", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => [{ ok: true }],
      } as never,
    });
    const started = Date.now();
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  for (let i = 0; i < 300; i++) {",
        "    try { await client.entities.list(); } catch (e) {}",
        "  }",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk,
      limits: { sdkCallQuota: 5, timeoutMs: 5000 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("QuotaExceeded");
    // Terminated on quota exhaustion, not left spinning until the timeout.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("terminates a guest that loops dispatch with oversized payloads", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => [{ ok: true }],
      } as never,
    });
    const started = Date.now();
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  while (true) {",
        "    try { await client.entities.list({ big: 'x'.repeat(70000) }); } catch (e) {}",
        "  }",
        "};",
      ].join("\n"),
      sdk,
      limits: { messageBytes: 65_536, timeoutMs: 5000 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
    // Interrupted at the first oversized payload, well under the 5s timeout.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("bounds the SDK call trace and keeps the tail", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => [{ id: 1 }],
      } as never,
    });
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  for (let i = 0; i < 50; i++) {",
        "    await client.entities.list({ big: 'x'.repeat(4000) });",
        "  }",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk,
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe("done");
    const serialized = Buffer.byteLength(
      JSON.stringify(result.sdkCallTrace),
      "utf8",
    );
    expect(serialized).toBeLessThanOrEqual(131_072);
    expect(result.sdkCallTrace.at(-1)?.path).toBe("entities.list");
    expect(result.traceDropped).toBeGreaterThan(0);
  });

  it("keeps the failing call in the tail of a bounded trace", async () => {
    let calls = 0;
    const sdk = stubSDK({
      entities: {
        list: async () => {
          calls++;
          if (calls === 50) throw new Error("boom");
          return [{ id: 1 }];
        },
      } as never,
    });
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  for (let i = 0; i < 50; i++) {",
        "    await client.entities.list({ big: 'x'.repeat(4000) });",
        "  }",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk,
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("ScriptError");
    expect(result.error?.message).toContain("boom");
    // The 50th (failing) call is the last trace entry and survives tail-keep.
    expect(result.sdkCallTrace.at(-1)?.path).toBe("entities.list");
    expect(result.traceDropped).toBeGreaterThan(0);
  });

  it("drops and counts a single trace entry over the cap", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => [],
      } as never,
    });
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  await client.entities.list({ small: 1 });",
        "  await client.entities.list({ big: 'x'.repeat(4000) });",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk,
      limits: { traceBytes: 1024 },
    });

    expect(result.success).toBe(true);
    // The big-arg entry alone exceeds the 1 KB cap -> dropped and counted.
    expect(result.traceDropped).toBeGreaterThan(0);
    // The small entry is retained.
    expect(result.sdkCallTrace.length).toBeGreaterThan(0);
  });

  it("reports the total skipped calls even when the preview truncates", async () => {
    const sdk = stubSDK({
      entities: {
        manage: async () => ({}),
      } as never,
    });
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  for (let i = 0; i < 30; i++) {",
        "    await client.entities.manage({ big: 'x'.repeat(4000) });",
        "  }",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk,
      sdkMode: "full",
      dryRun: true,
      limits: { traceBytes: 4096 },
    });

    expect(result.success).toBe(true);
    // All 30 are skipped; the counter is independent of preview retention.
    expect(result.skippedCalls).toBe(30);
    // The preview is bounded and truncated.
    expect(result.sideEffectPreview.length).toBeLessThan(30);
    expect(result.traceDropped).toBeGreaterThan(0);
  });

  it("omits the truncation marker on a normal run", async () => {
    const result = await runScript({
      source:
        "export default async (_ctx, client) => { await client.entities.list(); return 'ok'; };",
      sdk: stubSDK({
        entities: { list: async () => [] } as never,
      }),
    });

    expect(result.success).toBe(true);
    expect(result.traceDropped).toBe(0);
  });
});
