import { describe, expect, test } from "bun:test";
import { buildRuntimeShellInstructions } from "../runtime/runtime-shell-instructions";

describe("buildRuntimeShellInstructions", () => {
  test("unpinned / local: interpreter limits + point user at sandbox provider", () => {
    for (const pin of [undefined, "", "   ", "future-cloud"] as const) {
      const block = buildRuntimeShellInstructions(pin, true);
      expect(block).toContain("## Shell runtime (this conversation)");
      expect(block).toContain("local lightweight interpreter environment");
      expect(block).toMatch(/limited|lightweight/i);
      expect(block).toMatch(/sandbox provider/i);
      expect(block).not.toContain("/vercel/sandbox");
      expect(block).not.toContain("provider: `vercel`");
    }
  });

  test("pinned vercel: remote guidance + lazy create + no create-sandbox tool", () => {
    const block = buildRuntimeShellInstructions("vercel", true);
    expect(block).toContain("## Shell runtime (this conversation)");
    expect(block).toContain("provider: `vercel`");
    expect(block).toContain("first bash use");
    expect(block).toContain("no create-sandbox tool");
    expect(block).not.toContain("local lightweight interpreter environment");
    expect(block).not.toMatch(/add a sandbox provider/i);
  });

  test("normalizes provider id case", () => {
    const block = buildRuntimeShellInstructions("Vercel", true);
    expect(block).toContain("provider: `vercel`");
  });

  test("does not advertise shell when bash is disabled by policy", () => {
    for (const pin of [undefined, "vercel"] as const) {
      const block = buildRuntimeShellInstructions(pin, false);
      expect(block).toContain("Shell is disabled for this agent by policy");
      expect(block).not.toContain("Use the **bash** tool");
      expect(block).not.toContain("provider: `vercel`");
      expect(block).not.toContain("local lightweight interpreter environment");
    }
  });
});
