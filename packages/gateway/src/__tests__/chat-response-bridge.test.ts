import { describe, expect, mock, test } from "bun:test";
import { ChatResponseBridge } from "../connections/chat-response-bridge";
import { ConversationStateStore } from "../connections/conversation-state-store";
import { InMemoryStateAdapter } from "./fixtures/in-memory-state-adapter";

/**
 * Build a target whose `post(iterable)` drains the AsyncIterable into
 * `collected`. Returns a `drained` promise that resolves when the adapter
 * finishes draining (mirroring real adapter behavior of `target.post`).
 */
function createStreamingTarget() {
  const collected: string[] = [];
  const plainPosts: unknown[] = [];
  let resolveDrained: (() => void) | null = null;
  const drained = new Promise<void>((r) => {
    resolveDrained = r;
  });

  const target = {
    post: mock(async (arg: unknown) => {
      if (arg && typeof (arg as any)[Symbol.asyncIterator] === "function") {
        for await (const chunk of arg as AsyncIterable<string>) {
          collected.push(chunk);
        }
        resolveDrained?.();
        return { id: "msg-stream" };
      }
      plainPosts.push(arg);
      return { id: "msg-plain" };
    }),
  };
  return { target, collected, plainPosts, drained };
}

function createHarness(target: unknown, platform = "slack") {
  const state = new InMemoryStateAdapter();
  const conversationState = new ConversationStateStore(state);
  const manager = {
    getInstance: () => ({
      connection: { platform },
      chat: {
        channel: () => target,
      },
      conversationState,
    }),
    has: () => true,
  };
  return { state, conversationState, manager };
}

const basePayload = {
  messageId: "m1",
  channelId: "123",
  conversationId: "123",
  userId: "u1",
  teamId: "t1",
  timestamp: 0,
  platform: "slack",
  platformMetadata: {
    connectionId: "conn-1",
    chatId: "123",
  },
};

describe("ChatResponseBridge.handleDelta — AsyncIterable streaming", () => {
  test("first delta opens stream with AsyncIterable, subsequent deltas are queued", async () => {
    const { target, collected, drained } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleDelta({ ...basePayload, delta: "hello " }, "session-1");
    await bridge.handleDelta({ ...basePayload, delta: "world" }, "session-1");

    expect(target.post).toHaveBeenCalledTimes(1);
    const postArg = target.post.mock.calls[0]?.[0];
    expect(typeof (postArg as any)?.[Symbol.asyncIterator]).toBe("function");

    await bridge.handleCompletion({ ...basePayload }, "session-1");
    await drained;

    expect(collected).toEqual(["hello ", "world"]);
  });

  test("handleCompletion persists full buffer to conversation state", async () => {
    const { target, drained } = createStreamingTarget();
    const { conversationState, manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleDelta({ ...basePayload, delta: "foo " }, "s");
    await bridge.handleDelta({ ...basePayload, delta: "bar" }, "s");
    await bridge.handleCompletion({ ...basePayload }, "s");
    await drained;

    const history = await conversationState.getHistory("conn-1", "123");
    expect(history).toEqual([
      { role: "assistant", content: "foo bar", name: undefined },
    ]);
  });

  test("sessionReset completion clears history via conversation state", async () => {
    const { target, drained } = createStreamingTarget();
    const { conversationState, manager } = createHarness(target);
    await conversationState.appendHistory("conn-1", "123", {
      role: "user",
      content: "old",
      timestamp: 1,
    });

    const bridge = new ChatResponseBridge(manager as any);
    await bridge.handleDelta({ ...basePayload, delta: "new reply" }, "s");
    await bridge.handleCompletion(
      {
        ...basePayload,
        platformMetadata: {
          ...basePayload.platformMetadata,
          sessionReset: true,
        },
      },
      "s"
    );
    await drained;

    const history = await conversationState.getHistory("conn-1", "123");
    expect(history).toEqual([]);
  });

  test("handleError after partial stream posts fallback so truncation is visible", async () => {
    // Worker was mid-stream (no isFullReplacement) and then errored. The user
    // would see truncated text with no failure indicator unless the gateway
    // posts the fallback "Error: …" message.
    const { target, collected, plainPosts, drained } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleDelta({ ...basePayload, delta: "partial" }, "s");
    await bridge.handleError({ ...basePayload, error: "boom" }, "s");
    await drained;

    expect(collected).toEqual(["partial"]);
    expect(plainPosts).toContain("Error: boom");
  });

  test("handleError after full-replacement delta skips fallback to avoid duplicate", async () => {
    // Worker already delivered a complete, self-contained failure message
    // (e.g. "❌ Session failed: 429 …") via isFullReplacement and then called
    // signalError for bookkeeping. The gateway must NOT post a second
    // "Error: 429 …" — the user has already seen the formatted message.
    const { target, collected, plainPosts, drained } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleDelta(
      {
        ...basePayload,
        delta: "❌ Session failed: 429 rate-limited",
        isFullReplacement: true,
      },
      "s"
    );
    await bridge.handleError(
      { ...basePayload, error: "429 rate-limited" },
      "s"
    );
    await drained;

    expect(collected).toEqual(["❌ Session failed: 429 rate-limited"]);
    expect(plainPosts).toEqual([]);
  });

  test("handleError with no prior stream still posts fallback (worker crashed early)", async () => {
    // No delta was ever sent (e.g. NO_MODEL_CONFIGURED path calls signalError
    // with no preceding sendStreamDelta). The fallback is the only way the
    // user learns anything went wrong.
    const { target, plainPosts } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleError({ ...basePayload, error: "boom" }, "s");

    expect(plainPosts).toContain("Error: boom");
  });

  test("isFullReplacement closes prior stream and opens a new one", async () => {
    const { target } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleDelta({ ...basePayload, delta: "old" }, "s");
    await bridge.handleDelta(
      { ...basePayload, delta: "new", isFullReplacement: true },
      "s"
    );
    await bridge.handleCompletion({ ...basePayload }, "s");

    const iterableCalls = target.post.mock.calls.filter(
      (c) => typeof (c[0] as any)?.[Symbol.asyncIterator] === "function"
    );
    expect(iterableCalls.length).toBe(2);
  });

  test("delta after completion opens a fresh stream (not reused)", async () => {
    const { target, collected } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleDelta({ ...basePayload, delta: "first" }, "s");
    await bridge.handleCompletion({ ...basePayload }, "s");

    await bridge.handleDelta({ ...basePayload, delta: "second" }, "s");
    await bridge.handleCompletion({ ...basePayload }, "s");

    const iterableCalls = target.post.mock.calls.filter(
      (c) => typeof (c[0] as any)?.[Symbol.asyncIterator] === "function"
    );
    expect(iterableCalls.length).toBe(2);
    expect(collected).toEqual(["first", "second"]);
  });

  test("stream rejection falls back to non-streaming post of buffered text", async () => {
    // Adapter that rejects the streaming call (e.g. Slack's chatStream
    // validation when recipient user/team missing) but accepts plain text.
    const plainPosts: unknown[] = [];
    const target = {
      post: mock(async (arg: unknown) => {
        if (arg && typeof (arg as any)[Symbol.asyncIterator] === "function") {
          // Drain the iterator so producer completes, then reject.
          for await (const _ of arg as AsyncIterable<string>) {
            // swallow
          }
          throw new Error(
            "Slack streaming requires recipientUserId and recipientTeamId in options"
          );
        }
        plainPosts.push(arg);
        return { id: "msg-plain" };
      }),
    };
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleDelta({ ...basePayload, delta: "hello " }, "s");
    await bridge.handleDelta({ ...basePayload, delta: "world" }, "s");
    await bridge.handleCompletion({ ...basePayload }, "s");

    // The buffered full text is posted non-streaming as fallback.
    expect(plainPosts).toEqual(["hello world"]);
  });

  test("canHandle returns true for managed connections", () => {
    const { target } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);
    expect(
      bridge.canHandle({
        ...basePayload,
        platformMetadata: { connectionId: "conn-1" },
      } as any)
    ).toBe(true);
  });

  test("canHandle returns false when no connectionId", () => {
    const { target } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);
    expect(
      bridge.canHandle({
        ...basePayload,
        platformMetadata: {},
      } as any)
    ).toBe(false);
  });
});

describe("ChatResponseBridge.handleEphemeral", () => {
  test("renders settings links as native buttons for Chat SDK targets", async () => {
    const posts: unknown[] = [];
    const target = {
      post: async (payload: unknown) => {
        posts.push(payload);
        return { id: "msg-1" };
      },
    };
    const { manager } = createHarness(target, "telegram");
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
});
