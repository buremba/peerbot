import { describe, expect, it } from "bun:test";
import { buildClientSDK, CrossOrgAccessDenied } from "../../../sandbox/client-sdk";
import { ctx } from "./_helpers";

const env = {} as never;

describe("cross-org gate", () => {
  it.each([
    ["scoped /mcp/{slug}", { scopedToOrg: true, allowCrossOrg: false }],
    ["PAT auth", { tokenType: "pat" as const, allowCrossOrg: false }],
    ["session auth", { tokenType: "session" as const, allowCrossOrg: false }],
  ])("%s refuses client.org(other)", async (_label, overrides) => {
    const sdk = buildClientSDK(ctx(overrides), env, {
      mode: "full",
      allowCrossOrg: false,
    });
    await expect(sdk.org("acme")).rejects.toBeInstanceOf(CrossOrgAccessDenied);
  });

  it("explicit allowCrossOrg: false overrides a permissive ToolContext", async () => {
    const sdk = buildClientSDK(ctx({}), env, {
      mode: "full",
      allowCrossOrg: false,
    });
    await expect(sdk.org("acme")).rejects.toBeInstanceOf(CrossOrgAccessDenied);
  });

  it("allowCrossOrg: true reaches the membership lookup (which throws OrgNotFound on a missing slug)", async () => {
    const sdk = buildClientSDK(ctx({}), env, {
      mode: "read",
      allowCrossOrg: true,
    });
    let err: unknown;
    try {
      await sdk.org("does-not-exist-xyz");
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(CrossOrgAccessDenied);
  });
});
