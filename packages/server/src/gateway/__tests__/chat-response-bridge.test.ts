import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GuardrailRegistry } from "@lobu/core";
import * as workspaceModule from "../../workspace/index.js";
import { ChatResponseBridge } from "../connections/chat-response-bridge.js";
import { ConversationStateStore } from "../connections/conversation-state-store.js";
import { registerBuiltinGuardrails } from "../guardrails/builtins.js";
import { InMemoryStateAdapter } from "./fixtures/in-memory-state-adapter.js";

/** Poll until `predicate` holds, or throw once `timeoutMs` elapses. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

function createHarness(
  target: unknown,
  platform = "telegram",
  slackPostMessage?: ReturnType<typeof mock>,
  linkContext?: {
    agentId: string;
    organizationId: string;
    publicGatewayUrl: string;
  }
) {
  const state = new InMemoryStateAdapter();
  const conversationState = new ConversationStateStore(state);
  const slackAdapter = slackPostMessage
    ? { client: { chat: { postMessage: slackPostMessage } } }
    : undefined;
  const manager = {
    getInstance: () => ({
      connection: {
        platform,
        agentId: linkContext?.agentId,
        organizationId: linkContext?.organizationId,
      },
      chat: {
        channel: () => target,
        getAdapter: (name: string) =>
          name === "slack" ? slackAdapter : undefined,
      },
      conversationState,
    }),
    has: () => true,
    warmConnection: async () => true,
    getPublicGatewayUrl: () => linkContext?.publicGatewayUrl ?? "",
  };
  return { state, conversationState, manager };
}

let restoreWorkspaceProvider: (() => void) | undefined;

afterEach(() => {
  restoreWorkspaceProvider?.();
  restoreWorkspaceProvider = undefined;
});

function stubWorkspaceProvider(
  getOrgSlug: (organizationId: string) => Promise<string | null>
) {
  const providerSpy = spyOn(
    workspaceModule,
    "getWorkspaceProvider"
  ).mockReturnValue({
    getOrgSlug,
  } as unknown as ReturnType<typeof workspaceModule.getWorkspaceProvider>);
  restoreWorkspaceProvider = () => providerSpy.mockRestore();
  return providerSpy;
}

function stubWorkspaceOrgSlug(slug: string | null) {
  return stubWorkspaceProvider(async () => slug);
}

const basePayload = {
  messageId: "m1",
  channelId: "123",
  conversationId: "123",
  userId: "u1",
  teamId: "t1",
  timestamp: 0,
  platform: "telegram",
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
    await conversationState.appendHistory("conn-1", "123", "123", {
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

  test("handleError suppresses the fallback for SESSION_TIMEOUT (silent retry)", async () => {
    // A timed-out turn is retried automatically by the runs queue and the
    // worker deliberately emits no user-facing crash delta, so the platform
    // fallback must also stay silent — otherwise the user sees a raw
    // "Error: SESSION_TIMEOUT" for a turn that is about to be retried.
    const { target, plainPosts } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleError(
      {
        ...basePayload,
        error: "SESSION_TIMEOUT",
        errorCode: "SESSION_TIMEOUT",
      },
      "s"
    );

    expect(plainPosts).toEqual([]);
  });

  test("handleError renders PROVIDER_TOOL_CALL_FAILED as catalog text, never the raw provider blob", async () => {
    // Seen live on Telegram: a Gemini turn that ends with
    // `function_call_filter: MALFORMED_FUNCTION_CALL` reached the user as a raw
    // `💥 Worker crashed: Provider finish_reason: …` blob. The worker now
    // classifies it, so this bridge — the ONE place a coded error becomes
    // Telegram/Slack output — must swap in the catalog sentence and drop the
    // provider's own unusable finish_reason string entirely.
    const { target, plainPosts } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleError(
      {
        ...basePayload,
        error:
          "Provider finish_reason: function_call_filter: MALFORMED_FUNCTION_CALL",
        errorCode: "PROVIDER_TOOL_CALL_FAILED",
      },
      "s"
    );

    const posted = plainPosts.map((p) => String(p)).join("\n");
    expect(posted).toContain("rejected its own tool call");
    // The three fragments of the raw blob a user must never see.
    expect(posted).not.toContain("MALFORMED_FUNCTION_CALL");
    expect(posted).not.toContain("finish_reason");
    expect(posted).not.toContain("Worker crashed");
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

  test("ensureDeliverable hydrates and returns true for servable connections", async () => {
    const { target } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);
    expect(
      await bridge.ensureDeliverable({
        ...basePayload,
        platformMetadata: { connectionId: "conn-1" },
      } as any)
    ).toBe(true);
  });

  test("ensureDeliverable returns false when no connectionId", async () => {
    const { target } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);
    expect(
      await bridge.ensureDeliverable({
        ...basePayload,
        platformMetadata: {},
      } as any)
    ).toBe(false);
  });

  test("ensureDeliverable returns false when this replica cannot run the connection", async () => {
    const { target } = createStreamingTarget();
    const { manager } = createHarness(target);
    (manager as any).warmConnection = async () => false;
    const bridge = new ChatResponseBridge(manager as any);
    expect(
      await bridge.ensureDeliverable({
        ...basePayload,
        platformMetadata: { connectionId: "conn-1" },
      } as any)
    ).toBe(false);
  });
});

describe("ChatResponseBridge.handleDelta — Slack markdown_text path", () => {
  test("Slack accumulates deltas and posts via chat.postMessage with markdown_text", async () => {
    const { target } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { manager } = createHarness(target, "slack", slackPost);
    const bridge = new ChatResponseBridge(manager as any);

    const slackPayload = {
      ...basePayload,
      platform: "slack",
      channelId: "slack:C123",
      conversationId: "slack:C123:1700000000.123456",
      platformMetadata: {
        connectionId: "conn-1",
        chatId: "slack:C123",
      },
    };

    await bridge.handleDelta({ ...slackPayload, delta: "hello " }, "s");
    await bridge.handleDelta({ ...slackPayload, delta: "world" }, "s");
    await bridge.handleCompletion(slackPayload, "s");

    // SDK target.post should NOT be called for Slack — we use markdown_text.
    expect(target.post).not.toHaveBeenCalled();
    expect(slackPost).toHaveBeenCalledTimes(1);
    expect(slackPost.mock.calls[0]?.[0]).toMatchObject({
      channel: "C123",
      thread_ts: "1700000000.123456",
      markdown_text: "hello world",
    });
  });

  test("Slack decodes HTML entities and strips empty markdown links", async () => {
    const { target } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { manager } = createHarness(target, "slack", slackPost);
    const bridge = new ChatResponseBridge(manager as any);

    const slackPayload = {
      ...basePayload,
      platform: "slack",
      channelId: "slack:C123",
      conversationId: "slack:C123",
      platformMetadata: {
        connectionId: "conn-1",
        chatId: "slack:C123",
      },
    };

    await bridge.handleDelta(
      {
        ...slackPayload,
        delta: "&lt;summary&gt;hi&lt;/summary&gt; [foo:1, 2]() bar",
      },
      "s"
    );
    await bridge.handleCompletion(slackPayload, "s");

    expect(slackPost).toHaveBeenCalledTimes(1);
    expect(slackPost.mock.calls[0]?.[0]).toMatchObject({
      markdown_text: "<summary>hi</summary> foo:1, 2 bar",
    });
  });

  test("Slack chunks long content on paragraph boundaries", async () => {
    const { target } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { manager } = createHarness(target, "slack", slackPost);
    const bridge = new ChatResponseBridge(manager as any);

    const slackPayload = {
      ...basePayload,
      platform: "slack",
      channelId: "slack:C123",
      conversationId: "slack:C123",
      platformMetadata: {
        connectionId: "conn-1",
        chatId: "slack:C123",
      },
    };

    // Build content > 11000 chars with explicit paragraph boundaries every ~5000 chars.
    const para = `${"x".repeat(5000)}`;
    const body = `${para}\n\n${para}\n\n${para}`;

    await bridge.handleDelta({ ...slackPayload, delta: body }, "s");
    await bridge.handleCompletion(slackPayload, "s");

    expect(slackPost).toHaveBeenCalledTimes(2);
    // Each posted chunk must NOT split mid-paragraph.
    for (const call of slackPost.mock.calls) {
      const md = (call[0] as { markdown_text: string }).markdown_text;
      expect(md.length).toBeLessThanOrEqual(11_000);
      // Chunks must start/end at paragraph boundaries (no leading/trailing
      // partial paragraph fragments split mid-content).
      expect(md.startsWith("xxxx")).toBe(true);
    }
  });

  test("Slack isFullReplacement discards prior buffered content", async () => {
    const { target } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { manager } = createHarness(target, "slack", slackPost);
    const bridge = new ChatResponseBridge(manager as any);

    const slackPayload = {
      ...basePayload,
      platform: "slack",
      channelId: "slack:C123",
      conversationId: "slack:C123",
      platformMetadata: {
        connectionId: "conn-1",
        chatId: "slack:C123",
      },
    };

    await bridge.handleDelta({ ...slackPayload, delta: "old streamed" }, "s");
    await bridge.handleDelta(
      { ...slackPayload, delta: "new content", isFullReplacement: true },
      "s"
    );
    await bridge.handleCompletion(slackPayload, "s");

    expect(slackPost).toHaveBeenCalledTimes(1);
    expect(slackPost.mock.calls[0]?.[0]).toMatchObject({
      markdown_text: "new content",
    });
  });
});

describe("ChatResponseBridge.handleCompletion — multi-replica finalText", () => {
  // Under N>1 replicas the `thread_response` queue is drained competitively
  // (FOR UPDATE SKIP LOCKED, no per-conversation affinity), so a run's delta
  // rows and its terminal row can land on different pods. A post-once renderer
  // (Slack) that completes on a pod which buffered no/partial deltas must
  // render from the worker's authoritative `finalText`, not the local buffer.
  const slackPayload = {
    ...basePayload,
    platform: "slack",
    channelId: "slack:C123",
    conversationId: "slack:C123:1700000000.123456",
    platformMetadata: {
      connectionId: "conn-1",
      chatId: "slack:C123",
    },
  };

  test("suggest-followups posts a chat card after the terminal output passes", async () => {
    const target = createStreamingTarget().target;
    const slackPostMessage = mock(async () => ({ ts: "1" }));
    const { manager } = createHarness(target, "slack", slackPostMessage, {
      agentId: "agent-1",
      organizationId: "org-1",
      publicGatewayUrl: "",
    });
    const bridge = new ChatResponseBridge(manager as any, async () => ({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
    }));
    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    bridge.setGuardrails(
      registry,
      {
        getSettings: async () => ({
          guardrails: ["suggest-followups"],
        }),
      } as any
    );
    const postSuggestion = mock(async () => ({ id: "s_1" }));
    bridge.setInteractionService({ postSuggestion } as any);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"prompts":[{"title":"Show details","message":"Show me the details"}]}',
              },
            },
          ],
        })
      )) as typeof fetch;

    try {
      await bridge.handleCompletion(
        {
          ...slackPayload,
          finalText:
            "The connector runs every fifteen minutes and currently has plenty of rate-limit headroom.",
          processedMessageIds: ["m1"],
          toolsUsed: [],
          platformMetadata: {
            ...slackPayload.platformMetadata,
            agentId: "agent-1",
            organizationId: "org-1",
          },
        },
        "s"
      );
      // Enrichment is intentionally fire-and-forget (it must not block the
      // concurrency-1 delivery worker), so handleCompletion returns before the
      // chip is posted. Wait for the detached chain rather than restoring env
      // out from under it.
      await waitFor(() => postSuggestion.mock.calls.length > 0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(postSuggestion).toHaveBeenCalledTimes(1);
    expect(postSuggestion.mock.calls[0]?.[7]).toEqual([
      { title: "Show details", message: "Show me the details" },
    ]);
  });

  test("Slack completion with NO local stream posts payload.finalText", async () => {
    // Simulates the terminal row arriving on a replica that never claimed any
    // delta rows — `this.streams` has no entry for this key.
    const { target } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { manager } = createHarness(target, "slack", slackPost);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleCompletion(
      {
        ...slackPayload,
        finalText: "full reply from the worker",
        processedMessageIds: ["m1"],
      },
      "s"
    );

    expect(target.post).not.toHaveBeenCalled();
    expect(slackPost).toHaveBeenCalledTimes(1);
    expect(slackPost.mock.calls[0]?.[0]).toMatchObject({
      channel: "C123",
      thread_ts: "1700000000.123456",
      markdown_text: "full reply from the worker",
    });
  });

  test("Slack completion appends a Lobu transcript footer only to delivered text", async () => {
    stubWorkspaceOrgSlug("acme");
    const { target } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { conversationState, manager } = createHarness(
      target,
      "slack",
      slackPost,
      {
        agentId: "agent-1",
        organizationId: "org-1",
        publicGatewayUrl: "https://app.lobu.com/lobu",
      }
    );
    const bridge = new ChatResponseBridge(manager as any);
    const expectedText =
      "full reply from the worker\n\n[View in Lobu ↗](https://app.lobu.com/acme/agents/agent-1/conversations/slack%3AC123%3A1700000000.123456)";

    await bridge.handleCompletion(
      {
        ...slackPayload,
        finalText: "full reply from the worker",
        processedMessageIds: ["m1"],
      },
      "s"
    );

    expect(slackPost).toHaveBeenCalledTimes(1);
    expect(slackPost.mock.calls[0]?.[0]).toMatchObject({
      markdown_text: expectedText,
    });
    expect(
      await conversationState.getHistory(
        "conn-1",
        "slack:C123",
        "slack:C123:1700000000.123456"
      )
    ).toEqual([
      {
        role: "assistant",
        content: "full reply from the worker",
        name: undefined,
      },
    ]);
  });

  test("cross-org preview footer uses the Behavior org from the worker payload", async () => {
    const getOrgSlug = mock(async (organizationId: string) =>
      organizationId === "org-behavior" ? "behavior-org" : "connection-org"
    );
    stubWorkspaceProvider(getOrgSlug);
    const { target } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { manager } = createHarness(target, "slack", slackPost, {
      agentId: "agent-1",
      organizationId: "org-connection",
      publicGatewayUrl: "https://app.lobu.com/lobu",
    });
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleCompletion(
      {
        ...slackPayload,
        organizationId: "org-behavior",
        finalText: "cross-org reply",
        processedMessageIds: ["m1"],
      },
      "s"
    );

    expect(getOrgSlug).toHaveBeenCalledWith("org-behavior");
    expect(slackPost.mock.calls[0]?.[0]).toMatchObject({
      markdown_text:
        "cross-org reply\n\n[View in Lobu ↗](https://app.lobu.com/behavior-org/agents/agent-1/conversations/slack%3AC123%3A1700000000.123456)",
    });
  });

  test("missing organization slug leaves the completed answer unchanged", async () => {
    stubWorkspaceOrgSlug(null);
    const { target } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { manager } = createHarness(target, "slack", slackPost, {
      agentId: "agent-1",
      organizationId: "org-1",
      publicGatewayUrl: "https://app.lobu.com/lobu",
    });
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleCompletion(
      {
        ...slackPayload,
        finalText: "full reply from the worker",
        processedMessageIds: ["m1"],
      },
      "s"
    );

    expect(slackPost.mock.calls[0]?.[0]).toMatchObject({
      markdown_text: "full reply from the worker",
    });
  });

  test("guardrail-blocked completion never appends or posts the footer", async () => {
    const providerSpy = stubWorkspaceOrgSlug("acme");
    const { target, plainPosts } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { manager } = createHarness(target, "slack", slackPost, {
      agentId: "agent-1",
      organizationId: "org-1",
      publicGatewayUrl: "https://app.lobu.com/lobu",
    });
    const bridge = new ChatResponseBridge(manager as any);
    const scanner = (bridge as any).outputGuardrail;
    scanner.hasOutputGuardrails = async () => true;
    scanner.scanFinal = async () => ({
      guardrail: "test-output",
      reason: "unsafe output",
    });

    await bridge.handleCompletion(
      {
        ...slackPayload,
        finalText: "unsafe answer",
        processedMessageIds: ["m1"],
      },
      "s"
    );

    expect(slackPost).not.toHaveBeenCalled();
    expect(plainPosts).toEqual(["Message blocked by guardrail: unsafe output"]);
    expect(plainPosts.join("\n")).not.toContain("View in Lobu");
    expect(providerSpy).not.toHaveBeenCalled();
  });

  test("live-streaming completion does not create a history-only footer", async () => {
    const providerSpy = stubWorkspaceOrgSlug("acme");
    const { target, collected, drained } = createStreamingTarget();
    const { conversationState, manager } = createHarness(
      target,
      "telegram",
      undefined,
      {
        agentId: "agent-1",
        organizationId: "org-1",
        publicGatewayUrl: "https://app.lobu.com/lobu",
      }
    );
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleDelta({ ...basePayload, delta: "streamed reply" }, "s");
    await bridge.handleCompletion(
      { ...basePayload, finalText: "streamed reply" },
      "s"
    );
    await drained;

    expect(collected).toEqual(["streamed reply"]);
    expect(await conversationState.getHistory("conn-1", "123")).toEqual([
      { role: "assistant", content: "streamed reply", name: undefined },
    ]);
    expect(providerSpy).not.toHaveBeenCalled();
  });

  test("Slack completion prefers finalText over a partial local buffer", async () => {
    // This replica claimed only a subset of the deltas, so its buffer is
    // incomplete. finalText is authoritative and must win.
    const { target } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { manager } = createHarness(target, "slack", slackPost);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleDelta(
      { ...slackPayload, delta: "partial " },
      "s"
    );
    await bridge.handleCompletion(
      {
        ...slackPayload,
        finalText: "partial reply complete and whole",
        processedMessageIds: ["m1"],
      },
      "s"
    );

    expect(slackPost).toHaveBeenCalledTimes(1);
    expect(slackPost.mock.calls[0]?.[0]).toMatchObject({
      markdown_text: "partial reply complete and whole",
    });
  });

  test("Slack completion persists finalText to history with no local stream", async () => {
    const { target } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { conversationState, manager } = createHarness(
      target,
      "slack",
      slackPost
    );
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleCompletion(
      {
        ...slackPayload,
        finalText: "persisted full reply",
        processedMessageIds: ["m1"],
      },
      "s"
    );

    // Thread-scoped: the assistant reply lands under the conversation's
    // (channel, conversationId) bucket, not the bare channel.
    const history = await conversationState.getHistory(
      "conn-1",
      "slack:C123",
      "slack:C123:1700000000.123456"
    );
    expect(history).toEqual([
      { role: "assistant", content: "persisted full reply", name: undefined },
    ]);
  });

  test("two pods: pod A buffers deltas, pod B completes — reply delivered exactly once", async () => {
    // Faithful two-replica reproducer. Each ChatResponseBridge has its own
    // pod-local `streams` Map, so two instances model two pods. The competitive
    // SKIP-LOCKED queue can route a run's deltas to pod A and its terminal row
    // to pod B. On origin/main pod B has no local stream and drops the Slack
    // reply (the bug); with finalText, pod B delivers and pod A — which never
    // receives the terminal row — never posts, so the reply lands exactly once.
    const slackPostA = mock(async () => ({ ok: true, ts: "a.1" }));
    const slackPostB = mock(async () => ({ ok: true, ts: "b.1" }));
    const { target: targetA } = createStreamingTarget();
    const { target: targetB } = createStreamingTarget();
    const podA = new ChatResponseBridge(
      createHarness(targetA, "slack", slackPostA).manager as any
    );
    const podB = new ChatResponseBridge(
      createHarness(targetB, "slack", slackPostB).manager as any
    );

    // Pod A claims the delta rows and buffers them locally.
    await podA.handleDelta({ ...slackPayload, delta: "hello " }, "s");
    await podA.handleDelta({ ...slackPayload, delta: "world" }, "s");

    // Pod B claims the terminal row (it never saw the deltas).
    await podB.handleCompletion(
      {
        ...slackPayload,
        finalText: "hello world",
        processedMessageIds: ["m1"],
      },
      "s"
    );

    // Exactly-once: pod B posted the full reply; pod A never did.
    expect(slackPostB).toHaveBeenCalledTimes(1);
    expect(slackPostB.mock.calls[0]?.[0]).toMatchObject({
      markdown_text: "hello world",
    });
    expect(slackPostA).not.toHaveBeenCalled();
  });

  test("live-streaming (Telegram) completion with NO local stream does NOT re-post finalText", async () => {
    // Default strategy streamed its deltas on whichever replica claimed them.
    // Re-posting finalText here would duplicate the reply, so a stream-less
    // completion is a no-op for live-streaming platforms.
    const { target } = createStreamingTarget();
    const { manager } = createHarness(target, "telegram");
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleCompletion(
      {
        ...basePayload,
        finalText: "should not be posted again",
        processedMessageIds: ["m1"],
      },
      "s"
    );

    expect(target.post).not.toHaveBeenCalled();
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
