import { describe, expect, mock, test } from "bun:test";
import { UnifiedThreadResponseConsumer } from "../platform/unified-thread-consumer.js";

const basePayload = {
  messageId: "m1",
  channelId: "telegram:123",
  conversationId: "telegram:123",
  userId: "u1",
  teamId: "telegram",
  timestamp: 0,
  platform: "telegram",
  processedMessageIds: ["m1"],
  platformMetadata: {
    connectionId: "marketing-telegram",
  },
};

function createConsumer(overrides?: {
  chatResponseBridge?: unknown;
  renderer?: unknown;
}) {
  const queue = {
    start: mock(async () => undefined),
    stop: mock(async () => undefined),
    createQueue: mock(async () => undefined),
    work: mock(async () => undefined),
  };
  const renderer = overrides?.renderer ?? {
    handleCompletion: mock(async () => undefined),
    handleError: mock(async () => undefined),
  };
  const platformRegistry = {
    get: mock(() => ({ getResponseRenderer: () => renderer })),
  };
  const sseManager = {
    broadcast: mock(() => undefined),
  };
  const consumer = new UnifiedThreadResponseConsumer(
    queue as any,
    platformRegistry as any,
    sseManager as any
  ) as any;
  if (overrides?.chatResponseBridge) {
    consumer.setChatResponseBridge(overrides.chatResponseBridge as any);
  }
  return { consumer, platformRegistry, renderer };
}

describe("UnifiedThreadResponseConsumer customEvent broadcast", () => {
  test("broadcasts tool_use customEvent to conversation + cli session", async () => {
    const renderer = {
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const queue = {
      start: mock(async () => undefined),
      stop: mock(async () => undefined),
      createQueue: mock(async () => undefined),
      work: mock(async () => undefined),
    };
    const broadcast = mock(() => undefined);
    const sseManager = { broadcast };
    const platformRegistry = {
      get: mock(() => ({ getResponseRenderer: () => renderer })),
    };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      sseManager as any
    ) as any;

    const payload = {
      messageId: "m1",
      channelId: "api:1",
      conversationId: "api:1",
      userId: "u1",
      teamId: "api",
      platform: "api",
      timestamp: 1000,
      platformMetadata: { sessionId: "cli-session-1" },
      customEvent: {
        name: "tool_use",
        data: {
          toolCallId: "tc-1",
          name: "search_memory",
          input: { query: "rent" },
          isError: false,
          result_summary: {
            event_ids: [42],
            snippets: [{ id: 42, text: "Rent is due 1st" }],
          },
        },
      },
    };

    await consumer.handleThreadResponse({ id: "job-1", data: payload });

    const broadcasts = broadcast.mock.calls;
    const toolUseBroadcasts = broadcasts.filter(
      (call: any[]) => call[1] === "tool_use"
    );
    expect(toolUseBroadcasts.length).toBe(2);
    const conversationBroadcast = toolUseBroadcasts.find(
      (call: any[]) => call[0] === "api:1"
    );
    const cliBroadcast = toolUseBroadcasts.find(
      (call: any[]) => call[0] === "cli-session-1"
    );
    expect(conversationBroadcast).toBeDefined();
    expect(cliBroadcast).toBeDefined();
    expect(conversationBroadcast?.[2]).toMatchObject({
      toolCallId: "tc-1",
      name: "search_memory",
      result_summary: {
        event_ids: [42],
      },
      messageId: "m1",
      timestamp: 1000,
    });
  });
});

describe("UnifiedThreadResponseConsumer Chat SDK ownership", () => {
  test("throws for Chat SDK connection responses not owned by this gateway", async () => {
    const chatResponseBridge = {
      canHandle: mock(() => false),
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const { consumer, platformRegistry } = createConsumer({ chatResponseBridge });

    await expect(
      consumer.handleThreadResponse({ id: "job-1", data: basePayload })
    ).rejects.toThrow(/not managed by this gateway instance/);

    expect(chatResponseBridge.canHandle).toHaveBeenCalledTimes(1);
    expect(chatResponseBridge.handleCompletion).not.toHaveBeenCalled();
    expect(platformRegistry.get).not.toHaveBeenCalled();
  });

  test("routes Chat SDK responses through the owning gateway bridge", async () => {
    const chatResponseBridge = {
      canHandle: mock(() => true),
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const { consumer, platformRegistry } = createConsumer({ chatResponseBridge });

    await consumer.handleThreadResponse({ id: "job-1", data: basePayload });

    expect(chatResponseBridge.canHandle).toHaveBeenCalledTimes(1);
    expect(chatResponseBridge.handleCompletion).toHaveBeenCalledTimes(1);
    expect(platformRegistry.get).not.toHaveBeenCalled();
  });

  test("legacy platform responses without connectionId still use platform renderer", async () => {
    const renderer = {
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const { consumer, platformRegistry } = createConsumer({ renderer });
    const { platformMetadata, ...payloadWithoutMetadata } = basePayload;
    void platformMetadata;

    await consumer.handleThreadResponse({
      id: "job-1",
      data: payloadWithoutMetadata,
    });

    expect(platformRegistry.get).toHaveBeenCalledWith("telegram");
    expect(renderer.handleCompletion).toHaveBeenCalledTimes(1);
  });
});
