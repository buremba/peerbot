import { describe, expect, test } from "bun:test";
import {
  createNoopGuardrail,
  type Guardrail,
  GuardrailRegistry,
  type InputGuardrailContext,
  runGuardrails,
} from "../guardrails";

const ctx: InputGuardrailContext = {
  agentId: "agent-1",
  userId: "user-1",
  message: "hello",
  platform: "telegram",
};

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

describe("GuardrailRegistry", () => {
  test("register + resolve by enable list", () => {
    const registry = new GuardrailRegistry();
    const a = createNoopGuardrail("input", "a");
    const b = createNoopGuardrail("input", "b");
    registry.register(a);
    registry.register(b);

    const resolved = registry.resolve("input", ["a"]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.name).toBe("a");
  });

  test("list returns all guardrails for a stage", () => {
    const registry = new GuardrailRegistry();
    registry.register(createNoopGuardrail("input", "a"));
    registry.register(createNoopGuardrail("output", "b"));

    expect(registry.list("input").map((g) => g.name)).toEqual(["a"]);
    expect(registry.list("output").map((g) => g.name)).toEqual(["b"]);
    expect(registry.list("pre-tool")).toEqual([]);
  });

  test("duplicate registration at same stage throws", () => {
    const registry = new GuardrailRegistry();
    registry.register(createNoopGuardrail("input", "dup"));
    expect(() =>
      registry.register(createNoopGuardrail("input", "dup"))
    ).toThrow(/already registered/);
  });

  test("same name at different stages is allowed", () => {
    const registry = new GuardrailRegistry();
    registry.register(createNoopGuardrail("input", "shared"));
    registry.register(createNoopGuardrail("output", "shared"));
    expect(registry.get("input", "shared")).toBeDefined();
    expect(registry.get("output", "shared")).toBeDefined();
  });

  test("resolve silently skips unknown names", () => {
    const registry = new GuardrailRegistry();
    registry.register(createNoopGuardrail("input", "known"));
    const resolved = registry.resolve("input", ["known", "missing"]);
    expect(resolved.map((g) => g.name)).toEqual(["known"]);
  });
});

describe("runGuardrails", () => {
  test("empty enabled list returns no-trip outcome without touching registry", async () => {
    const registry = new GuardrailRegistry();
    const outcome = await runGuardrails(registry, "input", [], ctx);
    expect(outcome.tripped).toBeNull();
    expect(outcome.ran).toEqual([]);
  });

  test("all pass → tripped is null, ran lists every guardrail", async () => {
    const registry = new GuardrailRegistry();
    registry.register(createNoopGuardrail("input", "a"));
    registry.register(createNoopGuardrail("input", "b"));

    const outcome = await runGuardrails(registry, "input", ["a", "b"], ctx);
    expect(outcome.tripped).toBeNull();
    expect(outcome.ran.sort()).toEqual(["a", "b"]);
  });

  test("first trip short-circuits; other guardrails are cancelled", async () => {
    const slow = deferred<never>();
    const registry = new GuardrailRegistry();
    const tripper: Guardrail<"input"> = {
      name: "tripper",
      stage: "input",
      async run() {
        return { tripped: true, reason: "caught" };
      },
    };
    const slowGuard: Guardrail<"input"> = {
      name: "slow",
      stage: "input",
      async run() {
        await slow.promise;
        return { tripped: false };
      },
    };
    registry.register(tripper);
    registry.register(slowGuard);

    const outcome = await runGuardrails(
      registry,
      "input",
      ["tripper", "slow"],
      ctx
    );
    expect(outcome.tripped).toEqual({
      guardrail: "tripper",
      reason: "caught",
      metadata: undefined,
    });
    // `ran` should only contain tripper — slow is still blocked on `slow.promise`
    expect(outcome.ran).toEqual(["tripper"]);

    // clean up the hanging promise so the test process doesn't keep a handle
    slow.resolve(undefined as never);
  });

  test("only the first trip is surfaced even when multiple trip", async () => {
    const registry = new GuardrailRegistry();
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const first: Guardrail<"input"> = {
      name: "first",
      stage: "input",
      async run() {
        await firstGate.promise;
        return { tripped: true, reason: "first" };
      },
    };
    const second: Guardrail<"input"> = {
      name: "second",
      stage: "input",
      async run() {
        await secondGate.promise;
        return { tripped: true, reason: "second" };
      },
    };
    registry.register(first);
    registry.register(second);

    const outcomeP = runGuardrails(registry, "input", ["first", "second"], ctx);
    firstGate.resolve();
    const outcome = await outcomeP;
    expect(outcome.tripped?.guardrail).toBe("first");
    secondGate.resolve();
  });

  test("thrown guardrail is treated as a pass and logged", async () => {
    const registry = new GuardrailRegistry();
    const thrower: Guardrail<"input"> = {
      name: "thrower",
      stage: "input",
      async run() {
        throw new Error("boom");
      },
    };
    registry.register(thrower);
    registry.register(createNoopGuardrail("input", "ok"));

    const outcome = await runGuardrails(
      registry,
      "input",
      ["thrower", "ok"],
      ctx
    );
    expect(outcome.tripped).toBeNull();
    // thrower never contributed to `ran`; only ok did
    expect(outcome.ran).toEqual(["ok"]);
  });

  test("metadata is surfaced from the tripping guardrail", async () => {
    const registry = new GuardrailRegistry();
    const detector: Guardrail<"input"> = {
      name: "detector",
      stage: "input",
      async run() {
        return {
          tripped: true,
          reason: "matched",
          metadata: { pattern: "secret-xyz" },
        };
      },
    };
    registry.register(detector);

    const outcome = await runGuardrails(registry, "input", ["detector"], ctx);
    expect(outcome.tripped?.metadata).toEqual({ pattern: "secret-xyz" });
  });

  test("unknown names in enabled list are skipped, known ones still run", async () => {
    const registry = new GuardrailRegistry();
    registry.register(createNoopGuardrail("input", "exists"));

    const outcome = await runGuardrails(
      registry,
      "input",
      ["exists", "missing"],
      ctx
    );
    expect(outcome.tripped).toBeNull();
    expect(outcome.ran).toEqual(["exists"]);
  });
});

describe("createNoopGuardrail", () => {
  test("returns pass regardless of stage and name", async () => {
    const g = createNoopGuardrail("pre-tool", "my-noop");
    expect(g.name).toBe("my-noop");
    expect(g.stage).toBe("pre-tool");
    const result = await g.run({
      agentId: "a",
      userId: "u",
      toolName: "t",
      arguments: {},
    });
    expect(result).toEqual({ tripped: false });
  });
});
