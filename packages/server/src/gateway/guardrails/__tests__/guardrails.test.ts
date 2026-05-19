/**
 * Tests for the guardrails extensions in PR B:
 *  - `pii-scan` regex built-in (input, output, pre-tool)
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
  resolveAgentGuardrails,
  TextJudge,
} from "../index.js";
import type { JudgeClient, JudgeVerdict } from "../../proxy/egress-judge/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── pii-scan ──────────────────────────────────────────────────────────────

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

  test("trips on credit-card-shaped run in serialized pre-tool args", async () => {
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

  test("does not fire on a long invoice number (10 digits)", async () => {
    const g = createPiiScanGuardrail("output");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "slack",
      text: "invoice 9876543210 was paid",
    });
    expect(r.tripped).toBe(false);
  });
});

// ─── TextJudge ─────────────────────────────────────────────────────────────

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

// ─── createJudgeGuardrail ──────────────────────────────────────────────────

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

  test("inline name is inline:<stage>:<hash8>", () => {
    const g = createJudgeGuardrail("input", "policy text");
    expect(g.name).toBe(`inline:input:${inlineJudgeHash("policy text")}`);
  });
});

// ─── resolveAgentGuardrails ────────────────────────────────────────────────

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
          { builtin: "secret-scan" },
          {
            tools: ["github.delete_repo"],
            judge: "Only allow if branch matches sprint",
          },
        ],
      },
    };
    const out = resolveAgentGuardrails(
      { guardrails: ["pii-scan", "prompt-injection"] },
      [skill],
      reg,
      {
        inline: [
          { stage: "output", judge: "Never mention competitors" },
        ],
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
    expect(
      out.names.output.some((n) => n.startsWith("inline:output:"))
    ).toBe(true);
  });

  test("dedup: agent + skill both name secret-scan → one instance", () => {
    const reg = setupRegistry();
    const skill: SkillConfig = {
      repo: "x/y",
      name: "github",
      enabled: true,
      guardrails: {
        "pre-tool": [{ builtin: "secret-scan" }],
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
        "pre-tool": [{ builtin: "secret-scan" }],
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
        "pre-tool": [{ builtin: "secret-scan" }],
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
        "pre-tool": [{ builtin: "nonexistent-builtin" }],
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
});
