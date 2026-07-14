import { describe, expect, mock, test } from "bun:test";
import type { PluginRuntimeContext } from "@lobu/plugin-api";
import { textResult } from "@lobu/plugin-toolkit";
import { createMemoryPlugin } from "../index";

describe("memory plugin", () => {
  test("owns bounded recall as a before-agent hook", async () => {
    const invoke = mock(async () => textResult("remembered context"));
    const plugin = createMemoryPlugin(
      {
        gatewayUrl: "http://gateway",
        workerToken: "token",
        channelId: "channel",
        conversationId: "conversation",
      },
      invoke
    );
    const result = await plugin.hooks!.beforeAgentStart!(
      { prompt: "what did we decide?", messages: [] },
      {
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      } as PluginRuntimeContext
    );
    expect(result?.prependContext).toContain("remembered context");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
