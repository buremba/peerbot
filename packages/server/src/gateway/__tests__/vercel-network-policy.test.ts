import { describe, expect, test } from "bun:test";
import { __testOnly } from "../runtime/providers/vercel.js";

const { networkPolicyFromDomains } = __testOnly;

describe("vercel networkPolicyFromDomains — deny subtraction", () => {
  test("no denies: wildcard stays allow-all, lists pass through", () => {
    expect(networkPolicyFromDomains(["*"])).toBe("allow-all");
    expect(networkPolicyFromDomains(["api.example.com"])).toEqual({
      allow: ["api.example.com"],
    });
    expect(networkPolicyFromDomains(undefined)).toBe("deny-all");
    expect(networkPolicyFromDomains([])).toBe("deny-all");
  });

  test("allow-all plus a deny fails closed instead of granting everything", () => {
    // The sandbox policy cannot express "everything except evil.com" —
    // an unbounded allow must not survive a configured deny.
    expect(networkPolicyFromDomains(["*"], ["evil.com"])).toBe("deny-all");
  });

  test("denied entry is subtracted from an explicit allow list", () => {
    expect(
      networkPolicyFromDomains(
        ["api.example.com", "evil.com"],
        ["evil.com"]
      )
    ).toEqual({ allow: ["api.example.com"] });
  });

  test("wildcard deny removes covered allow entries", () => {
    expect(
      networkPolicyFromDomains(
        ["api.example.com", "safe.other.com"],
        [".example.com"]
      )
    ).toEqual({ allow: ["safe.other.com"] });
  });

  test("allow wildcard overlapping a deny is dropped (fail closed)", () => {
    expect(
      networkPolicyFromDomains(["*.evil.com", "ok.com"], ["evil.com"])
    ).toEqual({ allow: ["ok.com"] });
  });

  test("all allows denied collapses to deny-all", () => {
    expect(networkPolicyFromDomains(["evil.com"], ["evil.com"])).toBe(
      "deny-all"
    );
  });

  test("deny matching is case-insensitive", () => {
    // DNS is case-insensitive; a mixed-case deny must still subtract.
    expect(
      networkPolicyFromDomains(["*.example.com"], ["SENSITIVE.EXAMPLE.COM"])
    ).toBe("deny-all");
    expect(
      networkPolicyFromDomains(["API.Example.com", "ok.com"], ["api.example.com"])
    ).toEqual({ allow: ["ok.com"] });
  });
});
