/**
 * Tests for the guardrails extensions:
 *  - `pii-scan` regex built-in (input, output, pre-tool) + Luhn filter
 *  - `safeStringify` helper (BigInt, circular refs)
 *  - `TextJudge` with a fake LLM client (cache hit, fail closed)
 *  - `createJudgeGuardrail` factory across stages + tool narrowing
 *  - `resolveAgentGuardrails` merge / dedup / exclude semantics
 */

import { describe, expect, test } from "bun:test";
import {
  createNoopGuardrail,
  GuardrailRegistry,
  type SkillConfig,
} from "@lobu/core";
import {
  createJudgeGuardrail,
  createPiiScanGuardrail,
  inlineJudgeHash,
  luhnValid,
  resolveAgentGuardrails,
  safeStringify,
  TextJudge,
} from "../index.js";
import type { JudgeClient, JudgeVerdict } from "../../proxy/egress-judge/types.js";

// --- Helpers ---------------------------------------------------------------

class FakeJudgeClient implements JudgeClient {
  public calls: Array<{ userPrompt: string }> = [];
  constructor(private impl: (userPrompt: string) => JudgeVerdict) {}
  async judge(args: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<JudgeVerdict> {
    this.calls.push({ userPrompt: args.userPrompt });
    return this.impl(args.userPrompt);
  }
}

class ThrowingJudgeClient implements JudgeClient {
  public calls = 0;
  async judge(): Promise<JudgeVerdict> {
    this.calls += 1;
    throw new Error("simulated transport failure");
  }
}

// --- luhnValid -------------------------------------------------------------

describe("luhnValid", () => {
  test("accepts known Luhn-valid test PANs (Visa, MasterCard, Amex)", () => {
    expect(luhnValid("4111111111111111")).toBe(true); // Visa
    expect(luhnValid("4111 1111 1111 1111")).toBe(true); // spaced
    expect(luhnValid("4111-1111-1111-1111")).toBe(true); // hyphenated
    expect(luhnValid("5500000000000004")).toBe(true); // MasterCard
    expect(luhnValid("340000000000009")).toBe(true); // Amex (15 digits)
    expect(luhnValid("6011000000000004")).toBe(true); // Discover
  });

  test("rejects random / sequential 13-19 digit runs", () => {
    expect(luhnValid("1234567890123456")).toBe(false);
    expect(luhnValid("9876543210987654")).toBe(false);
    expect(luhnValid("4111111111111112")).toBe(false); // one digit off
  });

  test("rejects out-of-range lengths", () => {
    expect(luhnValid("1234567890")).toBe(false); // too short
    expect(luhnValid("12345678901234567890")).toBe(false); // 20 digits
  });

  test("rejects non-digit content", () => {
    expect(luhnValid("4111-aaaa-1111-1111")).toBe(false);
  });
});

// --- safeStringify ---------------------------------------------------------

describe("safeStringify", () => {
  test("serializes plain objects normally", () => {
    expect(safeStringify({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
  });

  test("handles BigInt without throwing", () => {
    const out = safeStringify({ id: 10n });
    expect(out).toContain('"10"');
  });

  test("handles circular references without throwing", () => {
    const node: { name: string; self?: unknown } = { name: "root" };
    node.self = node;
    const out = safeStringify(node);
    expect(out).toContain("<circular>");
  });

  test("returns <unserializable> if even JSON.stringify with replacer throws", () => {
    // A getter that throws -- JSON.stringify will surface it.
    const bad = {
      get boom() {
        throw new Error("nope");
      },
    };
    expect(safeStringify(bad)).toBe("<unserializable>");
  });

  // JSON.stringify returns `undefined` (not a string) for top-level
  // non-serializable primitives. Downstream callers `.match()` the result,
  // so safeStringify must hand back a string regardless.
  test("always returns a string for top-level undefined", () => {
    expect(safeStringify(undefined)).toBe("<unserializable>");
  });

  test("always returns a string for top-level function", () => {
    expect(safeStringify(() => 42)).toBe("<unserializable>");
  });

  test("always returns a string for top-level symbol", () => {
    expect(safeStringify(Symbol("x"))).toBe("<unserializable>");
  });

  test("always returns a string for top-level bigint", () => {
    expect(typeof safeStringify(10n)).toBe("string");
  });
});

// --- pii-scan --------------------------------------------------------------

describe("pii-scan builtin", () => {
  test("trips on an email in user input", async () => {
    const g = createPiiScanGuardrail("input");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "telegram",
      message: "please email me at user@example.com",
    });
    expect(r.tripped).toBe(true);
    expect((r.metadata as { kind: string }).kind).toBe("email");
  });

  test("trips on a US phone in output text", async () => {
    const g = createPiiScanGuardrail("output");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "slack",
      text: "Call me at (555) 123-4567 tomorrow",
    });
    expect(r.tripped).toBe(true);
    expect((r.metadata as { kind: string }).kind).toBe("us-phone");
  });

  test("trips on a Luhn-valid credit card in serialized pre-tool args", async () => {
    const g = createPiiScanGuardrail("pre-tool");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      toolName: "stripe.charge",
      arguments: { number: "4111 1111 1111 1111" },
    });
    expect(r.tripped).toBe(true);
    expect((r.metadata as { kind: string }).kind).toBe("credit-card");
  });

  test("does NOT trip on a 16-digit non-Luhn invoice / order number", async () => {
    const g = createPiiScanGuardrail("output");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "slack",
      text: "Order #1234567890123456 shipped",
    });
    expect(r.tripped).toBe(false);
  });

  test("does NOT trip on a long tracking-style 18-digit run", async () => {
    const g = createPiiScanGuardrail("output");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "slack",
      text: "FedEx tracking 123456789012345678",
    });
    expect(r.tripped).toBe(false);
  });

  // Guards against the single-match regression: if the scan stopped at the
  // first 16-digit candidate (Luhn-fails), the trailing real PAN would
  // escape detection. `matchAll` must walk every candidate.
  test("finds a real PAN that follows a non-Luhn 16-digit run", async () => {
    const g = createPiiScanGuardrail("output");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "slack",
      text: "order 1234567890123456 paid with 4111111111111111",
    });
    expect(r.tripped).toBe(true);
    expect((r.metadata as { kind: string }).kind).toBe("credit-card");
  });

  test("finds a Luhn-valid PAN buried mid-text after multiple invoice numbers", async () => {
    const g = createPiiScanGuardrail("pre-tool");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      toolName: "x",
      arguments: {
        note: "invoices: 1111111111111111, 2222222222222222, charge: 5500000000000004",
      },
    });
    expect(r.tripped).toBe(true);
    expect((r.metadata as { kind: string }).kind).toBe("credit-card");
  });

  test("passes on benign text", async () => {
    const g = createPiiScanGuardrail("input");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "telegram",
      message: "hello world, no PII here",
    });
    expect(r.tripped).toBe(false);
  });

  test("does not fire on a 10-digit invoice number", async () => {
    const g = createPiiScanGuardrail("output");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "slack",
      text: "invoice 9876543210 was paid",
    });
    expect(r.tripped).toBe(false);
  });

  test("does not throw on BigInt or circular tool args", async () => {
    const g = createPiiScanGuardrail("pre-tool");
    const node: { name: string; self?: unknown; id: bigint } = {
      name: "root",
      id: 999999999n,
    };
    node.self = node;
    const r = await g.run({
      agentId: "a",
      userId: "u",
      toolName: "weird.tool",
      arguments: node,
    });
    // Arg shape is exotic but contains no PII; must not throw and must not
    // trip on the synthetic <circular> / "999999999" markers.
    expect(r.tripped).toBe(false);
  });
});

// --- TextJudge -------------------------------------------------------------

describe("TextJudge", () => {
  test("returns allow when fake judge allows", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "allow",
      reason: "ok",
    }));
    const judge = new TextJudge({ client: fake });
    const r = await judge.decide("Never reveal PHI.", "Hello there");
    expect(r.allow).toBe(true);
    expect(r.reason).toBe("ok");
    expect(fake.calls.length).toBe(1);
  });

  test("returns deny + reason when fake judge denies", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "deny",
      reason: "mentions competitor",
    }));
    const judge = new TextJudge({ client: fake });
    const r = await judge.decide("No competitors.", "Acme is better");
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("mentions competitor");
  });

  test("verdict cache hits on identical (policy, text)", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "allow",
      reason: "ok",
    }));
    const judge = new TextJudge({ client: fake });
    await judge.decide("p", "t");
    await judge.decide("p", "t");
    await judge.decide("p", "t");
    expect(fake.calls.length).toBe(1);
  });

  test("policy edit invalidates cache (different policyHash)", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "allow",
      reason: "ok",
    }));
    const judge = new TextJudge({ client: fake });
    await judge.decide("p1", "t");
    await judge.decide("p2", "t");
    expect(fake.calls.length).toBe(2);
  });

  test("circuit breaker opens after threshold; subsequent calls fail closed", async () => {
    const throwing = new ThrowingJudgeClient();
    const judge = new TextJudge({
      client: throwing,
      breakerFailureThreshold: 2,
      breakerCooldownMs: 60_000,
    });
    // First two calls fail closed and increment the breaker; vary the text so
    // we don't get a deny cache hit that hides the breaker behavior.
    const r1 = await judge.decide("p", "t1");
    expect(r1.allow).toBe(false);
    const r2 = await judge.decide("p", "t2");
    expect(r2.allow).toBe(false);
    expect(throwing.calls).toBe(2);
    // Third call should short-circuit on the open breaker without hitting
    // the client at all.
    const r3 = await judge.decide("p", "t3");
    expect(r3.allow).toBe(false);
    expect(r3.reason).toMatch(/circuit breaker/i);
    expect(throwing.calls).toBe(2);
  });

  test("includes policy + text in the user prompt", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "allow",
      reason: "",
    }));
    const judge = new TextJudge({ client: fake });
    await judge.decide("MY POLICY", "MY TEXT");
    expect(fake.calls[0]?.userPrompt).toContain("MY POLICY");
    expect(fake.calls[0]?.userPrompt).toContain("MY TEXT");
  });
});

// --- createJudgeGuardrail --------------------------------------------------

describe("createJudgeGuardrail", () => {
  test("output stage trips when judge denies", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "deny",
      reason: "competitor mention",
    }));
    const judge = new TextJudge({ client: fake });
    const g = createJudgeGuardrail("output", "no competitors", { judge });
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "x",
      text: "Acme is better than them",
    });
    expect(r.tripped).toBe(true);
    expect(r.reason).toBe("competitor mention");
  });

  test("pre-tool guardrail respects tools narrowing", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "deny",
      reason: "blocked",
    }));
    const judge = new TextJudge({ client: fake });
    const g = createJudgeGuardrail("pre-tool", "no destructive ops", {
      judge,
      tools: ["github.delete_repo"],
    });
    // Tool not in list -> noop, judge never called.
    const r1 = await g.run({
      agentId: "a",
      userId: "u",
      toolName: "github.list_issues",
      arguments: {},
    });
    expect(r1.tripped).toBe(false);
    expect(fake.calls.length).toBe(0);
    // Tool in list -> judge is consulted, denies.
    const r2 = await g.run({
      agentId: "a",
      userId: "u",
      toolName: "github.delete_repo",
      arguments: { repo: "lobu" },
    });
    expect(r2.tripped).toBe(true);
    expect(fake.calls.length).toBe(1);
  });

  test("pre-tool guardrail safely serializes BigInt args", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "allow",
      reason: "",
    }));
    const judge = new TextJudge({ client: fake });
    const g = createJudgeGuardrail("pre-tool", "policy", { judge });
    const r = await g.run({
      agentId: "a",
      userId: "u",
      toolName: "weird.tool",
      arguments: { id: 999999999999999n },
    });
    expect(r.tripped).toBe(false);
    // Verify the judge actually got called (i.e., extraction didn't throw).
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]?.userPrompt).toContain("999999999999999");
  });

  test("pre-tool guardrail safely serializes circular args", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "allow",
      reason: "",
    }));
    const judge = new TextJudge({ client: fake });
    const g = createJudgeGuardrail("pre-tool", "policy", { judge });
    const node: { name: string; self?: unknown } = { name: "root" };
    node.self = node;
    const r = await g.run({
      agentId: "a",
      userId: "u",
      toolName: "weird.tool",
      arguments: node,
    });
    expect(r.tripped).toBe(false);
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]?.userPrompt).toContain("<circular>");
  });

  test("inline name is inline:<stage>:<hash8>", () => {
    const g = createJudgeGuardrail("input", "policy text");
    expect(g.name).toBe(`inline:input:${inlineJudgeHash("policy text")}`);
  });

  // Tool scope must factor into the hash so the aggregator's name-keyed
  // dedup doesn't collapse two narrowings of the same English policy.
  test("same policy with different tool scopes yields distinct names", () => {
    const g1 = createJudgeGuardrail("pre-tool", "no destructive ops", {
      tools: ["fs.write"],
    });
    const g2 = createJudgeGuardrail("pre-tool", "no destructive ops", {
      tools: ["fs.delete"],
    });
    expect(g1.name).not.toBe(g2.name);
  });

  test("same policy with same tool scope yields the same name (sort-invariant)", () => {
    const g1 = createJudgeGuardrail("pre-tool", "policy", {
      tools: ["a", "b"],
    });
    const g2 = createJudgeGuardrail("pre-tool", "policy", {
      tools: ["b", "a"],
    });
    expect(g1.name).toBe(g2.name);
  });

  test("policy without tools differs from policy with tools", () => {
    const g1 = createJudgeGuardrail("pre-tool", "policy");
    const g2 = createJudgeGuardrail("pre-tool", "policy", { tools: ["x"] });
    expect(g1.name).not.toBe(g2.name);
  });

  test("empty tools array is canonically equal to undefined tools", () => {
    const g1 = createJudgeGuardrail("pre-tool", "policy", { tools: [] });
    const g2 = createJudgeGuardrail("pre-tool", "policy");
    expect(g1.name).toBe(g2.name);
  });
});

// --- resolveAgentGuardrails ------------------------------------------------

describe("resolveAgentGuardrails (aggregator)", () => {
  function setupRegistry(): GuardrailRegistry {
    const reg = new GuardrailRegistry();
    reg.register(createPiiScanGuardrail("input"));
    reg.register(createPiiScanGuardrail("output"));
    reg.register(createPiiScanGuardrail("pre-tool"));
    reg.register(createNoopGuardrail("pre-tool", "secret-scan"));
    reg.register(createNoopGuardrail("input", "prompt-injection"));
    return reg;
  }

  test("merges agent + skill + inline guardrails per stage", () => {
    const reg = setupRegistry();
    const skill: SkillConfig = {
      repo: "x/y",
      name: "github",
      enabled: true,
      guardrails: {
        "pre-tool": [
          { kind: "builtin", name: "secret-scan" },
          {
            kind: "judge",
            policy: "Only allow if branch matches sprint",
            tools: ["github.delete_repo"],
          },
        ],
      },
    };
    const out = resolveAgentGuardrails(
      { guardrails: ["pii-scan", "prompt-injection"] },
      [skill],
      reg,
      {
        inline: [{ stage: "output", judge: "Never mention competitors" }],
      }
    );
    // Agent built-in pii-scan registered for input/output/pre-tool; agent
    // enabled list applied to all stages.
    expect(out.names.input).toContain("pii-scan");
    expect(out.names.input).toContain("prompt-injection");
    expect(out.names.output).toContain("pii-scan");
    // Skill pre-tool: built-in + inline judge
    expect(out.names["pre-tool"]).toContain("pii-scan"); // from agent enabled
    expect(out.names["pre-tool"]).toContain("secret-scan"); // from skill builtin
    expect(
      out.names["pre-tool"].some((n) =>
        n.startsWith("skill:github:inline:pre-tool:")
      )
    ).toBe(true);
    // Agent inline output judge
    expect(out.names.output.some((n) => n.startsWith("inline:output:"))).toBe(
      true
    );
  });

  test("dedup: agent + skill both name secret-scan -> one instance", () => {
    const reg = setupRegistry();
    const skill: SkillConfig = {
      repo: "x/y",
      name: "github",
      enabled: true,
      guardrails: {
        "pre-tool": [{ kind: "builtin", name: "secret-scan" }],
      },
    };
    const out = resolveAgentGuardrails(
      { guardrails: ["secret-scan"] },
      [skill],
      reg
    );
    const occurrences = out.names["pre-tool"].filter(
      (n) => n === "secret-scan"
    );
    expect(occurrences.length).toBe(1);
  });

  test("guardrails_disabled removes a skill-attached builtin", () => {
    const reg = setupRegistry();
    const skill: SkillConfig = {
      repo: "x/y",
      name: "github",
      enabled: true,
      guardrails: {
        "pre-tool": [{ kind: "builtin", name: "secret-scan" }],
      },
    };
    const out = resolveAgentGuardrails({}, [skill], reg, {
      disabled: ["secret-scan"],
    });
    expect(out.names["pre-tool"]).not.toContain("secret-scan");
  });

  test("disabled skills are ignored entirely", () => {
    const reg = setupRegistry();
    const skill: SkillConfig = {
      repo: "x/y",
      name: "github",
      enabled: false,
      guardrails: {
        "pre-tool": [{ kind: "builtin", name: "secret-scan" }],
      },
    };
    const out = resolveAgentGuardrails({}, [skill], reg);
    expect(out.names["pre-tool"]).not.toContain("secret-scan");
  });

  test("unknown skill builtin is skipped (warn only)", () => {
    const reg = setupRegistry();
    const skill: SkillConfig = {
      repo: "x/y",
      name: "github",
      enabled: true,
      guardrails: {
        "pre-tool": [{ kind: "builtin", name: "nonexistent-builtin" }],
      },
    };
    const out = resolveAgentGuardrails({}, [skill], reg);
    expect(out.names["pre-tool"]).toEqual([]);
  });

  test("inline judge name is `inline:<stage>:<hash8>` and survives exclude by name", () => {
    const reg = setupRegistry();
    const policy = "Never say `password`";
    const expectedName = `inline:output:${inlineJudgeHash(policy)}`;
    const out = resolveAgentGuardrails({}, [], reg, {
      inline: [{ stage: "output", judge: policy }],
    });
    expect(out.names.output).toContain(expectedName);

    const excluded = resolveAgentGuardrails({}, [], reg, {
      inline: [{ stage: "output", judge: policy }],
      disabled: [expectedName],
    });
    expect(excluded.names.output).not.toContain(expectedName);
  });

  test("skill inline judges: same policy, different tool scopes -> two distinct guardrails", () => {
    const reg = setupRegistry();
    const policy = "Block destructive ops";
    const skill: SkillConfig = {
      repo: "x/y",
      name: "github",
      enabled: true,
      guardrails: {
        "pre-tool": [
          { kind: "judge", policy, tools: ["fs.write"] },
          { kind: "judge", policy, tools: ["fs.delete"] },
        ],
      },
    };
    const out = resolveAgentGuardrails({}, [skill], reg);
    const skillInlineNames = out.names["pre-tool"].filter((n) =>
      n.startsWith("skill:github:inline:pre-tool:")
    );
    // Hash must factor in `tools` — otherwise the aggregator's name-keyed
    // dedup would collapse these into one entry and silently drop the
    // second tool narrowing.
    expect(skillInlineNames.length).toBe(2);
    expect(new Set(skillInlineNames).size).toBe(2);
  });

  test("agent inline judges: same policy, different tool scopes -> two distinct guardrails", () => {
    const reg = setupRegistry();
    const policy = "Block destructive ops";
    const out = resolveAgentGuardrails({}, [], reg, {
      inline: [
        { stage: "pre-tool", judge: policy, tools: ["fs.write"] },
        { stage: "pre-tool", judge: policy, tools: ["fs.delete"] },
      ],
    });
    const inlineNames = out.names["pre-tool"].filter((n) =>
      n.startsWith("inline:pre-tool:")
    );
    expect(inlineNames.length).toBe(2);
    expect(new Set(inlineNames).size).toBe(2);
  });
});
