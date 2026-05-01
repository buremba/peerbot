import { beforeEach, describe, expect, test } from "bun:test";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import { OpenClawWorker } from "../openclaw/worker";
import { mockWorkerConfig } from "./setup";

describe("pre-compaction memory flush runtime", () => {
  beforeEach(() => {
    process.env.DISPATCHER_URL = "https://test-dispatcher.example.com";
    process.env.WORKER_TOKEN = "test-worker-token";
  });

  test("runs silent flush once per compaction cycle and persists NO_REPLY outcome", async () => {
    const worker = new OpenClawWorker(mockWorkerConfig);
    const settingsManager = SettingsManager.inMemory();

    const branchEntries: Array<Record<string, unknown>> = [];
    const sessionManager = {
      getBranch: () => branchEntries as any,
      appendCustomEntry: (customType: string, data: unknown) => {
        branchEntries.push({
          type: "custom",
          id: crypto.randomUUID(),
          parentId: null,
          timestamp: new Date().toISOString(),
          customType,
          data,
        });
      },
    } as any;

    let silentCallCount = 0;
    const session = {
      getContextUsage: () => ({
        tokens: 90000,
        contextWindow: 100000,
        percent: 90,
        usageTokens: 90000,
        trailingTokens: 0,
        lastUsageIndex: 1,
      }),
      messages: [
        {
          role: "assistant",
          content: "  no_reply  ",
        },
      ],
    } as any;

    const invokeFlush = async () => {
      await (worker as any).maybeRunPreCompactionMemoryFlush({
        session,
        sessionManager,
        settingsManager,
        memoryFlushConfig: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction.",
          prompt: "Reply with NO_REPLY.",
        },
        incomingPromptText: "hello",
        incomingImageCount: 0,
        runSilentPrompt: async () => {
          silentCallCount += 1;
        },
      });
    };

    await invokeFlush();
    expect(silentCallCount).toBe(1);

    const flushStateEntry = branchEntries.find(
      (entry) => entry.type === "custom"
    ) as any;
    expect(flushStateEntry?.customType).toBe("lobu.memory_flush_state");
    expect(flushStateEntry?.data?.outcome).toBe("no_reply");
    expect(flushStateEntry?.data?.compactionCount).toBe(0);

    // Same compaction cycle: should not flush again.
    await invokeFlush();
    expect(silentCallCount).toBe(1);

    // New compaction entry means a new cycle: flush should run again.
    branchEntries.push({
      type: "compaction",
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      summary: "compacted",
      firstKeptEntryId: "abc",
      tokensBefore: 123,
    });

    await invokeFlush();
    expect(silentCallCount).toBe(2);
  });

  test("skips flush when projected context is below threshold", async () => {
    const worker = new OpenClawWorker(mockWorkerConfig);
    const settingsManager = SettingsManager.inMemory();

    const sessionManager = {
      getBranch: () => [] as any,
      appendCustomEntry: () => undefined,
    } as any;

    let silentCallCount = 0;
    const session = {
      getContextUsage: () => ({
        tokens: 1000,
        contextWindow: 200000,
        percent: 0.5,
        usageTokens: 1000,
        trailingTokens: 0,
        lastUsageIndex: 1,
      }),
      messages: [],
    } as any;

    await (worker as any).maybeRunPreCompactionMemoryFlush({
      session,
      sessionManager,
      settingsManager,
      memoryFlushConfig: {
        enabled: true,
        softThresholdTokens: 4000,
        systemPrompt: "Session nearing compaction.",
        prompt: "Reply with NO_REPLY.",
      },
      incomingPromptText: "short prompt",
      incomingImageCount: 0,
      runSilentPrompt: async () => {
        silentCallCount += 1;
      },
    });

    expect(silentCallCount).toBe(0);
  });
});
