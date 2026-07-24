import { describe, expect, test } from "bun:test";
import { buildRuntimeShellInstructions } from "../runtime/runtime-shell-instructions";

describe("buildRuntimeShellInstructions", () => {
  test("unpinned / local: interpreter limits + point user at sandbox provider", () => {
    for (const pin of [undefined, null, "", "   "] as const) {
      const block = buildRuntimeShellInstructions(pin);
      expect(block).toContain("## Shell runtime (this conversation)");
      expect(block).toContain("local interpreter environment");
      expect(block).toMatch(/limited|lightweight/i);
      expect(block).toMatch(/sandbox provider/i);
      expect(block).not.toContain("/vercel/sandbox");
      expect(block).not.toContain("provider: `vercel`");
    }
  });

  test("pinned vercel: remote guidance + lazy create + no create-sandbox tool", () => {
    const block = buildRuntimeShellInstructions("vercel");
    expect(block).toContain("## Shell runtime (this conversation)");
    expect(block).toContain("provider: `vercel`");
    expect(block).toContain("/vercel/sandbox");
    expect(block).toContain("first bash use");
    expect(block).toContain("no create-sandbox tool");
    expect(block).toContain("upload_file");
    expect(block).not.toContain("local interpreter environment");
    expect(block).not.toMatch(/add a sandbox provider/i);
  });

  test("normalizes provider id case", () => {
    const block = buildRuntimeShellInstructions("Vercel");
    expect(block).toContain("provider: `vercel`");
    expect(block).toContain("/vercel/sandbox");
  });

  test("unknown remote provider gets generic remote block", () => {
    const block = buildRuntimeShellInstructions("future-cloud");
    expect(block).toContain("provider: `future-cloud`");
    expect(block).not.toContain("/vercel/sandbox");
    expect(block).toContain("remote provider `future-cloud`");
    expect(block).not.toContain("local interpreter environment");
  });
});
