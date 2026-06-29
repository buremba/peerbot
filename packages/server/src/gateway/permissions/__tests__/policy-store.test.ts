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
 *   - buildPolicyBundle: maps the legacy agent-wide judgeModel onto judges
 *   - set/clear: clear removes the agent's policy
 *   - policyHash: stable between calls for same input
 */

import type { AgentInlineGuardrail } from "@lobu/core";
import { describe, expect, test } from "bun:test";
import {
  buildPolicyBundle,
  egressGuardrailsToPolicyBundle,
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

  test("policyHash differs when the judge policy text changes", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-1", {
      judgedDomains: [{ domain: "api.example.com" }],
      judges: { default: "Base policy A." },
    });
    const hashA = store.resolve("org-1", "agent-1", "api.example.com")!.policyHash;

    store.set("org-1", "agent-1", {
      judgedDomains: [{ domain: "api.example.com" }],
      judges: { default: "Base policy B." },
    });
    const hashB = store.resolve("org-1", "agent-1", "api.example.com")!.policyHash;

    expect(hashA).not.toBe(hashB);
  });

  test("resolve carries the per-judge model", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-1", {
      judgedDomains: [{ domain: "api.example.com" }],
      judges: { default: "Base policy." },
      judgeModels: { default: "model-x" },
    });
    const result = store.resolve("org-1", "agent-1", "api.example.com")!;
    expect(result.judgeModel).toBe("model-x");
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

  test("maps the legacy agent-wide judgeModel onto each named judge", () => {
    const bundle = buildPolicyBundle({
      judgedDomains: [{ domain: "api.example.com" }],
      judges: { default: "Base." },
      egressConfig: { judgeModel: "claude-haiku-4-5-20251001" },
    });
    expect(bundle!.judgeModels?.default).toBe("claude-haiku-4-5-20251001");
  });
});

// ─── egress-guardrail → policy-bundle equivalence (the safety net) ────────────
//
// Proves the NEW source (an `egress`-stage inline guardrail) resolves to the
// SAME `ResolvedJudgeRule` the EgressJudge consumes as the LEGACY
// `network.judged`/`judges`/`egressConfig` source did. Only the bundle SOURCE
// changed; enforcement (PolicyStore.resolve → EgressJudge.decide) is untouched.

describe("egressGuardrailsToPolicyBundle — equivalence with the legacy path", () => {
  test("resolves identically to the old network.judged/judges/judgeModel path", () => {
    const org = "org-eq";
    const agent = "agent-eq";
    const host = "api.github.com";

    // NEW path: a single egress inline guardrail.
    const guardrail: AgentInlineGuardrail = {
      name: "repo",
      enabled: true,
      stage: "egress",
      policy: "only github",
      domains: [".github.com"],
      model: "x",
    };
    const newBundle = egressGuardrailsToPolicyBundle([guardrail]);
    expect(newBundle).toBeDefined();
    const newStore = new PolicyStore();
    newStore.set(org, agent, newBundle!);
    const fromNew = newStore.resolve(org, agent, host);

    // OLD path: the exact inputs the legacy source produced.
    const oldBundle = buildPolicyBundle({
      judgedDomains: [{ domain: ".github.com", judge: "repo" }],
      judges: { repo: "only github" },
      egressConfig: { judgeModel: "x" },
    });
    expect(oldBundle).toBeDefined();
    // Same (org, agent) so the agent-scoped policyHash is comparable; separate
    // store instance so the two bundles don't clobber one another.
    const oldStore = new PolicyStore();
    oldStore.set(org, agent, oldBundle!);
    const fromOld = oldStore.resolve(org, agent, host);

    expect(fromNew).toBeDefined();
    expect(fromOld).toBeDefined();
    // Behaviour-preserving for EgressJudge.decide: identical composed policy,
    // cache-keying hash, judge name, and per-judge model.
    expect(fromNew!.policy).toBe(fromOld!.policy);
    expect(fromNew!.policyHash).toBe(fromOld!.policyHash);
    expect(fromNew!.judgeName).toBe(fromOld!.judgeName);
    expect(fromNew!.judgeModel).toBe(fromOld!.judgeModel);
    expect(fromNew!.judgeModel).toBe("x");
  });

  test("returns undefined when no egress guardrail declares a domain", () => {
    expect(egressGuardrailsToPolicyBundle([])).toBeUndefined();
    expect(
      egressGuardrailsToPolicyBundle([
        {
          name: "no-domains",
          enabled: true,
          stage: "egress",
          policy: "p",
          model: "m",
        },
      ])
    ).toBeUndefined();
    // Disabled / non-egress entries are ignored.
    expect(
      egressGuardrailsToPolicyBundle([
        {
          name: "disabled",
          enabled: false,
          stage: "egress",
          policy: "p",
          domains: [".github.com"],
        },
        {
          name: "wrong-stage",
          enabled: true,
          stage: "pre-tool",
          policy: "p",
          tools: ["bash"],
        },
      ])
    ).toBeUndefined();
  });
});
