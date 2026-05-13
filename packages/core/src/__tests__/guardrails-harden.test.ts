/**
 * Hardened guardrails tests — edge cases not covered by guardrails.test.ts.
 *
 * Focus areas:
 *  - Concurrent trips: two guardrails trip near-simultaneously; only first wins.
 *  - `ran` snapshot isolation: slow guardrail finishes after short-circuit and
 *    must NOT appear in the returned `ran` array.
 *  - Rejected-promise (vs sync-throw) guardrail treated as pass.
 *  - All enabled names unknown → {tripped: null, ran: []}.
 *  - Output + pre-tool stage coverage via runGuardrails.
 *  - pre-tool guardrail that denies a destructive tool call.
 *  - createNoopGuardrail default name derivation.
 *  - Registry: get() on unregistered stage returns undefined.
 */

import { describe, expect, test } from "bun:test";
import {
  createNoopGuardrail,
  type Guardrail,
  GuardrailRegistry,
  type OutputGuardrailContext,
  type PreToolGuardrailContext,
  runGuardrails,
} from "../guardrails";
import type { InputGuardrailContext } from "../guardrails";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const inputCtx: InputGuardrailContext = {
  agentId: "agent-1",
  userId: "user-1",
  message: "hello world",
  platform: "telegram",
};

const outputCtx: OutputGuardrailContext = {
  agentId: "agent-1",
  userId: "user-1",
  text: "assistant reply",
  platform: "telegram",
};

const preToolCtx: PreToolGuardrailContext = {
  agentId: "agent-1",
  userId: "user-1",
  toolName: "shell_exec",
  arguments: { command: "rm -rf /" },
};

// ---------------------------------------------------------------------------
// Concurrent trip: two guardrails resolve nearly simultaneously
// ---------------------------------------------------------------------------

describe("runGuardrails — concurrent trip ordering", () => {
  test("when both guardrails trip simultaneously only the first-to-settle wins", async () => {
    const registry = new GuardrailRegistry();
    // Gate both so we can release them together (same microtask tick).
    const gate = deferred<void>();

    const first: Guardrail<"input"> = {
      name: "first",
      stage: "input",
      async run() {
        await gate.promise;
        return { tripped: true, reason: "first-reason" };
      },
    };
    const second: Guardrail<"input"> = {
      name: "second",
      stage: "input",
      async run() {
        await gate.promise;
        return { tripped: true, reason: "second-reason" };
      },
    };
    registry.register(first);
    registry.register(second);

    const outcomeP = runGuardrails(
      registry,
      "input",
      ["first", "second"],
      inputCtx
    );
    // Release both in the same microtask: the promise iteration order
    // determines who settles first (first registered = first in loop).
    gate.resolve();
    const outcome = await outcomeP;

    // Exactly one guardrail's trip is surfaced.
    expect(outcome.tripped).not.toBeNull();
    expect(["first", "second"]).toContain(outcome.tripped?.guardrail);
    // The reason must match the winning guardrail name.
    expect(outcome.tripped?.reason).toBe(
      `${outcome.tripped?.guardrail}-reason`
    );
  });

  test("ran snapshot does not include slow guardrail that finishes after short-circuit", async () => {
    const registry = new GuardrailRegistry();
    const slowGate = deferred<void>();

    const fast: Guardrail<"input"> = {
      name: "fast-tripper",
      stage: "input",
      async run() {
        return { tripped: true, reason: "fast" };
      },
    };
    // slow completes AFTER the race resolves (we hold its gate).
    const slow: Guardrail<"input"> = {
      name: "slow-pass",
      stage: "input",
      async run() {
        await slowGate.promise;
        return { tripped: false };
      },
    };
    registry.register(fast);
    registry.register(slow);

    const outcome = await runGuardrails(
      registry,
      "input",
      ["fast-tripper", "slow-pass"],
      inputCtx
    );

    // fast-tripper tripped and short-circuited before slow-pass resolved.
    expect(outcome.tripped?.guardrail).toBe("fast-tripper");
    // slow-pass had NOT settled when finish() was called — it must NOT appear
    // in the snapshot.
    expect(outcome.ran).toEqual(["fast-tripper"]);

    // Release the slow gate so the background promise settles cleanly.
    slowGate.resolve();
  });

  test("ran snapshot correctness when fast guardrail passes and slow one trips later", async () => {
    // Ensures the runner doesn't short-circuit on a *pass* — it must wait for
    // all guardrails when no trip has occurred yet.
    const registry = new GuardrailRegistry();
    const slowGate = deferred<void>();

    const fast: Guardrail<"input"> = {
      name: "fast-pass",
      stage: "input",
      async run() {
        return { tripped: false };
      },
    };
    const slow: Guardrail<"input"> = {
      name: "slow-tripper",
      stage: "input",
      async run() {
        await slowGate.promise;
        return { tripped: true, reason: "late-trip" };
      },
    };
    registry.register(fast);
    registry.register(slow);

    const outcomeP = runGuardrails(
      registry,
      "input",
      ["fast-pass", "slow-tripper"],
      inputCtx
    );
    slowGate.resolve();
    const outcome = await outcomeP;

    expect(outcome.tripped?.guardrail).toBe("slow-tripper");
    // Both must appear in ran when slow finally settled.
    expect(outcome.ran.sort()).toEqual(["fast-pass", "slow-tripper"]);
  });
});

// ---------------------------------------------------------------------------
// Rejected promise treated as pass
// ---------------------------------------------------------------------------

describe("runGuardrails — rejected promise", () => {
  test("guardrail returning Promise.reject is treated as a pass (not a trip)", async () => {
    const registry = new GuardrailRegistry();
    const rejecter: Guardrail<"input"> = {
      name: "rejecter",
      stage: "input",
      run() {
        return Promise.reject(new Error("network timeout"));
      },
    };
    registry.register(rejecter);
    registry.register(createNoopGuardrail("input", "pass"));

    const outcome = await runGuardrails(
      registry,
      "input",
      ["rejecter", "pass"],
      inputCtx
    );
    expect(outcome.tripped).toBeNull();
    // rejecter didn't add to ran; pass did.
    expect(outcome.ran).toEqual(["pass"]);
  });

  test("rejection does not prevent the other guardrails from completing", async () => {
    const registry = new GuardrailRegistry();
    const rejecter: Guardrail<"input"> = {
      name: "rejecter",
      stage: "input",
      run() {
        return Promise.reject("boom");
      },
    };
    const tripper: Guardrail<"input"> = {
      name: "tripper",
      stage: "input",
      async run() {
        return { tripped: true, reason: "caught" };
      },
    };
    registry.register(rejecter);
    registry.register(tripper);

    const outcome = await runGuardrails(
      registry,
      "input",
      ["rejecter", "tripper"],
      inputCtx
    );
    // tripper should still win despite rejecter firing in parallel.
    expect(outcome.tripped?.guardrail).toBe("tripper");
  });
});

// ---------------------------------------------------------------------------
// All enabled names are unknown (none resolve from registry)
// ---------------------------------------------------------------------------

describe("runGuardrails — all unknown names", () => {
  test("every enabled name unknown → tripped null, ran empty", async () => {
    const registry = new GuardrailRegistry();
    const outcome = await runGuardrails(
      registry,
      "input",
      ["ghost-a", "ghost-b"],
      inputCtx
    );
    expect(outcome.tripped).toBeNull();
    expect(outcome.ran).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Output stage
// ---------------------------------------------------------------------------

describe("runGuardrails — output stage", () => {
  test("output guardrail inspects response text", async () => {
    const registry = new GuardrailRegistry();
    const piiDetector: Guardrail<"output"> = {
      name: "pii-output",
      stage: "output",
      async run(ctx) {
        if (ctx.text.includes("SSN:")) {
          return {
            tripped: true,
            reason: "pii-leak",
            metadata: { field: "SSN" },
          };
        }
        return { tripped: false };
      },
    };
    registry.register(piiDetector);

    const safeOutcome = await runGuardrails(
      registry,
      "output",
      ["pii-output"],
      { ...outputCtx, text: "Here is your answer." }
    );
    expect(safeOutcome.tripped).toBeNull();

    const riskyOutcome = await runGuardrails(
      registry,
      "output",
      ["pii-output"],
      { ...outputCtx, text: "Your SSN: 123-45-6789" }
    );
    expect(riskyOutcome.tripped?.guardrail).toBe("pii-output");
    expect(riskyOutcome.tripped?.metadata).toEqual({ field: "SSN" });
  });
});

// ---------------------------------------------------------------------------
// Pre-tool stage — authorization of destructive tool calls
// ---------------------------------------------------------------------------

describe("runGuardrails — pre-tool stage", () => {
  test("pre-tool guardrail blocks a destructive shell command", async () => {
    const registry = new GuardrailRegistry();
    const shellBlocker: Guardrail<"pre-tool"> = {
      name: "shell-blocker",
      stage: "pre-tool",
      async run(ctx) {
        if (ctx.toolName === "shell_exec") {
          const args = ctx.arguments as Record<string, string>;
          if (args.command?.includes("rm -rf")) {
            return { tripped: true, reason: "destructive-command-blocked" };
          }
        }
        return { tripped: false };
      },
    };
    registry.register(shellBlocker);

    const blockedOutcome = await runGuardrails(
      registry,
      "pre-tool",
      ["shell-blocker"],
      preToolCtx
    );
    expect(blockedOutcome.tripped?.guardrail).toBe("shell-blocker");
    expect(blockedOutcome.tripped?.reason).toBe("destructive-command-blocked");

    // Benign tool call passes.
    const benignOutcome = await runGuardrails(
      registry,
      "pre-tool",
      ["shell-blocker"],
      { ...preToolCtx, toolName: "read_file", arguments: { path: "/tmp/out" } }
    );
    expect(benignOutcome.tripped).toBeNull();
    expect(benignOutcome.ran).toEqual(["shell-blocker"]);
  });

  test("pre-tool noop guardrail always passes", async () => {
    const registry = new GuardrailRegistry();
    registry.register(createNoopGuardrail("pre-tool", "noop-pre"));
    const outcome = await runGuardrails(
      registry,
      "pre-tool",
      ["noop-pre"],
      preToolCtx
    );
    expect(outcome.tripped).toBeNull();
    expect(outcome.ran).toEqual(["noop-pre"]);
  });
});

// ---------------------------------------------------------------------------
// Registry edge cases
// ---------------------------------------------------------------------------

describe("GuardrailRegistry — edge cases", () => {
  test("get() on unregistered stage returns undefined", () => {
    const registry = new GuardrailRegistry();
    expect(registry.get("pre-tool", "anything")).toBeUndefined();
  });

  test("list() on empty registry returns empty array for every stage", () => {
    const registry = new GuardrailRegistry();
    expect(registry.list("input")).toEqual([]);
    expect(registry.list("output")).toEqual([]);
    expect(registry.list("pre-tool")).toEqual([]);
  });

  test("resolve() on a stage with no registered guardrails returns empty array", () => {
    const registry = new GuardrailRegistry();
    // Register only on 'input'; resolve 'output' → should return [].
    registry.register(createNoopGuardrail("input", "in"));
    expect(registry.resolve("output", ["in"])).toEqual([]);
  });

  test("registering a guardrail under its default name", () => {
    const g = createNoopGuardrail("input");
    expect(g.name).toBe("noop-input");
    const registry = new GuardrailRegistry();
    registry.register(g);
    expect(registry.get("input", "noop-input")).toBeDefined();
  });

  test("different stages can hold guardrails with the same name independently", () => {
    const registry = new GuardrailRegistry();
    registry.register(createNoopGuardrail("input", "x"));
    registry.register(createNoopGuardrail("output", "x"));
    registry.register(createNoopGuardrail("pre-tool", "x"));
    expect(registry.list("input")).toHaveLength(1);
    expect(registry.list("output")).toHaveLength(1);
    expect(registry.list("pre-tool")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Stage isolation: runGuardrails only runs guardrails for the target stage
// ---------------------------------------------------------------------------

describe("runGuardrails — stage isolation", () => {
  test("input guardrail is not invoked when running output stage", async () => {
    const registry = new GuardrailRegistry();
    let inputRan = false;
    const inputGuard: Guardrail<"input"> = {
      name: "input-guard",
      stage: "input",
      async run() {
        inputRan = true;
        return { tripped: true, reason: "should-not-run" };
      },
    };
    const outputGuard = createNoopGuardrail("output", "output-guard");
    registry.register(inputGuard);
    registry.register(outputGuard);

    // Run the output stage — 'input-guard' is registered for 'input', not 'output'.
    // Even if we pass its name in `enabled`, resolve() will find nothing.
    const outcome = await runGuardrails(
      registry,
      "output",
      ["input-guard", "output-guard"],
      outputCtx
    );
    expect(inputRan).toBe(false);
    // output-guard ran and passed.
    expect(outcome.tripped).toBeNull();
    expect(outcome.ran).toEqual(["output-guard"]);
  });
});
