/**
 * Tests for utils/session-file.ts.
 *
 * Focus on the cost-tracking-relevant behaviour: the parser reads pi-ai's
 * REAL on-disk usage field names (input/output/cacheRead/cacheWrite + cost),
 * not the legacy {inputTokens, outputTokens} that never existed on disk, and
 * computeSessionStats reports cache buckets, cost, and a currentModel taken
 * from the per-message model stamp (not only from model_change markers).
 */

import { describe, expect, test } from "bun:test";
import {
  computeSessionStats,
  entryToMessage,
  parseSessionEntries,
  type SessionEntry,
  type SessionUsage,
} from "../utils/session-file";

function message(
  role: string,
  opts: {
    id?: string;
    provider?: string;
    model?: string;
    usage?: SessionUsage;
  } = {}
): SessionEntry {
  return {
    type: "message",
    id: opts.id ?? "m",
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
    message: {
      role,
      content: "hi",
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.usage ? { usage: opts.usage } : {}),
    },
  };
}

describe("parseSessionEntries", () => {
  test("extracts the session id, skips the session line and malformed lines", () => {
    const content = [
      '{"type":"session","id":"sess-1"}',
      '{"type":"message","id":"a1","parentId":null,"timestamp":"t","message":{"role":"assistant","usage":{"input":5}}}',
      "",
      "not-json",
    ].join("\n");
    const { entries, sessionId } = parseSessionEntries(content);
    expect(sessionId).toBe("sess-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("a1");
  });
});

describe("computeSessionStats", () => {
  test("sums the four token buckets via pi-ai field names, plus cost", () => {
    const entries: SessionEntry[] = [
      message("user", { id: "u1" }),
      message("assistant", {
        id: "a1",
        provider: "zai",
        model: "glm-4.6",
        usage: {
          input: 8809,
          output: 140,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 8949,
          cost: { total: 0.0055934 },
        },
      }),
      message("assistant", {
        id: "a2",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: {
          input: 1000,
          output: 200,
          cacheRead: 5000,
          cacheWrite: 300,
          cost: { total: 0.02 },
        },
      }),
    ];
    const stats = computeSessionStats(entries);
    expect(stats.messageCount).toBe(3);
    expect(stats.userMessages).toBe(1);
    expect(stats.assistantMessages).toBe(2);
    expect(stats.totalInputTokens).toBe(9809);
    expect(stats.totalOutputTokens).toBe(340);
    expect(stats.totalCacheReadTokens).toBe(5000);
    expect(stats.totalCacheWriteTokens).toBe(300);
    expect(stats.totalCostUsd).toBeCloseTo(0.0255934, 6);
  });

  test("currentModel comes from the per-message model even with no model_change", () => {
    const stats = computeSessionStats([
      message("assistant", { provider: "zai", model: "glm-4.6" }),
    ]);
    expect(stats.currentModel).toBe("zai/glm-4.6");
  });

  test("a later model_change overrides the per-message model", () => {
    const stats = computeSessionStats([
      message("assistant", { provider: "zai", model: "glm-4.6" }),
      {
        type: "model_change",
        id: "mc",
        parentId: null,
        timestamp: "2026-01-01T00:01:00Z",
        provider: "openai",
        modelId: "gpt-5",
      },
    ]);
    expect(stats.currentModel).toBe("openai/gpt-5");
  });

  test("empty session yields zeros and no model", () => {
    const stats = computeSessionStats([]);
    expect(stats).toEqual({
      messageCount: 0,
      userMessages: 0,
      assistantMessages: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalCostUsd: 0,
    });
  });
});

describe("entryToMessage", () => {
  test("message entries carry a provider-qualified model and the usage", () => {
    const pm = entryToMessage(
      message("assistant", {
        provider: "zai",
        model: "glm-4.6",
        usage: { input: 5, output: 1 },
      })
    );
    expect(pm?.model).toBe("zai/glm-4.6");
    expect(pm?.usage?.input).toBe(5);
  });

  test("model_change entries render provider/modelId", () => {
    const pm = entryToMessage({
      type: "model_change",
      id: "mc",
      parentId: null,
      timestamp: "t",
      provider: "openai",
      modelId: "gpt-5",
    });
    expect(pm?.type).toBe("model_change");
    expect(pm?.content).toBe("openai/gpt-5");
  });
});
