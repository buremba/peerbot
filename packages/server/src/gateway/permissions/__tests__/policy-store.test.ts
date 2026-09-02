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

// ─── egressGuardrailsToPolicyBundle ──────────────────────────────────────────
//
// These assertions used to run against `buildPolicyBundle`, the legacy builder
// that had no production caller and existed only as an oracle. It is deleted;
// the properties it covered (domain normalisation + dedup, skipping empty
// domains, per-judge model mapping) are properties of the LIVE builder, so
// they are asserted on it directly.

describe("egressGuardrailsToPolicyBundle", () => {
  function guardrail(
    over: Partial<AgentInlineGuardrail> & { name: string }
  ): AgentInlineGuardrail {
    return {
      enabled: true,
      stage: "egress",
      policy: "Policy.",
      ...over,
    } as AgentInlineGuardrail;
  }

  test("deduplicates equivalent domain patterns", () => {
    const bundle = egressGuardrailsToPolicyBundle([
      guardrail({ name: "j1", domains: ["*.example.com"] }),
      guardrail({ name: "j2", domains: [".example.com"] }),
    ]);
    // Both normalise to ".example.com".
    expect(bundle!.judgedDomains).toHaveLength(1);
  });

  test("skips empty domain entries", () => {
    const bundle = egressGuardrailsToPolicyBundle([
      guardrail({ name: "j", domains: ["", "api.example.com"] }),
    ]);
    expect(bundle!.judgedDomains).toHaveLength(1);
    expect(bundle!.judgedDomains[0]!.domain).toBe("api.example.com");
  });

  test("carries each guardrail's own model onto its judge", () => {
    const bundle = egressGuardrailsToPolicyBundle([
      guardrail({
        name: "repo",
        domains: [".github.com"],
        model: "openai/gpt-4o-mini",
      }),
    ]);
    expect(bundle!.judgeModels?.repo).toBe("openai/gpt-4o-mini");
  });
});

// ─── egress guardrail → resolved judge rule ──────────────────────────────────
//
// The equivalence test that lived here compared this path against
// `buildPolicyBundle`. That oracle is gone, so the same guarantees are pinned
// as direct assertions on what `PolicyStore.resolve` hands `EgressJudge`.

describe("egressGuardrailsToPolicyBundle — resolution", () => {
  test("resolves to the composed policy, judge name, and per-judge model", () => {
    const org = "org-eq";
    const agent = "agent-eq";
    const host = "api.github.com";

    const guardrail: AgentInlineGuardrail = {
      name: "repo",
      enabled: true,
      stage: "egress",
      policy: "only github",
      domains: [".github.com"],
      model: "openai/gpt-4o-mini",
    };
    const bundle = egressGuardrailsToPolicyBundle([guardrail]);
    expect(bundle).toBeDefined();
    const store = new PolicyStore();
    store.set(org, agent, bundle!);
    const resolved = store.resolve(org, agent, host);

    expect(resolved).toBeDefined();
    expect(resolved!.policy).toBe("only github");
    expect(resolved!.judgeName).toBe("repo");
    expect(resolved!.judgeModel).toBe("openai/gpt-4o-mini");
    // The hash is what keys the verdict cache and the circuit breaker; it must
    // be present and stable for the same (org, agent, judge, policy).
    expect(resolved!.policyHash).toBeTruthy();
    const again = new PolicyStore();
    again.set(org, agent, egressGuardrailsToPolicyBundle([guardrail])!);
    expect(again.resolve(org, agent, host)!.policyHash).toBe(
      resolved!.policyHash
    );
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
