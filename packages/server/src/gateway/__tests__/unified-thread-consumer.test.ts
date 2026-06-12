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
    // Exactly one broadcast, keyed by conversation id — the legacy
    // platformMetadata.sessionId side-channel is gone (no producer ever set
    // it; clients subscribe on conversationId).
    expect(toolUseBroadcasts.length).toBe(1);
    const conversationBroadcast = toolUseBroadcasts.find(
      (call: any[]) => call[0] === "api:1"
    );
    expect(conversationBroadcast).toBeDefined();
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

describe("UnifiedThreadResponseConsumer interaction card owner-routing", () => {
  function makeInteractionConsumer(hasActiveConnection: boolean) {
    const queue = {
      start: mock(async () => undefined),
      stop: mock(async () => undefined),
      createQueue: mock(async () => undefined),
      work: mock(async () => undefined),
    };
    const broadcast = mock(() => undefined);
    const sseManager = {
      broadcast,
      hasActiveConnection: mock(() => hasActiveConnection),
    };
    const platformRegistry = {
      get: mock(() => ({
        getResponseRenderer: () => ({
          handleCompletion: mock(async () => undefined),
          handleError: mock(async () => undefined),
        }),
      })),
    };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      sseManager as any
    ) as any;
    return { consumer, broadcast, sseManager };
  }

  const interactionPayload = {
    messageId: "m-int-1",
    channelId: "api:conv-1",
    conversationId: "api:conv-1",
    userId: "u1",
    teamId: "api",
    platform: "api",
    timestamp: 1234,
    customEvent: {
      name: "question",
      data: { type: "question", questionId: "q_1", question: "Proceed?" },
      requireSseOwner: true,
    },
  };

  test("re-queues an ask_user card when this pod does not own the SSE", async () => {
    const { consumer, broadcast, sseManager } = makeInteractionConsumer(false);

    await expect(
      consumer.handleThreadResponse({ id: "job-1", data: interactionPayload })
    ).rejects.toThrow(/not owned by this gateway instance/);

    expect(sseManager.hasActiveConnection).toHaveBeenCalledWith("api:conv-1");
    // Must NOT broadcast into the wrong pod's SseManager.
    expect(broadcast).not.toHaveBeenCalled();
  });

  test("delivers the card on the pod that owns the SSE connection", async () => {
    const { consumer, broadcast } = makeInteractionConsumer(true);

    await consumer.handleThreadResponse({
      id: "job-2",
      data: interactionPayload,
    });

    const questionBroadcasts = broadcast.mock.calls.filter(
      (call: any[]) => call[1] === "question"
    );
    expect(questionBroadcasts.length).toBe(1);
    expect(questionBroadcasts[0][0]).toBe("api:conv-1");
    expect(questionBroadcasts[0][2]).toMatchObject({
      type: "question",
      questionId: "q_1",
      messageId: "m-int-1",
      timestamp: 1234,
    });
  });
});

describe("UnifiedThreadResponseConsumer headless owner-gate exemption", () => {
  function makeApiConsumer(hasActiveConnection: boolean) {
    const queue = {
      start: mock(async () => undefined),
      stop: mock(async () => undefined),
      createQueue: mock(async () => undefined),
      work: mock(async () => undefined),
    };
    const renderer = {
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const sseManager = {
      broadcast: mock(() => undefined),
      hasActiveConnection: mock(() => hasActiveConnection),
    };
    const platformRegistry = {
      get: mock(() => ({ getResponseRenderer: () => renderer })),
    };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      sseManager as any
    ) as any;
    return { consumer, renderer, sseManager };
  }

  // Worker terminal rows for headless turns carry teamId "api" without
  // `platform`, plus the dispatch-time source echoed in platformMetadata.
  const watcherTerminal = {
    messageId: "m-w-1",
    channelId: "api_watcher_7",
    conversationId: "api_watcher_7",
    userId: "watcher-7",
    teamId: "api",
    timestamp: 99,
    processedMessageIds: ["m-w-1"],
    platformMetadata: { source: "watcher-run" },
  };

  test("watcher terminal success row is delivered on first claim with no SSE anywhere", async () => {
    const { consumer, renderer, sseManager } = makeApiConsumer(false);

    await consumer.handleThreadResponse({ id: "job-1", data: watcherTerminal });

    expect(renderer.handleCompletion).toHaveBeenCalledTimes(1);
    expect(sseManager.hasActiveConnection).not.toHaveBeenCalled();
  });

  test("watcher terminal error row resolves immediately (was: 2h stale sweep)", async () => {
    const { consumer, renderer } = makeApiConsumer(false);
    const errorRow = {
      ...watcherTerminal,
      processedMessageIds: undefined,
      error: "worker exited 1",
    };

    await consumer.handleThreadResponse({ id: "job-2", data: errorRow });

    expect(renderer.handleError).toHaveBeenCalledTimes(1);
    expect(renderer.handleCompletion).toHaveBeenCalledTimes(1); // error path also completes
  });

  for (const source of ["connector-repair", "scheduled-job", "internal"]) {
    test(`${source} terminal row bypasses the owner-gate`, async () => {
      const { consumer, renderer } = makeApiConsumer(false);

      await consumer.handleThreadResponse({
        id: `job-${source}`,
        data: {
          ...watcherTerminal,
          platformMetadata: { source },
        },
      });

      expect(renderer.handleCompletion).toHaveBeenCalledTimes(1);
    });
  }

  test("direct-api terminal row is still owner-gated", async () => {
    const { consumer, renderer } = makeApiConsumer(false);

    await expect(
      consumer.handleThreadResponse({
        id: "job-3",
        data: {
          ...watcherTerminal,
          userId: "u1",
          platformMetadata: { source: "direct-api" },
        },
      })
    ).rejects.toThrow(/not owned by this gateway instance/);
    expect(renderer.handleCompletion).not.toHaveBeenCalled();
  });

  test("terminal row without any source is still owner-gated", async () => {
    const { consumer, renderer } = makeApiConsumer(false);
    const { platformMetadata, ...noMeta } = watcherTerminal;
    void platformMetadata;

    await expect(
      consumer.handleThreadResponse({ id: "job-4", data: { ...noMeta, userId: "u1" } })
    ).rejects.toThrow(/not owned by this gateway instance/);
    expect(renderer.handleCompletion).not.toHaveBeenCalled();
  });
});

describe("UnifiedThreadResponseConsumer dead-letters instead of silent drops", () => {
  test("missing platform adapter throws so the row retries then dead-letters", async () => {
    const queue = {
      start: mock(async () => undefined),
      stop: mock(async () => undefined),
      createQueue: mock(async () => undefined),
      work: mock(async () => undefined),
    };
    const platformRegistry = { get: mock(() => undefined) };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      { broadcast: mock(() => undefined) } as any
    ) as any;

    await expect(
      consumer.handleThreadResponse({
        id: "job-1",
        data: { messageId: "m1", userId: "u1", teamId: "ghost-platform" },
      })
    ).rejects.toThrow(/No platform adapter registered/);
  });

  test("platform without renderer throws so the row retries then dead-letters", async () => {
    const queue = {
      start: mock(async () => undefined),
      stop: mock(async () => undefined),
      createQueue: mock(async () => undefined),
      work: mock(async () => undefined),
    };
    const platformRegistry = {
      get: mock(() => ({ getResponseRenderer: () => undefined })),
    };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      { broadcast: mock(() => undefined) } as any
    ) as any;

    await expect(
      consumer.handleThreadResponse({
        id: "job-2",
        data: { messageId: "m2", userId: "u1", teamId: "telegram" },
      })
    ).rejects.toThrow(/does not provide a response renderer/);
  });
});

describe("UnifiedThreadResponseConsumer Chat SDK hydrate-on-claim", () => {
  test("throws for Chat SDK connection responses this replica cannot serve", async () => {
    // ensureDeliverable=false means hydration failed (deleted/stopped row or
    // an exclusive transport leased elsewhere) — fail the job so the retry
    // can land on a replica that can serve it.
    const chatResponseBridge = {
      ensureDeliverable: mock(async () => false),
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const { consumer, platformRegistry } = createConsumer({ chatResponseBridge });

    await expect(
      consumer.handleThreadResponse({ id: "job-1", data: basePayload })
    ).rejects.toThrow(/cannot be served by this gateway instance/);

    expect(chatResponseBridge.ensureDeliverable).toHaveBeenCalledTimes(1);
    expect(chatResponseBridge.handleCompletion).not.toHaveBeenCalled();
    expect(platformRegistry.get).not.toHaveBeenCalled();
  });

  test("routes Chat SDK responses after hydrating on the claiming replica", async () => {
    const chatResponseBridge = {
      ensureDeliverable: mock(async () => true),
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const { consumer, platformRegistry } = createConsumer({ chatResponseBridge });

    await consumer.handleThreadResponse({ id: "job-1", data: basePayload });

    expect(chatResponseBridge.ensureDeliverable).toHaveBeenCalledTimes(1);
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
