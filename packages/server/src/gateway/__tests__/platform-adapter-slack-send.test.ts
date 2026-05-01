import { describe, expect, mock, test } from "bun:test";
import { ChatInstanceManager } from "../connections/chat-instance-manager.js";

/**
 * Helper: create a ChatInstanceManager with mocked internals for testing
 * sendPlatformMessage without requiring Redis.
 */
function createTestManager(overrides: {
  listConnections: (...args: any[]) => Promise<any[]>;
  has: (id: string) => boolean;
  getInstance: (id: string) => any;
}): ChatInstanceManager {
  const manager = new ChatInstanceManager();
  // Patch internal methods used by sendPlatformMessage / selectConnectionForPlatform
  (manager as any).listConnections = overrides.listConnections;
  manager.has = overrides.has;
  manager.getInstance = overrides.getInstance;
  return manager;
}

describe("ChatInstanceManager Slack sendPlatformMessage", () => {
  test("posts top-level messages through the channel API", async () => {
    const post = mock(async () => ({ ts: "1700000000.000100" }));
    const channel = mock(() => ({ post }));

    const manager = createTestManager({
      listConnections: async () => [
        {
          id: "conn-1",
          platform: "slack",
          agentId: "system:connection:slack",
          config: {
            platform: "slack",
            botToken: "xoxb",
            signingSecret: "sig",
          },
          settings: { allowGroups: true },
          metadata: {},
          status: "active",
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      has: () => true,
      getInstance: () => ({
        chat: {
          channel,
        },
      }),
    });

    const result = await manager.sendPlatformMessage("slack", "@me hello", {
      agentId: "agent-1",
      channelId: "C123",
      teamId: "T123",
    });

    expect(result.messageId).toBe("1700000000.000100");
    expect(channel).toHaveBeenCalledTimes(1);
    expect(channel.mock.calls[0]?.[0]).toBe("slack:C123");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe("@me hello");
  });

  test("posts thread replies through a resolved thread", async () => {
    const post = mock(async () => ({ ts: "1700000000.000200" }));
    const createThread = mock(async () => ({ post }));
    const getAdapter = mock(() => ({ name: "slack" }));

    const manager = createTestManager({
      listConnections: async () => [
        {
          id: "conn-1",
          platform: "slack",
          agentId: "system:connection:slack:T123",
          config: {
            platform: "slack",
            botToken: "xoxb",
            signingSecret: "sig",
          },
          settings: { allowGroups: true },
          metadata: { teamId: "T123" },
          status: "active",
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      has: () => true,
      getInstance: () => ({
        chat: {
          getAdapter,
          createThread,
        },
      }),
    });

    const result = await manager.sendPlatformMessage("slack", "@me follow up", {
      agentId: "agent-1",
      channelId: "C123",
      conversationId: "1700000000.000100",
      teamId: "T123",
    });

    expect(result.messageId).toBe("1700000000.000200");
    expect(getAdapter).toHaveBeenCalledTimes(1);
    expect(getAdapter.mock.calls[0]?.[0]).toBe("slack");
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(createThread.mock.calls[0]?.[1]).toBe(
      "slack:C123:1700000000.000100"
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe("@me follow up");
  });
});
