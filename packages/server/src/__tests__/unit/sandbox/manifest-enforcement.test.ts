/**
 * `__sdk_dispatch` is a guest-visible global; a malicious script can call it
 * directly with an un-manifested method, a poisoned `orgPath`, or a cross-org
 * path the manifest never advertised. The host must re-enforce the manifest,
 * the org-slug guard, and `allowCrossOrg` at dispatch time — regardless of mode.
 */

import { describe, expect, it } from "bun:test";
import type { ClientSDK } from "../../../sandbox/client-sdk";
import { runOrSkip, stubSDK } from "./_helpers";

const DISPATCH = (path: string, args: unknown[], orgPath: string[] = []) =>
  [
    "export default async () => {",
    `  const payload = JSON.stringify({ args: ${JSON.stringify(args)}, orgPath: ${JSON.stringify(orgPath)} });`,
    `  const r = await __sdk_dispatch.apply(undefined, [${JSON.stringify(path)}, payload], { result: { promise: true, copy: true } });`,
    "  return r === undefined ? null : JSON.parse(r);",
    "};",
  ].join("\n");

describe("host-side manifest enforcement on __sdk_dispatch", () => {
  it("rejects an un-manifested write in run_sdk mode even though the SDK exposes it", async () => {
    let called = false;
    const sdk = stubSDK({
      entities: {
        // Not present in METHOD_METADATA → never advertised by the manifest.
        wipeEverything: async () => {
          called = true;
          return { wiped: true };
        },
        list: async () => ({ entities: [] }),
      } as never,
    });
    const result = await runOrSkip({
      source: DISPATCH("entities.wipeEverything", [{}]),
      sdk,
      sdkMode: "full",
    });
    if (!result) return;
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/Unknown SDK method/);
    expect(called).toBe(false);
  });

  it("rejects a __proto__ org slug before calling target.org", async () => {
    let orgCalls = 0;
    const sdk = stubSDK({
      org: async (slug: string): Promise<ClientSDK> => {
        orgCalls += 1;
        return stubSDK({ entities: { list: async () => ({ entities: [] }) } as never, _slug: slug } as never);
      },
      entities: { list: async () => ({ entities: [] }) } as never,
    });
    const result = await runOrSkip({
      source: DISPATCH("entities.list", [{}], ["__proto__"]),
      sdk,
      sdkMode: "full",
      allowCrossOrg: true,
    });
    if (!result) return;
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/Invalid org slug/);
    expect(orgCalls).toBe(0);
  });

  it("rejects a non-empty orgPath when allowCrossOrg is false", async () => {
    let orgCalls = 0;
    const sdk = stubSDK({
      org: async (): Promise<ClientSDK> => {
        orgCalls += 1;
        return stubSDK();
      },
      entities: { list: async () => ({ entities: [] }) } as never,
    });
    const result = await runOrSkip({
      source: DISPATCH("entities.list", [{}], ["other-org"]),
      sdk,
      sdkMode: "full",
      allowCrossOrg: false,
    });
    if (!result) return;
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/CrossOrgAccessDenied/);
    expect(orgCalls).toBe(0);
  });

  it("still allows a manifested call", async () => {
    const sdk = stubSDK({
      entities: { list: async () => ({ entities: [{ id: 1 }] }) } as never,
    });
    const result = await runOrSkip({
      source: DISPATCH("entities.list", [{}]),
      sdk,
      sdkMode: "full",
    });
    if (!result) return;
    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({ entities: [{ id: 1 }] } as never);
  });
});
