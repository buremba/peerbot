import { describe, expect, it } from "bun:test";
import {
  buildClientSDK,
  enumerateSDKManifest,
} from "../../../sandbox/client-sdk";
import { METHOD_METADATA } from "../../../sandbox/method-metadata";
import { baseCtx, expectReturnValue, runOrSkip, stubSDK } from "./_helpers";

const stubEntitiesList = stubSDK({
  entities: { list: async () => [] } as never,
});

describe("enumerateSDKManifest", () => {
  it("read mode mirrors METHOD_METADATA access classification", () => {
    const read = enumerateSDKManifest("read");
    const full = enumerateSDKManifest("full");
    for (const [path, meta] of Object.entries(METHOD_METADATA)) {
      const dot = path.indexOf(".");
      if (dot === -1) continue;
      const ns = path.slice(0, dot);
      const method = path.slice(dot + 1);
      expect(full.byNamespace[ns]).toContain(method);
      const inRead = read.byNamespace[ns]?.includes(method) ?? false;
      expect(inRead).toBe(meta.access === "read");
    }
  });

  it("includes `org` in topLevel iff allowCrossOrg !== false", () => {
    expect(enumerateSDKManifest("read").topLevel).toContain("org");
    expect(
      enumerateSDKManifest("read", { allowCrossOrg: false }).topLevel,
    ).not.toContain("org");
  });
});

describe("buildClientSDK filter", () => {
  it("read mode strips mutators; full mode keeps them", () => {
    const env = {} as never;
    const read = buildClientSDK(baseCtx, env, { mode: "read" });
    const full = buildClientSDK(baseCtx, env, { mode: "full" });
    const r = read.entities as Record<string, unknown>;
    const f = full.entities as Record<string, unknown>;
    expect(typeof r.list).toBe("function");
    expect(r.delete).toBeUndefined();
    expect(r.create).toBeUndefined();
    expect(typeof f.delete).toBe("function");
    expect(typeof f.create).toBe("function");
    expect((read.knowledge as Record<string, unknown>).save).toBeUndefined();
  });
});

describe("guest-side proxy traps", () => {
  it("absent methods report typeof === 'undefined' and `in` false", async () => {
    const result = await runOrSkip({
      source: [
        "export default async (_ctx, client) => ({",
        '  hasDelete: "delete" in client.entities,',
        "  typeofDelete: typeof client.entities.delete,",
        "  typeofList: typeof client.entities.list,",
        "});",
      ].join("\n"),
      sdk: stubEntitiesList,
      sdkMode: "read",
    });
    expectReturnValue(result, {
      hasDelete: false,
      typeofDelete: "undefined",
      typeofList: "function",
    });
  });

  it("ownKeys returns no duplicates", async () => {
    const result = await runOrSkip({
      source:
        "export default async (_ctx, client) => { const k = Reflect.ownKeys(client); return { dupes: k.length !== new Set(k).size }; };",
      sdk: stubEntitiesList,
      sdkMode: "read",
    });
    expectReturnValue(result, { dupes: false });
  });

  it("client.org is undefined when allowCrossOrg is false", async () => {
    const result = await runOrSkip({
      source:
        'export default async (_ctx, client) => ({ typeofOrg: typeof client.org, hasOrg: "org" in client });',
      sdk: stubEntitiesList,
      sdkMode: "read",
      allowCrossOrg: false,
    });
    expectReturnValue(result, { typeofOrg: "undefined", hasOrg: false });
  });

  it("present read methods dispatch to the host", async () => {
    const sdk = stubSDK({
      entities: { list: async () => [{ id: 1, name: "Acme" }] } as never,
    });
    const result = await runOrSkip({
      source:
        "export default async (_ctx, client) => client.entities.list({ entity_type: 'company' });",
      sdk,
      sdkMode: "read",
    });
    expectReturnValue(result, [{ id: 1, name: "Acme" }]);
  });

  it("calling an absent method surfaces as TypeError", async () => {
    const result = await runOrSkip({
      source:
        "export default async (_ctx, client) => client.entities.delete(42);",
      sdk: stubEntitiesList,
      sdkMode: "read",
    });
    if (!result) return;
    expect(result.success).toBe(false);
    expect(result.error?.message ?? "").toMatch(/not a function|undefined/i);
  });

  it("__sdk_dispatch rejects inherited Object.prototype paths", async () => {
    // Bypassing the proxy via the global dispatch should still fail because
    // the host requires an own-property entry for both ns and method.
    const result = await runOrSkip({
      source: `
        export default async () => {
          try {
            await __sdk_dispatch.apply(undefined, ['entities.constructor', JSON.stringify({ args: [], orgPath: [] })], { result: { promise: true, copy: true } });
            return 'ESCAPED';
          } catch (e) {
            return String(e.message ?? e);
          }
        };
      `,
      sdk: stubEntitiesList,
      sdkMode: "read",
    });
    if (!result) return;
    expect(result.success).toBe(true);
    expect(result.returnValue).not.toBe("ESCAPED");
    expect(String(result.returnValue)).toMatch(/Unknown SDK method/);
  });
});

describe("output cap (1 MB)", () => {
  it("rejects return values that serialize to over 1 MB", async () => {
    const result = await runOrSkip({
      // 1.2 MB of 'a' + JSON quoting trips the cap.
      source: "export default async () => 'a'.repeat(1200000);",
      sdk: stubSDK(),
      sdkMode: "full",
    });
    if (!result) return;
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
  });
});
