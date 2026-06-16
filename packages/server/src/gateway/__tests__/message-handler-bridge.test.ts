import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ConversationStateStore } from "../connections/conversation-state-store.js";
import {
  type InboundAttachmentLike,
  ingestInboundAttachments,
  isSenderAllowed,
  MessageHandlerBridge,
  parsePreviewLinkCode,
} from "../connections/message-handler-bridge.js";
import type { PlatformConnection } from "../connections/types.js";
import { InMemoryStateAdapter } from "./fixtures/in-memory-state-adapter.js";
import {
  type ArtifactTestEnv,
  createArtifactTestEnv,
  TEST_GATEWAY_URL,
} from "./setup.js";

describe("parsePreviewLinkCode", () => {
  test("bare code paste in a DM", () => {
    expect(parsePreviewLinkCode("crm-TGHE0Z", false)).toBe("crm-TGHE0Z");
  });
  test("multi-segment slug bare code", () => {
    expect(parsePreviewLinkCode("food-ordering-ABC123", false)).toBe(
      "food-ordering-ABC123"
    );
  });
  test("`link <code>`", () => {
    expect(parsePreviewLinkCode("link crm-TGHE0Z", false)).toBe("crm-TGHE0Z");
  });
  test("`/lobu link <code>` delivered as text", () => {
    expect(parsePreviewLinkCode("/lobu link crm-TGHE0Z", false)).toBe(
      "crm-TGHE0Z"
    );
  });
  test("`/link <code>`", () => {
    expect(parsePreviewLinkCode("/link crm-TGHE0Z", false)).toBe("crm-TGHE0Z");
  });
  test("bare code is ignored in a channel (false-positive guard)", () => {
    expect(parsePreviewLinkCode("crm-TGHE0Z", true)).toBeNull();
  });
  test("`link me` (no hyphenated code) is not a link", () => {
    expect(parsePreviewLinkCode("link me", false)).toBeNull();
  });
  test("normal chatter is ignored", () => {
    expect(
      parsePreviewLinkCode("can you help me link the accounts", false)
    ).toBeNull();
  });
});

describe("isSenderAllowed", () => {
  test.each([
    { allow: undefined, user: "user-1", expected: true, label: "no allowlist" },
    { allow: [], user: "user-1", expected: false, label: "empty allowlist" },
    { allow: ["user-1"], user: "user-1", expected: true, label: "listed user" },
    {
      allow: ["user-1"],
      user: "user-2",
      expected: false,
      label: "unlisted user",
    },
  ] as const)("$label → $expected", ({ allow, user, expected }) => {
    expect(isSenderAllowed(allow as string[] | undefined, user)).toBe(expected);
  });
});

describe("ingestInboundAttachments", () => {
  let env: ArtifactTestEnv;
  const ingest = (atts: InboundAttachmentLike[] | undefined) =>
    ingestInboundAttachments(atts, env.artifactStore, TEST_GATEWAY_URL);

  beforeEach(() => {
    env = createArtifactTestEnv();
  });

  afterEach(() => env.cleanup());

  test("returns empty arrays when there are no attachments", async () => {
    const result = await ingest(undefined);
    expect(result).toEqual({ files: [], audioBytes: [] });
  });

  test("publishes every attachment as an artifact and surfaces a signed downloadUrl", async () => {
    let pdfFetched = 0;
    const { files } = await ingest([
      {
        type: "image",
        name: "screenshot.png",
        mimeType: "image/png",
        data: Buffer.from("png-bytes"),
      },
      {
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        fetchData: async () => {
          pdfFetched += 1;
          return Buffer.from("pdf-bytes");
        },
      },
    ]);

    expect(pdfFetched).toBe(1);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      name: "screenshot.png",
      mimetype: "image/png",
      size: Buffer.from("png-bytes").length,
    });
    expect(files[1]).toMatchObject({
      name: "report.pdf",
      mimetype: "application/pdf",
      size: Buffer.from("pdf-bytes").length,
    });
    for (const file of files) {
      expect(file.id).toBeTruthy();
      expect(file.downloadUrl).toContain("/api/v1/files/");
      expect(file.downloadUrl).toContain("token=");
    }
  });

  test("audio attachments are published AND surfaced for transcription", async () => {
    const { files, audioBytes } = await ingest([
      {
        type: "audio",
        name: "voice.ogg",
        mimeType: "audio/ogg",
        fetchData: async () => Buffer.from("opus-bytes"),
      },
      {
        type: "audio",
        name: "alt.ogg",
        mimeType: "application/ogg",
        fetchData: async () => Buffer.from("vorbis-bytes"),
      },
    ]);

    // Audio still goes through artifact publishing so the worker can refer
    // to the original recording, AND its bytes are returned for immediate
    // transcription.
    expect(files).toHaveLength(2);
    expect(audioBytes).toHaveLength(2);
    expect(audioBytes[0]?.buffer.toString()).toBe("opus-bytes");
    expect(audioBytes[0]?.mimeType).toBe("audio/ogg");
    expect(audioBytes[1]?.mimeType).toBe("application/ogg");
  });

  // A bad attachment must never abort the rest of the batch — whether it has
  // no fetchable bytes or its fetchData throws, the good one still publishes.
  test.each([
    {
      label: "no fetchable bytes",
      bad: { type: "file", name: "empty.txt", mimeType: "text/plain" },
    },
    {
      label: "fetchData throws",
      bad: {
        type: "file",
        name: "boom.bin",
        mimeType: "application/octet-stream",
        fetchData: async () => {
          throw new Error("network down");
        },
      },
    },
  ] as const)("skips $label and still publishes the rest of the batch", async ({
    bad,
  }) => {
    const { files } = await ingest([
      bad as InboundAttachmentLike,
      {
        type: "file",
        name: "ok.txt",
        mimeType: "text/plain",
        data: Buffer.from("ok"),
      },
    ]);

    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("ok.txt");
  });

  test("derives a filename from mimeType + index when none is provided", async () => {
    const { files } = await ingest([
      { type: "image", mimeType: "image/jpeg", data: Buffer.from("jpg") },
    ]);
    expect(files[0]?.name).toBe("image-1.jpeg");
  });
});

/**
 * MessageHandlerBridge.handleMessage previously had zero coverage despite
 * being the single entry point for every inbound platform message. The
 * thread-history backfill bug — bot mentioned mid-thread had no context —
 * lived here undetected because no test exercised this path.
 *
 * These tests pin the backfill behavior so future regressions trip CI.
 */

const CONN_ID = "conn-test";
const CHANNEL_ID = "C123";
const THREAD_ID = "slack:C123:1700000000.000100";
const TEMPLATE_AGENT_ID = "agent-template";

function buildConnection(): PlatformConnection {
  return {
    id: CONN_ID,
    platform: "slack",
    agentId: TEMPLATE_AGENT_ID,
    config: { platform: "slack" } as any,
    settings: { allowGroups: true } as any,
    metadata: {
      botUsername: "testbot",
      botUserId: "U_BOT",
    },
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  };
}

function createBridgeHarness(opts: {
  fetchMessages?: ReturnType<typeof mock> | undefined;
  withAdapter?: boolean;
}) {
  const state = new InMemoryStateAdapter();
  const conversationState = new ConversationStateStore(state);
  const connection = buildConnection();
  const enqueueMessage = mock(async () => undefined);

  const services = {
    getArtifactStore: () => null,
    getPublicGatewayUrl: () => "https://gateway.example.com",
    getChannelBindingService: () => undefined,
    getAgentMetadataStore: () => undefined,
    getUserAgentsStore: () => undefined,
    getTranscriptionService: () => undefined,
    getAgentSettingsStore: () => undefined,
    getDeclaredAgentRegistry: () => undefined,
    getQueueProducer: () => ({ enqueueMessage }),
  } as any;

  const manager = {
    has: () => true,
    getInstance: () => ({ connection, conversationState }),
  } as any;

  const bridge = new MessageHandlerBridge(connection, services, manager);

  let adapter: unknown;
  if (opts.withAdapter === false) {
    adapter = undefined;
  } else if (opts.fetchMessages === undefined && opts.withAdapter !== true) {
    adapter = undefined;
  } else if (opts.fetchMessages) {
    adapter = { fetchMessages: opts.fetchMessages };
  } else {
    adapter = {};
  }

  return { bridge, conversationState, enqueueMessage, adapter };
}

function makeMessage(overrides: Record<string, any> = {}) {
  return {
    id: "M_NEW",
    text: "<@U_BOT> what was the prior context?",
    author: {
      userId: "U_USER",
      userName: "alice",
      fullName: "Alice",
      isBot: false,
      isMe: false,
    },
    raw: {},
    attachments: [],
    metadata: { dateSent: new Date(), edited: false },
    ...overrides,
  };
}

function makeThread(adapter: unknown) {
  return {
    id: THREAD_ID,
    channelId: CHANNEL_ID,
    adapter,
    subscribe: mock(async () => undefined),
    post: mock(async () => undefined),
    startTyping: mock(async () => undefined),
  };
}

function priorMessage(id: string, text: string, isMe: boolean, whenMs: number) {
  return {
    id,
    text,
    author: {
      userId: isMe ? "U_BOT" : "U_USER",
      userName: isMe ? "testbot" : "alice",
      fullName: isMe ? "TestBot" : "Alice",
      isBot: isMe,
      isMe,
    },
    raw: {},
    attachments: [],
    metadata: { dateSent: new Date(whenMs), edited: false },
  };
}

describe("MessageHandlerBridge.handleMessage — thread backfill", () => {
  test("first mention with empty history backfills via adapter.fetchMessages", async () => {
    const fetchMessages = mock(async () => ({
      messages: [
        priorMessage("M1", "favorite color is teal", false, 1_700_000_001_000),
        priorMessage("M2", "I drive a Civic", false, 1_700_000_002_000),
        // Drop the current mention — handler should skip it by id.
        priorMessage(
          "M_NEW",
          "<@U_BOT> what was the prior context?",
          false,
          1_700_000_003_000
        ),
      ],
    }));
    const { bridge, conversationState, adapter, enqueueMessage } =
      createBridgeHarness({ fetchMessages });
    const thread = makeThread(adapter);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(fetchMessages).toHaveBeenCalledTimes(1);
    expect(fetchMessages.mock.calls[0]?.[0]).toBe(THREAD_ID);
    expect(fetchMessages.mock.calls[0]?.[1]).toEqual({
      limit: 50,
      direction: "forward",
    });

    const entries = await conversationState.getEntries(CONN_ID, CHANNEL_ID, THREAD_ID);
    // 2 backfilled (current message id is skipped) + the current mention
    // message (mention text stripped of `<@U_BOT>`).
    expect(entries.map((e) => e.content)).toEqual([
      "favorite color is teal",
      "I drive a Civic",
      "what was the prior context?",
    ]);
    expect(entries[0]?.role).toBe("user");

    // Worker payload's conversationHistory was snapshotted AFTER backfill
    // but BEFORE the new mention was appended — so backfill is visible
    // and the current message is not (it gets passed via messageText).
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const payload = enqueueMessage.mock.calls[0]?.[0] as any;
    const history = payload.platformMetadata.conversationHistory;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      role: "user",
      content: "favorite color is teal",
    });
  });

  test("backfilled bot replies are tagged role=assistant", async () => {
    const fetchMessages = mock(async () => ({
      messages: [
        priorMessage("M1", "Alice: hi", false, 1),
        priorMessage("M2", "Hi Alice — how can I help?", true, 2),
      ],
    }));
    const { bridge, conversationState, adapter } = createBridgeHarness({
      fetchMessages,
    });
    const thread = makeThread(adapter);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    const entries = await conversationState.getEntries(CONN_ID, CHANNEL_ID, THREAD_ID);
    expect(entries[0]?.role).toBe("user");
    expect(entries[1]?.role).toBe("assistant");
  });

  test("second mention in the same thread does not refetch — claim is one-shot", async () => {
    const fetchMessages = mock(async () => ({
      messages: [priorMessage("M1", "hello", false, 1)],
    }));
    const { bridge, adapter } = createBridgeHarness({ fetchMessages });
    const thread = makeThread(adapter);

    await bridge.handleMessage(thread, makeMessage({ id: "M_A" }), "mention");
    await bridge.handleMessage(thread, makeMessage({ id: "M_B" }), "mention");

    expect(fetchMessages).toHaveBeenCalledTimes(1);
  });

  test("DM source skips backfill — DMs are linear, no hidden history", async () => {
    const fetchMessages = mock(async () => ({ messages: [] }));
    const { bridge, adapter } = createBridgeHarness({ fetchMessages });
    const thread = makeThread(adapter);

    await bridge.handleMessage(thread, makeMessage(), "dm");

    expect(fetchMessages).not.toHaveBeenCalled();
  });

  test("subscribed source also backfills if no prior claim exists", async () => {
    const fetchMessages = mock(async () => ({
      messages: [priorMessage("M1", "earlier note", false, 1)],
    }));
    const { bridge, conversationState, adapter } = createBridgeHarness({
      fetchMessages,
    });
    const thread = makeThread(adapter);

    await bridge.handleMessage(thread, makeMessage(), "subscribed");

    expect(fetchMessages).toHaveBeenCalledTimes(1);
    const entries = await conversationState.getEntries(CONN_ID, CHANNEL_ID, THREAD_ID);
    expect(entries.map((e) => e.content)).toContain("earlier note");
  });

  test("fetchMessages failure releases the claim so the next event retries", async () => {
    let calls = 0;
    const fetchMessages = mock(async () => {
      calls++;
      if (calls === 1) throw new Error("Slack rate limited");
      return { messages: [priorMessage("M1", "recovered", false, 1)] };
    });
    const { bridge, conversationState, adapter } = createBridgeHarness({
      fetchMessages,
    });
    const thread = makeThread(adapter);

    // First mention — fetch throws, marker is released.
    await bridge.handleMessage(thread, makeMessage({ id: "M_A" }), "mention");
    expect(fetchMessages).toHaveBeenCalledTimes(1);
    let entries = await conversationState.getEntries(CONN_ID, CHANNEL_ID, THREAD_ID);
    // Only the current message survives — no backfill from the throw.
    expect(entries.map((e) => e.content)).toEqual([
      "what was the prior context?",
    ]);

    // Second mention — claim is free, fetch retries and succeeds.
    await bridge.handleMessage(thread, makeMessage({ id: "M_B" }), "mention");
    expect(fetchMessages).toHaveBeenCalledTimes(2);
    entries = await conversationState.getEntries(CONN_ID, CHANNEL_ID, THREAD_ID);
    expect(entries.map((e) => e.content)).toContain("recovered");
  });

  test("adapter without fetchMessages does not retry-storm", async () => {
    // Some adapters may not implement fetchMessages. We must keep the claim
    // (treating it as success) so subsequent events don't re-probe a
    // missing capability on every message.
    const { bridge, conversationState } = createBridgeHarness({
      withAdapter: true,
    });
    const thread = makeThread({});

    await bridge.handleMessage(thread, makeMessage({ id: "M_A" }), "mention");
    await bridge.handleMessage(thread, makeMessage({ id: "M_B" }), "mention");

    // Only the two current mentions land in history.
    const entries = await conversationState.getEntries(CONN_ID, CHANNEL_ID, THREAD_ID);
    expect(entries).toHaveLength(2);
  });
});

describe("MessageHandlerBridge.handleMessage — Slack Preview unlinked chat", () => {
  function makePreviewHarness(opts: {
    binding?: { agentId: string; organizationId?: string } | null;
    previewMode?: boolean;
    commandDispatcher?: {
      tryHandleSlashText?: (...args: any[]) => Promise<boolean>;
      tryHandle?: (...args: any[]) => Promise<boolean>;
    };
  }) {
    const state = new InMemoryStateAdapter();
    const conversationState = new ConversationStateStore(state);
    const connection: PlatformConnection = {
      id: CONN_ID,
      platform: "slack",
      agentId: TEMPLATE_AGENT_ID,
      // The hosted preview connection lives in its OWN org; bound agents may
      // live in OTHER orgs (see the cross-org test below).
      organizationId: "org-connection",
      config: { platform: "slack" } as any,
      settings: { allowGroups: true, previewMode: opts.previewMode ?? true },
      metadata: { botUsername: "testbot", botUserId: "U_BOT" },
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    };
    const enqueueMessage = mock(async () => undefined);
    const channelBindingService =
      opts.binding === undefined
        ? undefined
        : { getBinding: mock(async () => opts.binding), getBindingAnyOrg: mock(async () => opts.binding) };
    const services = {
      getArtifactStore: () => null,
      getPublicGatewayUrl: () => "https://gateway.example.com",
      getChannelBindingService: () => channelBindingService,
      getAgentMetadataStore: () => undefined,
      getUserAgentsStore: () => undefined,
      getTranscriptionService: () => undefined,
      getAgentSettingsStore: () => undefined,
      getDeclaredAgentRegistry: () => undefined,
      getQueueProducer: () => ({ enqueueMessage }),
    } as any;
    const manager = {
      has: () => true,
      getInstance: () => ({ connection, conversationState }),
    } as any;
    const bridge = new MessageHandlerBridge(
      connection,
      services,
      manager,
      opts.commandDispatcher as never
    );
    return { bridge, enqueueMessage };
  }

  test("unlinked chat → posts /lobu link instructions, no agent run", async () => {
    const { bridge, enqueueMessage } = makePreviewHarness({ binding: null });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(String(thread.post.mock.calls[0]?.[0])).toContain("/lobu link");
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  test("linked chat → routes to the bound agent, no notice", async () => {
    const { bridge, enqueueMessage } = makePreviewHarness({
      binding: { agentId: "linked-agent" },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const payload = enqueueMessage.mock.calls[0]?.[0] as any;
    expect(payload.agentId ?? payload.platformMetadata?.agentId).toBe(
      "linked-agent"
    );
    expect(
      thread.post.mock.calls.every(
        (c: unknown[]) => !String(c[0]).includes("/lobu link")
      )
    ).toBe(true);
  });

  test("cross-org: routes the worker turn under the BOUND agent's org, not the connection's", async () => {
    // Regression for the hosted-preview cross-org bug: a `/lobu link <code>`
    // binds an agent that lives in a DIFFERENT org than the preview connection.
    // The worker turn MUST run under the binding's org, or the agent's workspace
    // (knowledge, secrets, providers) resolves under the wrong tenant.
    const { bridge, enqueueMessage } = makePreviewHarness({
      binding: { agentId: "food-ordering", organizationId: "org-bound" },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const payload = enqueueMessage.mock.calls[0]?.[0] as any;
    expect(payload.agentId ?? payload.platformMetadata?.agentId).toBe(
      "food-ordering"
    );
    // The binding's org wins over the connection's org ("org-connection").
    expect(payload.organizationId).toBe("org-bound");
  });

  test("`/lobu link <code>` DM message dispatches link before the preview menu", async () => {
    // On a previewMode bot, an unlinked DM normally gets the demo-agent menu.
    // A `/lobu link <code>` arrives as plain message text in an AI-app DM (Slack
    // won't run slash commands there), so it MUST reach the dispatcher and bind
    // — not be preempted by the menu. parsePreviewLinkCode routes it to `link`.
    const tryHandle = mock(async () => true);
    const tryHandleSlashText = mock(async () => false);
    const { bridge, enqueueMessage } = makePreviewHarness({
      binding: null,
      commandDispatcher: { tryHandle, tryHandleSlashText },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ text: "/lobu link crm-ABC123" }),
      "dm"
    );

    expect(tryHandle).toHaveBeenCalledTimes(1);
    expect(tryHandle.mock.calls[0]?.[0]).toBe("link");
    expect(tryHandle.mock.calls[0]?.[1]).toBe("crm-ABC123");
    // The preview menu was NOT posted, and no agent run was queued.
    expect(
      thread.post.mock.calls.every(
        (c: unknown[]) => !String(c[0]).includes("/lobu link")
      )
    ).toBe(true);
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  test("a bare preview-code paste in a DM dispatches link, not the menu", async () => {
    const tryHandle = mock(async () => true);
    const { bridge, enqueueMessage } = makePreviewHarness({
      binding: null,
      commandDispatcher: {
        tryHandle,
        tryHandleSlashText: mock(async () => false),
      },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ text: "crm-ABC123" }),
      "dm"
    );

    expect(tryHandle).toHaveBeenCalledTimes(1);
    expect(tryHandle.mock.calls[0]?.[0]).toBe("link");
    expect(tryHandle.mock.calls[0]?.[1]).toBe("crm-ABC123");
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  test("non-preview connection: a code-looking DM goes to the agent, not link", async () => {
    // The plain-text link parsing is gated to previewMode bots. On a normal
    // agent bot, `crm-ABC123` is just a message for the agent — it must NOT be
    // swallowed by the link command.
    const tryHandle = mock(async () => true);
    const { bridge, enqueueMessage } = makePreviewHarness({
      binding: null,
      previewMode: false,
      commandDispatcher: {
        tryHandle,
        tryHandleSlashText: mock(async () => false),
      },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ text: "crm-ABC123" }),
      "dm"
    );

    expect(tryHandle).not.toHaveBeenCalled();
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
  });
});
