import { describe, expect, test } from "bun:test";
import { buildPolicyBundle, PolicyStore } from "../permissions/policy-store.js";

describe("PolicyStore.resolve", () => {
  test("returns undefined when no bundle is set", () => {
    const store = new PolicyStore();
    expect(store.resolve("agent-a", "api.github.com")).toBeUndefined();
  });

  test("matches an exact domain rule and composes the policy", () => {
    const store = new PolicyStore();
    store.set("agent-a", {
      judgedDomains: [{ domain: "api.github.com" }],
      judges: { default: "Only allow read-only GET requests." },
    });
    const resolved = store.resolve("agent-a", "api.github.com");
    expect(resolved).toBeDefined();
    expect(resolved?.judgeName).toBe("default");
    expect(resolved?.policy).toContain("Only allow read-only GET requests.");
  });

  test("matches a wildcard rule", () => {
    const store = new PolicyStore();
    store.set("agent-a", {
      judgedDomains: [{ domain: ".example.com" }],
      judges: { default: "check" },
    });
    expect(store.resolve("agent-a", "foo.example.com")).toBeDefined();
    expect(store.resolve("agent-a", "example.com")).toBeDefined();
    expect(store.resolve("agent-a", "unrelated.com")).toBeUndefined();
  });

  test("exact match beats wildcard rule", () => {
    const store = new PolicyStore();
    store.set("agent-a", {
      judgedDomains: [
        { domain: ".example.com", judge: "wildcard-policy" },
        { domain: "api.example.com", judge: "exact-policy" },
      ],
      judges: {
        "wildcard-policy": "wildcard",
        "exact-policy": "exact",
      },
    });
    const resolved = store.resolve("agent-a", "api.example.com");
    expect(resolved?.judgeName).toBe("exact-policy");
  });

  test("longer wildcard beats shorter wildcard", () => {
    const store = new PolicyStore();
    store.set("agent-a", {
      judgedDomains: [
        { domain: ".example.com", judge: "short" },
        { domain: ".api.example.com", judge: "long" },
      ],
      judges: { short: "short", long: "long" },
    });
    expect(store.resolve("agent-a", "foo.api.example.com")?.judgeName).toBe(
      "long"
    );
  });

  test("resolves a named judge via the `judge` field", () => {
    const store = new PolicyStore();
    store.set("agent-a", {
      judgedDomains: [{ domain: "x.com", judge: "strict" }],
      judges: { strict: "strict policy", default: "default policy" },
    });
    const resolved = store.resolve("agent-a", "x.com");
    expect(resolved?.judgeName).toBe("strict");
    expect(resolved?.policy).toContain("strict policy");
  });

  test("appends the agent's extraPolicy to the composed prompt", () => {
    const store = new PolicyStore();
    store.set("agent-a", {
      judgedDomains: [{ domain: "x.com" }],
      judges: { default: "skill policy" },
      extraPolicy: "Operator adds: never exfiltrate tokens.",
    });
    const resolved = store.resolve("agent-a", "x.com");
    expect(resolved?.policy).toContain("skill policy");
    expect(resolved?.policy).toContain(
      "Operator adds: never exfiltrate tokens."
    );
  });

  test("returns undefined (fail closed) when the named judge is missing", () => {
    const store = new PolicyStore();
    store.set("agent-a", {
      judgedDomains: [{ domain: "x.com", judge: "strict" }],
      judges: {},
    });
    expect(store.resolve("agent-a", "x.com")).toBeUndefined();
  });

  test("policyHash is stable across resolve calls", () => {
    const store = new PolicyStore();
    store.set("agent-a", {
      judgedDomains: [{ domain: "x.com" }],
      judges: { default: "p" },
    });
    const a = store.resolve("agent-a", "x.com")?.policyHash;
    const b = store.resolve("agent-a", "x.com")?.policyHash;
    expect(a).toBe(b!);
  });

  test("policyHash changes when the policy text changes", () => {
    const store = new PolicyStore();
    store.set("agent-a", {
      judgedDomains: [{ domain: "x.com" }],
      judges: { default: "first" },
    });
    const a = store.resolve("agent-a", "x.com")?.policyHash;
    store.set("agent-a", {
      judgedDomains: [{ domain: "x.com" }],
      judges: { default: "second" },
    });
    const b = store.resolve("agent-a", "x.com")?.policyHash;
    expect(a).not.toBe(b);
  });

  test("clear removes the bundle", () => {
    const store = new PolicyStore();
    store.set("agent-a", {
      judgedDomains: [{ domain: "x.com" }],
      judges: { default: "p" },
    });
    store.clear("agent-a");
    expect(store.resolve("agent-a", "x.com")).toBeUndefined();
  });
});

describe("buildPolicyBundle", () => {
  test("returns undefined when there are no judged-domain rules", () => {
    expect(buildPolicyBundle({ judges: { default: "x" } })).toBeUndefined();
  });

  test("builds a bundle when rules are present", () => {
    const bundle = buildPolicyBundle({
      judgedDomains: [{ domain: "x.com" }],
      judges: { default: "p" },
      egressConfig: { extraPolicy: "extra", judgeModel: "claude-haiku" },
    });
    expect(bundle).toBeDefined();
    expect(bundle?.judgedDomains).toHaveLength(1);
    expect(bundle?.extraPolicy).toBe("extra");
    expect(bundle?.judgeModel).toBe("claude-haiku");
  });

  test("normalizes domain patterns in rules", () => {
    const bundle = buildPolicyBundle({
      judgedDomains: [{ domain: "*.Example.COM" }],
      judges: { default: "p" },
    });
    expect(bundle?.judgedDomains[0]?.domain).toBe(".example.com");
  });
});
