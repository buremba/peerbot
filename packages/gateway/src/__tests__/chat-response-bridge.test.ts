import { describe, expect, test } from "bun:test";
import { ChatResponseBridge } from "../connections/chat-response-bridge";

function createRedisMock() {
  return {
    pipeline() {
      return {
        rpush() {
          return this;
        },
        ltrim() {
          return this;
        },
        expire() {
          return this;
        },
        exec: async () => [],
      };
    },
  };
}

describe("ChatResponseBridge.handleEphemeral", () => {
  test("renders settings links as native buttons for Chat SDK targets", async () => {
    const posts: unknown[] = [];
    const target = {
      post: async (payload: unknown) => {
        posts.push(payload);
        return { id: "msg-1" };
      },
    };
    const manager = {
      getInstance: () => ({
        connection: { platform: "telegram" },
        chat: {
          channel: () => target,
        },
      }),
      getServices: () => ({
        getQueue: () => ({
          getRedisClient: () => createRedisMock(),
        }),
      }),
    };

    const bridge = new ChatResponseBridge(manager as any);
    await bridge.handleEphemeral({
      messageId: "m1",
      channelId: "123",
      conversationId: "123",
      userId: "u1",
      teamId: "telegram",
      timestamp: Date.now(),
      platform: "telegram",
      platformMetadata: {
        connectionId: "conn-1",
        chatId: "123",
      },
      content:
        "Setup required: add OpenAI in settings before this bot can respond.\n\n[Open Agent Settings](https://example.com/connect/claim?claim=abc123)",
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]).toBeObject();
    expect(posts[0]).toHaveProperty("card");
    expect(posts[0]).toHaveProperty("fallbackText");
    expect((posts[0] as { fallbackText: string }).fallbackText).toContain(
      "Open Agent Settings: https://example.com/connect/claim?claim=abc123"
    );
  });

  test("buffers telegram markdown until completion", async () => {
    const posts: unknown[] = [];
    const target = {
      post: async (payload: unknown) => {
        posts.push(payload);
        return { id: "msg-1", threadId: "123" };
      },
    };
    const manager = {
      getInstance: () => ({
        connection: { platform: "telegram" },
        chat: {
          channel: () => target,
        },
      }),
      getServices: () => ({
        getQueue: () => ({
          getRedisClient: () => createRedisMock(),
        }),
      }),
    };

    const bridge = new ChatResponseBridge(manager as any);
    const basePayload = {
      messageId: "m1",
      channelId: "123",
      conversationId: "123",
      userId: "u1",
      teamId: "telegram",
      timestamp: Date.now(),
      platform: "telegram",
      platformMetadata: {
        connectionId: "conn-1",
        chatId: "123",
      },
    };

    await bridge.handleDelta(
      {
        ...basePayload,
        delta: "*Reason",
      },
      "session-1"
    );
    await bridge.handleDelta(
      {
        ...basePayload,
        delta: "ing:* hello",
      },
      "session-1"
    );

    expect(posts).toHaveLength(0);

    await bridge.handleCompletion(basePayload, "session-1");

    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ markdown: "*Reasoning:* hello" });
  });
});
