import { describe, expect, it } from "bun:test";
import { runGuardrailInstances } from "../guardrails/runner";
import type { Guardrail, InputGuardrailContext } from "../guardrails/types";

const ctx: InputGuardrailContext = {
  agentId: "a1",
  userId: "u1",
  message: "hi",
  platform: "api",
  conversationId: "c1",
};

function g(
  name: string,
  result: { tripped: boolean; reason?: string } | "throw"
): Guardrail<"input"> {
  return {
    name,
    stage: "input",
    run: async () => {
      if (result === "throw") throw new Error("boom");
      return result;
    },
  };
}

describe("runGuardrailInstances", () => {
  it("returns no-trip for an empty list", async () => {
    const outcome = await runGuardrailInstances("input", [], ctx);
    expect(outcome.tripped).toBeNull();
    expect(outcome.ran).toEqual([]);
  });

  it("passes when all instances pass", async () => {
    const outcome = await runGuardrailInstances(
      "input",
      [g("a", { tripped: false }), g("b", { tripped: false })],
      ctx
    );
    expect(outcome.tripped).toBeNull();
    expect(outcome.ran.sort()).toEqual(["a", "b"]);
  });

  it("reports the first trip and short-circuits before slower guardrails finish", async () => {
    let slowRan = false;
    const slowPass: Guardrail<"input"> = {
      name: "slow-pass",
      stage: "input",
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        slowRan = true;
        return { tripped: false };
      },
    };
    const outcome = await runGuardrailInstances(
      "input",
      [g("tripper", { tripped: true, reason: "blocked" }), slowPass],
      ctx
    );
    expect(outcome.tripped?.guardrail).toBe("tripper");
    expect(outcome.tripped?.reason).toBe("blocked");
    // The outcome resolves on the first trip; the slow guardrail's result is
    // not reflected in `ran` (it's still running when we short-circuit).
    expect(outcome.ran).toContain("tripper");
    expect(outcome.ran).not.toContain("slow-pass");
    expect(slowRan).toBe(false);
  });

  it("fails open on a thrown guardrail (treats as pass)", async () => {
    const outcome = await runGuardrailInstances(
      "input",
      [g("thrower", "throw"), g("ok", { tripped: false })],
      ctx
    );
    expect(outcome.tripped).toBeNull();
  });
});
