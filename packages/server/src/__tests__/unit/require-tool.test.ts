import { describe, expect, test } from "bun:test";
import {
  createRequireToolGuardrail,
  createRequireToolGuardrailFromEntry,
  isRequireToolEntry,
} from "../../gateway/guardrails/require-tool";
import type { AgentInlineGuardrail, OutputGuardrailContext } from "@lobu/core";

function ctx(
  over: Partial<OutputGuardrailContext> = {}
): OutputGuardrailContext {
  return {
    agentId: "a",
    userId: "u",
    text: "hello world reply that is long enough",
    platform: "api",
    ...over,
  };
}

describe("createRequireToolGuardrail", () => {
  test("passes when all required tools were used", async () => {
    const g = createRequireToolGuardrail({
      name: "need-chips",
      tools: ["suggest_actions"],
    });
    const r = await g.run(ctx({ toolsUsed: ["suggest_actions", "search_memory"] }));
    expect(r.tripped).toBe(false);
  });

  test("fail-closed (default) trips when a tool is missing", async () => {
    const g = createRequireToolGuardrail({
      name: "need-chips",
      tools: ["suggest_actions"],
    });
    const r = await g.run(ctx({ toolsUsed: ["search_memory"] }));
    expect(r.tripped).toBe(true);
    expect(r.reason).toContain("suggest_actions");
    expect((r.metadata as { missing: string[] }).missing).toEqual([
      "suggest_actions",
    ]);
  });

  test("fail-open does not trip when a tool is missing", async () => {
    const g = createRequireToolGuardrail({
      name: "need-chips",
      tools: ["suggest_actions"],
      onMissing: "fail-open",
    });
    const r = await g.run(ctx({ toolsUsed: [] }));
    expect(r.tripped).toBe(false);
    expect((r.metadata as { skipped: string }).skipped).toBe("missing");
  });

  test("fail-open onUnknown when toolsUsed is absent", async () => {
    const g = createRequireToolGuardrail({
      name: "need-chips",
      tools: ["suggest_actions"],
      onMissing: "fail-closed",
      onUnknown: "fail-open",
    });
    const r = await g.run(ctx({ toolsUsed: undefined }));
    expect(r.tripped).toBe(false);
    expect((r.metadata as { skipped: string }).skipped).toBe("unknown");
  });

  test("fail-closed onUnknown trips when toolsUsed is absent", async () => {
    const g = createRequireToolGuardrail({
      name: "need-chips",
      tools: ["suggest_actions"],
      onUnknown: "fail-closed",
    });
    const r = await g.run(ctx({ toolsUsed: undefined }));
    expect(r.tripped).toBe(true);
    expect(r.reason).toMatch(/unknown/i);
  });

  test("empty toolsUsed array is known (not unknown) — can fail-closed", async () => {
    const g = createRequireToolGuardrail({
      name: "need-chips",
      tools: ["suggest_actions"],
      onMissing: "fail-closed",
    });
    // Worker stamped [] = no tools this turn, not an old worker.
    const r = await g.run(ctx({ toolsUsed: [] }));
    expect(r.tripped).toBe(true);
  });

  test("manual multi-tool: all must be present", async () => {
    const g = createRequireToolGuardrail({
      name: "need-both",
      tools: ["suggest_actions", "upload_file"],
    });
    const half = await g.run(ctx({ toolsUsed: ["suggest_actions"] }));
    expect(half.tripped).toBe(true);
    expect((half.metadata as { missing: string[] }).missing).toEqual([
      "upload_file",
    ]);
    const full = await g.run(
      ctx({ toolsUsed: ["upload_file", "suggest_actions"] })
    );
    expect(full.tripped).toBe(false);
  });
});

describe("from entry", () => {
  test("isRequireToolEntry", () => {
    expect(
      isRequireToolEntry({
        name: "x",
        enabled: true,
        stage: "output",
        kind: "require-tool",
        tools: ["suggest_actions"],
      })
    ).toBe(true);
    expect(
      isRequireToolEntry({
        name: "y",
        enabled: true,
        stage: "output",
        policy: "no secrets",
      })
    ).toBe(false);
  });

  test("createRequireToolGuardrailFromEntry null when empty tools", () => {
    const entry: AgentInlineGuardrail = {
      name: "x",
      enabled: true,
      stage: "output",
      kind: "require-tool",
      tools: [],
    };
    expect(createRequireToolGuardrailFromEntry(entry)).toBeNull();
  });
});
