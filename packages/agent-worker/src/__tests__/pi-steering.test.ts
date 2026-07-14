import { describe, expect, test } from "bun:test";
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

const MODEL: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
};

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"]
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function scriptedStream(message: AssistantMessage) {
  const events: AssistantMessageEvent[] = [
    { type: "start", partial: message },
    { type: "done", reason: message.stopReason, message },
  ];
  let index = 0;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () =>
        index < events.length
          ? { value: events[index++], done: false as const }
          : { value: undefined, done: true as const },
    }),
    result: async () => message,
  };
}

describe("Pi live steering", () => {
  test("injects a human message after the active tool finishes", async () => {
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    let releaseTool!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const order: string[] = [];

    const slowTool: AgentTool = {
      name: "slow_tool",
      label: "slow_tool",
      description: "Wait until the test releases the active tool",
      parameters: Type.Object({}),
      execute: async () => {
        order.push("tool-start");
        toolStarted();
        await released;
        order.push("tool-end");
        return {
          content: [{ type: "text", text: "tool complete" }],
          details: {},
        };
      },
    };

    const contexts: unknown[][] = [];
    let streamCall = 0;
    const agent = new Agent({
      steeringMode: "all",
      streamFn: ((_model: unknown, context: { messages: unknown[] }) => {
        contexts.push([...context.messages]);
        streamCall += 1;
        if (streamCall === 1) {
          return scriptedStream(
            assistant(
              [
                {
                  type: "toolCall",
                  id: "slow-call",
                  name: "slow_tool",
                  arguments: {},
                },
              ],
              "toolUse"
            )
          ) as never;
        }
        return scriptedStream(
          assistant([{ type: "text", text: "steering accepted" }], "stop")
        ) as never;
      }) as never,
    });
    agent.state.model = MODEL as never;
    agent.state.tools = [slowTool];

    const run = agent.prompt("start the original work");
    await started;

    order.push("steer");
    agent.steer({
      role: "user",
      content: "change direction now",
      timestamp: Date.now(),
    });

    expect(agent.state.pendingToolCalls.has("slow-call")).toBe(true);
    releaseTool();
    await run;

    expect(order).toEqual(["tool-start", "steer", "tool-end"]);
    expect(streamCall).toBe(2);
    expect(contexts[1]).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: "change direction now",
      })
    );
  });

  test("abort cancels an active tool and prevents another model iteration", async () => {
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    let observedAbort = false;
    let releaseTool!: () => void;

    const abortableTool: AgentTool = {
      name: "abortable_tool",
      label: "abortable_tool",
      description: "Wait for the active agent abort signal",
      parameters: Type.Object({}),
      execute: async (_id, _params, signal) => {
        toolStarted();
        await new Promise<void>((resolve) => {
          releaseTool = resolve;
          if (signal?.aborted) {
            observedAbort = true;
            resolve();
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true }
          );
        });
        return {
          content: [{ type: "text", text: "aborted" }],
          details: {},
        };
      },
    };

    let streamCall = 0;
    const agent = new Agent({
      streamFn: ((
        _model: unknown,
        _context: unknown,
        options: {
          signal?: AbortSignal;
        }
      ) => {
        if (options.signal?.aborted) {
          return scriptedStream(
            assistant([{ type: "text", text: "" }], "aborted")
          ) as never;
        }
        streamCall += 1;
        return scriptedStream(
          assistant(
            [
              {
                type: "toolCall",
                id: "abort-call",
                name: "abortable_tool",
                arguments: {},
              },
            ],
            "toolUse"
          )
        ) as never;
      }) as never,
    });
    agent.state.model = MODEL as never;
    agent.state.tools = [abortableTool];

    const run = agent.prompt("start work");
    await started;
    agent.abort();
    await Promise.race([
      run,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          releaseTool();
          reject(new Error("agent.abort() did not settle the active tool"));
        }, 1_000)
      ),
    ]);

    expect(observedAbort).toBe(true);
    expect(streamCall).toBe(1);
  });
});
