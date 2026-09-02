import { describe, expect, test } from "bun:test";
import type { AgentInlineGuardrail } from "@lobu/core";
import {
  egressGuardrailsToPolicyBundle,
  PolicyStore,
} from "../permissions/policy-store.js";

describe("PolicyStore.resolve", () => {
  test("returns undefined when no bundle is set", () => {
    const store = new PolicyStore();
    expect(store.resolve("org-a", "agent-a","api.github.com")).toBeUndefined();
  });

  test("matches an exact domain rule and composes the policy", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: "api.github.com" }],
      judges: { default: "Only allow read-only GET requests." },
    });
    const resolved = store.resolve("org-a", "agent-a","api.github.com");
    expect(resolved).toBeDefined();
    expect(resolved?.judgeName).toBe("default");
    expect(resolved?.policy).toContain("Only allow read-only GET requests.");
  });

  test("matches a wildcard rule", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: ".example.com" }],
      judges: { default: "check" },
    });
    expect(store.resolve("org-a", "agent-a","foo.example.com")).toBeDefined();
    expect(store.resolve("org-a", "agent-a","example.com")).toBeDefined();
    expect(store.resolve("org-a", "agent-a","unrelated.com")).toBeUndefined();
  });

  test("exact match beats wildcard rule", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [
        { domain: ".example.com", judge: "wildcard-policy" },
        { domain: "api.example.com", judge: "exact-policy" },
      ],
      judges: {
        "wildcard-policy": "wildcard",
        "exact-policy": "exact",
      },
    });
    const resolved = store.resolve("org-a", "agent-a","api.example.com");
    expect(resolved?.judgeName).toBe("exact-policy");
  });

  test("longer wildcard beats shorter wildcard", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [
        { domain: ".example.com", judge: "short" },
        { domain: ".api.example.com", judge: "long" },
      ],
      judges: { short: "short", long: "long" },
    });
    expect(store.resolve("org-a", "agent-a","foo.api.example.com")?.judgeName).toBe(
      "long"
    );
  });

  test("resolves a named judge via the `judge` field", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: "x.com", judge: "strict" }],
      judges: { strict: "strict policy", default: "default policy" },
    });
    const resolved = store.resolve("org-a", "agent-a","x.com");
    expect(resolved?.judgeName).toBe("strict");
    expect(resolved?.policy).toContain("strict policy");
  });

  test("resolves the per-judge model when present", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: "x.com" }],
      judges: { default: "skill policy" },
      judgeModels: { default: "model-x" },
    });
    const resolved = store.resolve("org-a", "agent-a","x.com");
    expect(resolved?.policy).toContain("skill policy");
    expect(resolved?.judgeModel).toBe("model-x");
  });

  test("returns undefined (fail closed) when the named judge is missing", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: "x.com", judge: "strict" }],
      judges: {},
    });
    expect(store.resolve("org-a", "agent-a","x.com")).toBeUndefined();
  });

  test("policyHash is stable across resolve calls", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: "x.com" }],
      judges: { default: "p" },
    });
    const a = store.resolve("org-a", "agent-a","x.com")?.policyHash;
    const b = store.resolve("org-a", "agent-a","x.com")?.policyHash;
    expect(a).toBe(b!);
  });

  test("policyHash changes when the policy text changes", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: "x.com" }],
      judges: { default: "first" },
    });
    const a = store.resolve("org-a", "agent-a","x.com")?.policyHash;
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: "x.com" }],
      judges: { default: "second" },
    });
    const b = store.resolve("org-a", "agent-a","x.com")?.policyHash;
    expect(a).not.toBe(b);
  });

  test("clear removes the bundle", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: "x.com" }],
      judges: { default: "p" },
    });
    store.clear("org-a", "agent-a");
    expect(store.resolve("org-a", "agent-a","x.com")).toBeUndefined();
  });
});

describe("egressGuardrailsToPolicyBundle", () => {
  // These ran against `buildPolicyBundle`, an oracle with no production
  // caller, now deleted. The same properties belong to the live builder.
  function guardrail(
    over: Partial<AgentInlineGuardrail> & { name: string }
  ): AgentInlineGuardrail {
    return {
      enabled: true,
      stage: "egress",
      policy: "p",
      ...over,
    } as AgentInlineGuardrail;
  }

  test("returns undefined when no guardrail declares a domain", () => {
    expect(
      egressGuardrailsToPolicyBundle([guardrail({ name: "default" })])
    ).toBeUndefined();
  });

  test("builds a bundle when domains are present", () => {
    const bundle = egressGuardrailsToPolicyBundle([
      guardrail({ name: "default", domains: ["x.com"], model: "openai/m" }),
    ]);
    expect(bundle).toBeDefined();
    expect(bundle?.judgedDomains).toHaveLength(1);
    expect(bundle?.judgeModels?.default).toBe("openai/m");
  });

  test("normalizes domain patterns in rules", () => {
    const bundle = egressGuardrailsToPolicyBundle([
      guardrail({ name: "default", domains: ["*.Example.COM"] }),
    ]);
    expect(bundle?.judgedDomains[0]?.domain).toBe(".example.com");
  });
});
