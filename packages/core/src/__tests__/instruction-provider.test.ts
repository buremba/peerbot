/**
 * Tests for instruction-provider.ts (BaseInstructionProvider).
 *
 * No prior tests existed. Covers: happy-path getInstructions, error-swallowing,
 * priority ordering convention, and name/priority contract.
 */

import { describe, expect, test } from "bun:test";
import { BaseInstructionProvider } from "../instruction-provider";
import type { InstructionContext } from "../types";

// ── Minimal context ──────────────────────────────────────────────────────────

const CTX: InstructionContext = {
  userId: "user-1",
  agentId: "agent-1",
  sessionKey: "sess-abc",
  workingDirectory: "/workspace",
};

// ── Concrete test implementations ─────────────────────────────────────────────

class HappyProvider extends BaseInstructionProvider {
  readonly name = "happy";
  readonly priority = 10;
  protected buildInstructions(_ctx: InstructionContext): string {
    return "## Happy Instructions";
  }
}

class AsyncProvider extends BaseInstructionProvider {
  readonly name = "async";
  readonly priority = 20;
  protected async buildInstructions(ctx: InstructionContext): Promise<string> {
    return `## Instructions for ${ctx.userId}`;
  }
}

class ThrowingProvider extends BaseInstructionProvider {
  readonly name = "thrower";
  readonly priority = 30;
  protected buildInstructions(_ctx: InstructionContext): string {
    throw new Error("build failed");
  }
}

class EmptyProvider extends BaseInstructionProvider {
  readonly name = "empty";
  readonly priority = 40;
  protected buildInstructions(_ctx: InstructionContext): string {
    return "";
  }
}

class ContextAwareProvider extends BaseInstructionProvider {
  readonly name = "ctx-aware";
  readonly priority = 5;
  protected buildInstructions(ctx: InstructionContext): string {
    return `user=${ctx.userId} agent=${ctx.agentId}`;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BaseInstructionProvider.getInstructions", () => {
  test("returns value from buildInstructions (sync)", async () => {
    const provider = new HappyProvider();
    const result = await provider.getInstructions(CTX);
    expect(result).toBe("## Happy Instructions");
  });

  test("returns value from buildInstructions (async)", async () => {
    const provider = new AsyncProvider();
    const result = await provider.getInstructions(CTX);
    expect(result).toBe("## Instructions for user-1");
  });

  test("swallows exceptions and returns empty string", async () => {
    const provider = new ThrowingProvider();
    // Should not throw; returns ""
    const result = await provider.getInstructions(CTX);
    expect(result).toBe("");
  });

  test("passes empty string through when buildInstructions returns empty", async () => {
    const provider = new EmptyProvider();
    const result = await provider.getInstructions(CTX);
    expect(result).toBe("");
  });

  test("passes context fields to buildInstructions", async () => {
    const provider = new ContextAwareProvider();
    const result = await provider.getInstructions(CTX);
    expect(result).toContain("user-1");
    expect(result).toContain("agent-1");
  });
});

describe("BaseInstructionProvider contract", () => {
  test("name is accessible on the instance", () => {
    expect(new HappyProvider().name).toBe("happy");
  });

  test("priority is accessible on the instance", () => {
    expect(new HappyProvider().priority).toBe(10);
  });

  test("lower priority value = earlier ordering (convention check)", () => {
    const providers = [
      new AsyncProvider(),
      new ContextAwareProvider(),
      new HappyProvider(),
    ];
    const sorted = [...providers].sort((a, b) => a.priority - b.priority);
    expect(sorted[0]?.name).toBe("ctx-aware");
    expect(sorted[1]?.name).toBe("happy");
    expect(sorted[2]?.name).toBe("async");
  });

  test("each call to getInstructions is independent (no shared state)", async () => {
    const provider = new ContextAwareProvider();
    const ctx1 = { ...CTX, userId: "alice" };
    const ctx2 = { ...CTX, userId: "bob" };
    const [r1, r2] = await Promise.all([
      provider.getInstructions(ctx1),
      provider.getInstructions(ctx2),
    ]);
    expect(r1).toContain("alice");
    expect(r2).toContain("bob");
  });
});
