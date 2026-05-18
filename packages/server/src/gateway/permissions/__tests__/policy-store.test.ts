/**
 * PolicyStore and buildPolicyBundle hardening tests
 *
 * Covers:
 *   - resolve: returns undefined for unknown agent
 *   - resolve: exact domain match wins over wildcard
 *   - resolve: wildcard pattern matches subdomain
 *   - resolve: longer wildcard beats shorter wildcard
 *   - resolve: returns undefined when no judged domains registered
 *   - resolve: returns undefined when hostname not matched by any rule
 *   - resolve: returns undefined when named judge is missing (fails closed)
 *   - buildPolicyBundle: deduplicates equivalent domain patterns
 *   - buildPolicyBundle: returns undefined when no judged domains
 *   - buildPolicyBundle: appends extraPolicy to each judge
 *   - set/clear: clear removes the agent's policy
 *   - policyHash: stable between calls for same input
 *   - policyHash: changes when extraPolicy changes (cache key discipline)
 */

import { describe, expect, test } from "bun:test";
import {
  buildPolicyBundle,
  PolicyStore,
} from "../policy-store.js";

// ─── PolicyStore.resolve ──────────────────────────────────────────────────────

describe("PolicyStore.resolve", () => {
  test("returns undefined for unknown agent", () => {
    const store = new PolicyStore();
    expect(store.resolve("org-1", "unknown-agent", "example.com")).toBeUndefined();
  });

  test("returns undefined when agent has no judged domains", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-1", {
      judgedDomains: [],
      judges: { default: "Allow reads only." },
    });
    expect(store.resolve("org-1", "agent-1", "example.com")).toBeUndefined();
  });

  test("returns undefined when hostname does not match any rule", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-1", {
      judgedDomains: [{ domain: "api.example.com" }],
      judges: { default: "Allow reads only." },
    });
    expect(store.resolve("org-1", "agent-1", "other.com")).toBeUndefined();
  });

  test("exact domain match returns the resolved rule", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-1", {
      judgedDomains: [{ domain: "api.example.com" }],
      judges: { default: "Allow reads only." },
    });
    const result = store.resolve("org-1", "agent-1", "api.example.com");
    expect(result).not.toBeUndefined();
    expect(result!.judgeName).toBe("default");
    expect(result!.policy).toBe("Allow reads only.");
  });

  test("exact match takes priority over wildcard", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-1", {
      judgedDomains: [
        { domain: ".example.com", judge: "wildcard-judge" },
        { domain: "api.example.com", judge: "exact-judge" },
      ],
      judges: {
        "wildcard-judge": "Wildcard policy.",
        "exact-judge": "Exact policy.",
      },
    });
    const result = store.resolve("org-1", "agent-1", "api.example.com");
    expect(result!.judgeName).toBe("exact-judge");
    expect(result!.policy).toBe("Exact policy.");
  });

  test("wildcard .example.com matches sub.example.com", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-1", {
      judgedDomains: [{ domain: ".example.com" }],
      judges: { default: "Wildcard policy." },
    });
    const result = store.resolve("org-1", "agent-1", "sub.example.com");
    expect(result).not.toBeUndefined();
    expect(result!.policy).toBe("Wildcard policy.");
  });

  test("wildcard .example.com matches example.com root", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-1", {
      judgedDomains: [{ domain: ".example.com" }],
      judges: { default: "Root wildcard policy." },
    });
    const result = store.resolve("org-1", "agent-1", "example.com");
    expect(result).not.toBeUndefined();
  });

  test("longer wildcard beats shorter wildcard", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-1", {
      judgedDomains: [
        { domain: ".example.com", judge: "short" },
        { domain: ".api.example.com", judge: "long" },
      ],
      judges: {
        short: "Short wildcard.",
        long: "Long wildcard.",
      },
    });
    // ".api.example.com" is longer and should match "v2.api.example.com"
    const result = store.resolve("org-1", "agent-1", "v2.api.example.com");
    expect(result!.judgeName).toBe("long");
  });

  test("wildcard does not match unrelated domain", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-1", {
      judgedDomains: [{ domain: ".example.com" }],
      judges: { default: "Example only." },
    });
    expect(store.resolve("org-1", "agent-1", "evil.com")).toBeUndefined();
    expect(store.resolve("org-1", "agent-1", "notexample.com")).toBeUndefined();
  });

  test("named judge missing → undefined (fails closed)", () => {
    // Rule references a judge name not in the judges map.
    const store = new PolicyStore();
    store.set("org-1", "agent-1", {
      judgedDomains: [{ domain: "api.example.com", judge: "missing-judge" }],
      judges: { default: "Default judge." }, // 'missing-judge' is absent
    });
    // Should return undefined rather than crash or use the wrong judge.
    const result = store.resolve("org-1", "agent-1", "api.example.com");
    expect(result).toBeUndefined();
  });

  test("default judge name used when rule omits judge field", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-1", {
      judgedDomains: [{ domain: "api.example.com" }], // no judge field
      judges: { default: "Default judge text." },
    });
    const result = store.resolve("org-1", "agent-1", "api.example.com");
    expect(result!.judgeName).toBe("default");
  });

  test("clear removes agent policy — resolve returns undefined afterwards", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-1", {
      judgedDomains: [{ domain: "api.example.com" }],
      judges: { default: "Allow." },
    });
    expect(store.resolve("org-1", "agent-1", "api.example.com")).not.toBeUndefined();
    store.clear("org-1", "agent-1");
    expect(store.resolve("org-1", "agent-1", "api.example.com")).toBeUndefined();
  });
});

// ─── PolicyStore policyHash stability ────────────────────────────────────────

describe("PolicyStore — policyHash", () => {
  test("policyHash is stable for same agent/judge/policy", () => {
    const store = new PolicyStore();
    const bundle = {
      judgedDomains: [{ domain: "api.example.com" }],
      judges: { default: "Allow only GET." },
    };
    store.set("org-1", "agent-1", bundle);
    const h1 = store.resolve("org-1", "agent-1", "api.example.com")!.policyHash;

    // Re-set with same bundle (simulates reload).
    store.set("org-1", "agent-1", bundle);
    const h2 = store.resolve("org-1", "agent-1", "api.example.com")!.policyHash;

    expect(h1).toBe(h2);
  });

  test("policyHash differs when extraPolicy changes", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-1", {
      judgedDomains: [{ domain: "api.example.com" }],
      judges: { default: "Base policy." },
      extraPolicy: "Extra A.",
    });
    const hashA = store.resolve("org-1", "agent-1", "api.example.com")!.policyHash;

    store.set("org-1", "agent-1", {
      judgedDomains: [{ domain: "api.example.com" }],
      judges: { default: "Base policy." },
      extraPolicy: "Extra B.",
    });
    const hashB = store.resolve("org-1", "agent-1", "api.example.com")!.policyHash;

    expect(hashA).not.toBe(hashB);
  });

  test("extraPolicy is appended to composed policy text", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-1", {
      judgedDomains: [{ domain: "api.example.com" }],
      judges: { default: "Base policy." },
      extraPolicy: "Additional constraint.",
    });
    const result = store.resolve("org-1", "agent-1", "api.example.com")!;
    expect(result.policy).toContain("Base policy.");
    expect(result.policy).toContain("Additional constraint.");
  });
});

// ─── buildPolicyBundle ────────────────────────────────────────────────────────

describe("buildPolicyBundle", () => {
  test("returns undefined when no judged domains", () => {
    expect(buildPolicyBundle({ judgedDomains: [] })).toBeUndefined();
    expect(buildPolicyBundle({})).toBeUndefined();
  });

  test("returns a bundle when at least one judged domain exists", () => {
    const bundle = buildPolicyBundle({
      judgedDomains: [{ domain: "api.example.com" }],
      judges: { default: "Policy." },
    });
    expect(bundle).not.toBeUndefined();
    expect(bundle!.judgedDomains).toHaveLength(1);
  });

  test("deduplicates equivalent domain patterns (last wins)", () => {
    const bundle = buildPolicyBundle({
      judgedDomains: [
        { domain: "*.example.com", judge: "j1" },
        { domain: ".example.com", judge: "j2" }, // same normalized form
      ],
      judges: { j1: "First.", j2: "Second." },
    });
    // Both normalize to ".example.com", so only one remains.
    expect(bundle!.judgedDomains).toHaveLength(1);
    // Last declaration wins — judge should be j2.
    expect(bundle!.judgedDomains[0]!.judge).toBe("j2");
  });

  test("skips rules with falsy domain", () => {
    const bundle = buildPolicyBundle({
      judgedDomains: [
        { domain: "" },
        { domain: "api.example.com" },
      ],
      judges: { default: "Policy." },
    });
    // Only the non-empty domain should appear.
    expect(bundle!.judgedDomains).toHaveLength(1);
    expect(bundle!.judgedDomains[0]!.domain).toBe("api.example.com");
  });

  test("carries extraPolicy from egressConfig", () => {
    const bundle = buildPolicyBundle({
      judgedDomains: [{ domain: "api.example.com" }],
      judges: { default: "Base." },
      egressConfig: { extraPolicy: "Never leak tokens." },
    });
    expect(bundle!.extraPolicy).toBe("Never leak tokens.");
  });

  test("carries judgeModel from egressConfig", () => {
    const bundle = buildPolicyBundle({
      judgedDomains: [{ domain: "api.example.com" }],
      judges: { default: "Base." },
      egressConfig: { judgeModel: "claude-haiku-4-5-20251001" },
    });
    expect(bundle!.judgeModel).toBe("claude-haiku-4-5-20251001");
  });
});
