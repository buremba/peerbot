import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type MatchingBehaviorActivation,
  planBehaviorActivations,
} from "../../behaviors/activation.js";
import { matchingBehaviorTriggers } from "../../behaviors/event-trigger.js";
import { ConversationStateStore } from "../connections/conversation-state-store.js";
import {
  buildAttachmentTranscriptText,
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

describe("buildAttachmentTranscriptText", () => {
  const file = (id: string, name: string, mimetype: string) => ({
    id,
    name,
    mimetype,
    size: 1,
    downloadUrl: `http://gw/api/v1/files/${id}?token=x`,
  });

  test("appends a tokenless ref for a non-image file", () => {
    expect(
      buildAttachmentTranscriptText("see attached", [
        file("abc", "report.pdf", "application/pdf"),
			]),
    ).toBe("see attached\n\n[report.pdf](/api/v1/files/abc)");
  });

  test("supports a file-only message (empty caption)", () => {
    expect(
			buildAttachmentTranscriptText("", [
				file("xyz", "notes.txt", "text/plain"),
			]),
    ).toBe("[notes.txt](/api/v1/files/xyz)");
  });

  test("skips images (they persist as inline transcript blocks)", () => {
    expect(
			buildAttachmentTranscriptText("hi", [
				file("img", "pic.png", "image/png"),
			]),
    ).toBe("hi");
  });

  test("appends one ref per non-image file, images skipped", () => {
    expect(
      buildAttachmentTranscriptText("docs", [
        file("a", "a.pdf", "application/pdf"),
        file("b", "pic.jpg", "image/jpeg"),
        file("c", "b.csv", "text/csv"),
			]),
    ).toBe("docs\n\n[a.pdf](/api/v1/files/a)\n[b.csv](/api/v1/files/c)");
  });

  test("sanitizes filenames that would break the [name](url) link grammar", () => {
    // brackets/parens/newlines in the label are collapsed so the web's
    // strip/lift regex stays reliable; the real name rides Content-Disposition.
    const out = buildAttachmentTranscriptText("x", [
      file("id1", "weird]name)evil[.txt", "text/plain"),
    ]);
    expect(out).toBe("x\n\n[weird name evil .txt](/api/v1/files/id1)");
    // label has no unescaped link-breaking chars
    expect(/\[[^\]]*\]\(\/api\/v1\/files\/id1\)/.test(out)).toBe(true);
  });

  test("falls back to 'file' when the name sanitizes to empty", () => {
    expect(
			buildAttachmentTranscriptText("", [file("id2", "()[]", "text/plain")]),
    ).toBe("[file](/api/v1/files/id2)");
  });

  test("returns the original text unchanged when there are no files", () => {
    expect(buildAttachmentTranscriptText("just text", [])).toBe("just text");
  });
});

describe("parsePreviewLinkCode", () => {
  test("bare code paste in a DM", () => {
    expect(parsePreviewLinkCode("crm-TGHE0Z", false)).toBe("crm-TGHE0Z");
  });
  test("multi-segment slug bare code", () => {
    expect(parsePreviewLinkCode("food-ordering-ABC123", false)).toBe(
			"food-ordering-ABC123",
    );
  });
  test("`link <code>`", () => {
    expect(parsePreviewLinkCode("link crm-TGHE0Z", false)).toBe("crm-TGHE0Z");
  });
  test("`/lobu link <code>` delivered as text", () => {
    expect(parsePreviewLinkCode("/lobu link crm-TGHE0Z", false)).toBe(
			"crm-TGHE0Z",
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
			parsePreviewLinkCode("can you help me link the accounts", false),
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
    organizationId: "org-template",
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
    getBehaviorSubscriptionService: () => undefined,
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
    undefined,
    async ({ signal }) => planBehaviorActivations(signal, []),
  );

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
					1_700_000_003_000,
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

		const entries = await conversationState.getEntries(
			CONN_ID,
			CHANNEL_ID,
			THREAD_ID,
		);
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

		const entries = await conversationState.getEntries(
			CONN_ID,
			CHANNEL_ID,
			THREAD_ID,
		);
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
		const entries = await conversationState.getEntries(
			CONN_ID,
			CHANNEL_ID,
			THREAD_ID,
		);
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
		let entries = await conversationState.getEntries(
			CONN_ID,
			CHANNEL_ID,
			THREAD_ID,
		);
    // Only the current message survives — no backfill from the throw.
    expect(entries.map((e) => e.content)).toEqual([
      "what was the prior context?",
    ]);

    // Second mention — claim is free, fetch retries and succeeds.
    await bridge.handleMessage(thread, makeMessage({ id: "M_B" }), "mention");
    expect(fetchMessages).toHaveBeenCalledTimes(2);
		entries = await conversationState.getEntries(
			CONN_ID,
			CHANNEL_ID,
			THREAD_ID,
		);
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
		const entries = await conversationState.getEntries(
			CONN_ID,
			CHANNEL_ID,
			THREAD_ID,
		);
    expect(entries).toHaveLength(2);
  });
});

describe("MessageHandlerBridge.handleMessage — Slack Preview unlinked chat", () => {
  function makePreviewHarness(opts: {
    linkedBehavior?: {
      agentId: string;
      organizationId?: string;
      model?: string;
    } | null;
    fallbackSubscription?: {
      agentId: string;
      organizationId?: string;
      model?: string;
    };
    previewMode?: boolean;
    agentId?: string | undefined;
    metadata?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    commandDispatcher?: {
      tryHandleSlashText?: (...args: any[]) => Promise<boolean>;
      tryHandle?: (...args: any[]) => Promise<boolean>;
    };
    providerCatalog?: unknown;
    behaviors?: MatchingBehaviorActivation[];
    provideSubscriptionService?: boolean;
  }) {
    const state = new InMemoryStateAdapter();
    const conversationState = new ConversationStateStore(state);
    const connection: PlatformConnection = {
      id: CONN_ID,
      platform: "slack",
      // Default to the template agent; tests for an OAuth-installed workspace
      // connection (no owning agent) pass `agentId: undefined` explicitly.
      agentId: "agentId" in opts ? opts.agentId : TEMPLATE_AGENT_ID,
      // The hosted preview connection lives in its OWN org; linked Behaviors may
      // live in OTHER orgs (see the cross-org test below).
      organizationId: "org-connection",
      config: { platform: "slack" } as any,
      settings: {
        allowGroups: true,
        previewMode: opts.previewMode ?? true,
        ...opts.settings,
      },
      metadata: opts.metadata ?? { botUsername: "testbot", botUserId: "U_BOT" },
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    };
    const enqueueMessage = mock(async () => undefined);
    const healSubscriptionTeam = mock(async () => undefined);
    const plannedBehaviors: MatchingBehaviorActivation[] =
      opts.behaviors ??
      (opts.linkedBehavior
        ? [
            {
              behaviorId: 70,
              organizationId:
                opts.linkedBehavior.organizationId ?? connection.organizationId,
              agentId: opts.linkedBehavior.agentId,
              deviceWorkerId: null,
              agentKind: null,
              model: opts.linkedBehavior.model ?? null,
              instructions: "Respond helpfully to the incoming message.",
              trigger: {
                kind: "event",
                connector_key: "slack",
                connection_id: 42,
                event_types: ["message.created"],
                match: { channel_id: CHANNEL_ID },
                execution: "turn",
                active_run: "steer",
                output: "reply_to_source",
                skip_if_unchanged: false,
              },
            },
          ]
        : []);
    const resolveForConnection = mock(
      async () => opts.fallbackSubscription ?? null,
    );
    // Default: if the harness planned Behaviors for this channel, treat the
    // channel as subscribed (even when trigger filters reject this message).
    const channelHasMessageSubscription = mock(
      async () => plannedBehaviors.length > 0,
    );
    const materializeConnectionFallbackLink = mock(async () => true);
    // `provideSubscriptionService` forces the service to be present even with no
    // planned Behaviors — needed to assert the connection-fallback materializer.
    const behaviorSubscriptionService =
      plannedBehaviors.length === 0 &&
      opts.fallbackSubscription === undefined &&
      !opts.provideSubscriptionService
        ? undefined
				: {
						resolveForConnection,
						healSubscriptionTeam,
						channelHasMessageSubscription,
						materializeConnectionFallbackLink,
					};
    const services = {
      getArtifactStore: () => null,
      getPublicGatewayUrl: () => "https://gateway.example.com",
      getBehaviorSubscriptionService: () => behaviorSubscriptionService,
      getAgentMetadataStore: () => undefined,
      getUserAgentsStore: () => undefined,
      getTranscriptionService: () => undefined,
      getAgentSettingsStore: () => undefined,
      getDeclaredAgentRegistry: () => undefined,
      getQueueProducer: () => ({ enqueueMessage }),
      getProviderCatalogService: () => opts.providerCatalog,
    } as any;
    const manager = {
      has: () => true,
      getInstance: () => ({ connection, conversationState }),
    } as any;
    const bridge = new MessageHandlerBridge(
      connection,
      services,
      manager,
			opts.commandDispatcher as never,
      async ({ signal }) =>
        planBehaviorActivations(
          {
            ...signal,
            connection_id: plannedBehaviors[0]?.trigger.connection_id,
          },
          plannedBehaviors.filter(
            (behavior) =>
              matchingBehaviorTriggers([behavior.trigger], {
                ...signal,
                connection_id: behavior.trigger.connection_id,
              }).length > 0,
          ),
        ),
    );
    return {
      bridge,
      enqueueMessage,
      conversationState,
      healSubscriptionTeam,
      resolveForConnection,
      materializeConnectionFallbackLink,
    };
  }

  test("unlinked chat → posts /lobu link instructions, no agent run", async () => {
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedBehavior: null,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(String(thread.post.mock.calls[0]?.[0])).toContain("/lobu link");
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  test("linked chat → routes to the Behavior's agent, no notice", async () => {
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedBehavior: { agentId: "linked-agent" },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const payload = enqueueMessage.mock.calls[0]?.[0] as any;
    expect(payload.agentId ?? payload.platformMetadata?.agentId).toBe(
			"linked-agent",
    );
    expect(
      thread.post.mock.calls.every(
				(c: unknown[]) => !String(c[0]).includes("/lobu link"),
			),
    ).toBe(true);
  });

  test("matching reply Behaviors fan out as independent turns with one history entry", async () => {
    const trigger = {
      kind: "event" as const,
      connector_key: "slack",
      connection_id: 42,
      event_types: ["message.created"],
      match: { channel_id: CHANNEL_ID },
      execution: "turn" as const,
      active_run: "queue" as const,
      output: "reply_to_source" as const,
      skip_if_unchanged: false,
    };
    const behaviors: MatchingBehaviorActivation[] = [
      {
        behaviorId: 71,
        organizationId: "org-a",
        agentId: "agent-a",
        deviceWorkerId: null,
        agentKind: null,
        model: null,
        instructions: "Handle support messages.",
        trigger,
      },
      {
        behaviorId: 72,
        organizationId: "org-b",
        agentId: "agent-b",
        deviceWorkerId: null,
        agentKind: null,
        model: null,
        instructions: "Audit support messages.",
        trigger,
      },
    ];
    const {
      bridge,
      enqueueMessage,
      conversationState,
      healSubscriptionTeam,
    } = makePreviewHarness({ behaviors });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ raw: { team_id: "TREAL" } }),
      "mention",
    );

    expect(enqueueMessage).toHaveBeenCalledTimes(2);
    const payloads = enqueueMessage.mock.calls.map((call) => call[0] as any);
    expect(payloads.map((payload) => payload.agentId)).toEqual([
      "agent-a",
      "agent-b",
    ]);
    expect(payloads.map((payload) => payload.organizationId)).toEqual([
      "org-a",
      "org-b",
    ]);
    expect(payloads[0]?.messageId).not.toBe(payloads[1]?.messageId);
    expect(payloads[0]?.ephemeralContext).toContain("Handle support messages.");
    expect(healSubscriptionTeam).toHaveBeenCalledTimes(2);
    expect(healSubscriptionTeam.mock.calls.map((call) => call[2])).toEqual([
      "org-a",
      "org-b",
    ]);
    const entries = await conversationState.getEntries(
      CONN_ID,
      CHANNEL_ID,
      THREAD_ID,
    );
    expect(entries).toHaveLength(1);
  });

  test("a rejected Behavior filter cannot be bypassed by channel fallback", async () => {
    const trigger = {
      kind: "event" as const,
      connector_key: "slack",
      connection_id: 42,
      event_types: ["message.created"],
      match: { channel_id: CHANNEL_ID, mention_only: true },
      execution: "turn" as const,
      active_run: "queue" as const,
      output: "reply_to_source" as const,
      skip_if_unchanged: false,
    };
    const { bridge, enqueueMessage, resolveForConnection } = makePreviewHarness({
      agentId: undefined,
      previewMode: false,
      metadata: { teamId: "T_WS", botUserId: "U_BOT" },
      fallbackSubscription: {
        agentId: "filtered-agent",
        organizationId: "org-filtered",
      },
      behaviors: [
        {
          behaviorId: 73,
          organizationId: "org-filtered",
          agentId: "filtered-agent",
          deviceWorkerId: null,
          agentKind: null,
          model: null,
          instructions: "Only respond to mentions.",
          trigger,
        },
      ],
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ text: "ordinary chatter", isMention: false }),
      "subscribed",
    );

    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(resolveForConnection).not.toHaveBeenCalled();
    // Linked + filter-rejected must not spam the "link your agent" notice.
    expect(thread.post).not.toHaveBeenCalled();
  });

  test("recordChannelMessages skips agent turns for Behavior-routed subscribed messages", async () => {
    // Pre-Behavior, record-only mode captured non-mention channel traffic
    // without starting a turn. After the cutover, Behavior-routed channels
    // must honor the same flag (mentions still respond).
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedBehavior: { agentId: "linked-agent" },
      previewMode: false,
      settings: { recordChannelMessages: true },
    });

    await bridge.handleMessage(
      makeThread(undefined),
      makeMessage({
        text: "ordinary channel chatter",
        isMention: false,
      }),
      "subscribed",
    );

    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  test("recordChannelMessages still enqueues Behavior turns on mentions", async () => {
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedBehavior: { agentId: "linked-agent" },
      previewMode: false,
      settings: { recordChannelMessages: true },
    });

    await bridge.handleMessage(
      makeThread(undefined),
      makeMessage({ isMention: true }),
      "mention",
    );

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
  });

  test("matching Behavior self-heals its Slack workspace team", async () => {
    const trigger = {
      kind: "event" as const,
      connector_key: "slack",
      connection_id: 42,
      event_types: ["message.created"],
      match: { channel_id: CHANNEL_ID },
      execution: "turn" as const,
      active_run: "queue" as const,
      output: "reply_to_source" as const,
      skip_if_unchanged: false,
    };
    const { bridge, healSubscriptionTeam } = makePreviewHarness({
      behaviors: [
        {
          behaviorId: 71,
          organizationId: "org-behavior",
          agentId: "agent-a",
          deviceWorkerId: null,
          agentKind: null,
          model: null,
          instructions: "Handle support messages.",
          trigger,
        },
      ],
    });

    await bridge.handleMessage(
      makeThread(undefined),
      makeMessage({ raw: { team_id: "TREAL" } }),
      "mention",
    );

    expect(healSubscriptionTeam).toHaveBeenCalledWith(
      CONN_ID,
      CHANNEL_ID,
      "org-behavior",
      "TREAL",
    );
  });

  test("OAuth workspace connection (no agent, not preview): unlinked → link notice, no agent run", async () => {
    // A tenant's OAuth-installed bot has no owning agent and metadata.teamId.
    // An unlinked non-command message must get a one-line "link your agent"
    // notice instead of being silently dropped (the install dead-end we reverted
    // for), and must NOT enqueue a worker turn against a non-existent agent.
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedBehavior: null,
      previewMode: false,
      agentId: undefined,
      metadata: { teamId: "T_WS", botUserId: "U_BOT" },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(String(thread.post.mock.calls[0]?.[0])).toContain("/lobu link");
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  // Build a mock ProviderCatalogService for the preflight path. `findProviderForModel`
  // matches a ref to its module by the `<slug>/` prefix (mirrors the real one).
  function makeCatalogMock(opts: {
    modules: Array<{ providerId: string }>;
    allowedRefs: string[] | null;
  }) {
    return {
      getModelPolicy: mock(async () => ({
        modules: opts.modules,
        allowedRefs: opts.allowedRefs,
      })),
      findProviderForModel: mock(async (ref: string, mods?: Array<{ providerId: string }>) => {
        const slash = ref.indexOf("/");
        const prefix = slash > 0 ? ref.slice(0, slash) : ref;
        return (mods ?? opts.modules).find((m) => m.providerId === prefix);
      }),
    };
  }

  test("unroutable model provider posts a plain Slack text fallback and skips enqueue", async () => {
    // Empty allow-list (allow-all) but the provider module isn't present/routable.
    const providerCatalog = makeCatalogMock({ modules: [], allowedRefs: null });
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedBehavior: {
        agentId: "lobu-builder",
        organizationId: "org-bound",
        model: "z-ai/glm-5.2",
      },
      providerCatalog,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(thread.post).toHaveBeenCalledTimes(1);
    // The preflight now emits its reason text + a provider-connect CTA through
    // the shared buildCtaCardPayload path. With no WorkspaceProvider inited in
    // this bun suite, the org slug can't resolve, so the CTA URL is null and the
    // payload degrades to a plain text string (no card) — the fallback the
    // helper guarantees. Assert the new copy; there's no setup URL to check.
    const posted = thread.post.mock.calls[0]?.[0];
    expect(typeof posted).toBe("string");
    expect(posted).toContain("z-ai/glm-5.2");
    expect(posted).toContain("isn't connected or has no credentials");
    expect(posted).not.toContain("api/proxy");
  });

  test("EXACT GATE: an override on a LISTED provider but NOT in the list is rejected", async () => {
    // The agent allows only openai/gpt-5. The override is openai/other — same
    // PROVIDER, different MODEL — so the exact gate must reject it, even though a
    // provider-slug gate would have let it through.
    const openai = {
      providerId: "openai",
      hasSystemKey: () => true,
      hasCredentials: async () => true,
      getProxyBaseUrlMappings: () => ({ openai: "https://gw/api/proxy/openai" }),
      getModelOptions: async () => [{ value: "openai/gpt-5" }],
    };
    const providerCatalog = makeCatalogMock({
      modules: [openai],
      allowedRefs: ["openai/gpt-5"],
    });
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedBehavior: {
        agentId: "lobu-builder",
        organizationId: "org-bound",
        model: "openai/other",
      },
      providerCatalog,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    // openai/other is NOT in the allow-list, so the exact gate blocks it. The
    // only listed ref (openai/gpt-5) is routable, so preflight falls back to it.
    // The disallowed model must never reach the worker.
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const payload = enqueueMessage.mock.calls[0]?.[0] as any;
    expect(payload.agentOptions?.model).not.toBe("openai/other");
    expect(payload.agentOptions?.model).toBe("openai/gpt-5");
  });

  test("FALLBACK iterates the LISTED alternates in order, never the catalog default", async () => {
    // models=["xai/grok-4","openai/gpt-5"] but the DEFAULT provider (xai) is
    // unroutable. The fallback must be the LISTED alternate openai/gpt-5 (an
    // exact models[] entry), and the code must NOT consult getModelOptions to
    // pick a provider's catalog/first default. We prove that by exploding if
    // getModelOptions is ever called.
    const xai = {
      providerId: "xai",
      hasSystemKey: () => false,
      hasCredentials: async () => false, // unroutable
      getProxyBaseUrlMappings: () => ({}),
      getModelOptions: async () => {
        throw new Error("fallback must not consult getModelOptions");
      },
    };
    const openai = {
      providerId: "openai",
      hasSystemKey: () => true,
      hasCredentials: async () => true,
      getProxyBaseUrlMappings: () => ({ openai: "https://gw/api/proxy/openai" }),
      getModelOptions: async () => {
        throw new Error("fallback must not consult getModelOptions");
      },
    };
    const providerCatalog = makeCatalogMock({
      modules: [xai, openai],
      allowedRefs: ["xai/grok-4", "openai/gpt-5"],
    });
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedBehavior: {
        agentId: "lobu-builder",
        organizationId: "org-bound",
        model: "xai/grok-4",
      },
      providerCatalog,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const payload = enqueueMessage.mock.calls[0]?.[0] as any;
    // The exact LISTED alternate wins.
    expect(payload.agentOptions?.model).toBe("openai/gpt-5");
  });

  test("configured model provider unconnected, but a listed alternate IS routable → falls back and enqueues", async () => {
    const zai = {
      providerId: "z-ai",
      hasSystemKey: () => false,
      hasCredentials: async () => false, // unroutable: no credentials
      getProxyBaseUrlMappings: () => ({}),
      getModelOptions: async () => [{ value: "z-ai/glm-5.2" }],
    };
    const openai = {
      providerId: "openai",
      hasSystemKey: () => false,
      hasCredentials: async () => true,
      getProxyBaseUrlMappings: () => ({ openai: "https://gw/api/proxy/openai" }),
      getModelOptions: async () => [{ value: "openai/gpt-4o-mini" }],
    };
    const providerCatalog = makeCatalogMock({
      modules: [zai, openai],
      // Both the failed default and the routable alternate are listed exactly.
      allowedRefs: ["z-ai/glm-5.2", "openai/gpt-4o-mini"],
    });
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedBehavior: {
        agentId: "lobu-builder",
        organizationId: "org-bound",
        model: "z-ai/glm-5.2",
      },
      providerCatalog,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    // Ran on the listed alternate, did not post a "can't run this yet" error.
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const payload = enqueueMessage.mock.calls[0]?.[0] as any;
    expect(payload.agentOptions?.model).toBe("openai/gpt-4o-mini");
    expect(
      thread.post.mock.calls.every(
        (c: unknown[]) => !String(c[0]).includes("I can't run this yet"),
      ),
    ).toBe(true);
  });

  test("no connected provider at all → still posts the setup-link error, no enqueue", async () => {
    const zai = {
      providerId: "z-ai",
      hasSystemKey: () => false,
      hasCredentials: async () => false,
      getProxyBaseUrlMappings: () => ({}),
      getModelOptions: async () => [{ value: "z-ai/glm-5.2" }],
    };
    const providerCatalog = makeCatalogMock({
      modules: [zai],
      allowedRefs: ["z-ai/glm-5.2"],
    });
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedBehavior: {
        agentId: "lobu-builder",
        organizationId: "org-bound",
        model: "z-ai/glm-5.2",
      },
      providerCatalog,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(thread.post).toHaveBeenCalledTimes(1);
    // Model is allowed but its provider isn't routable → the new provider-connect
    // reason copy (see the sibling test for why this degrades to a text string).
    expect(String(thread.post.mock.calls[0]?.[0])).toContain(
      "isn't connected or has no credentials",
    );
  });

  test("cross-org: routes the worker turn under the Behavior's org, not the connection's", async () => {
    // Regression for the hosted-preview cross-org bug: a `/lobu link <code>`
    // creates a Behavior for an agent in a DIFFERENT org than the preview connection.
    // The worker turn MUST run under the Behavior's org, or the agent's workspace
    // (knowledge, secrets, providers) resolves under the wrong tenant.
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedBehavior: {
        agentId: "food-ordering",
        organizationId: "org-bound",
      },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const payload = enqueueMessage.mock.calls[0]?.[0] as any;
    expect(payload.agentId ?? payload.platformMetadata?.agentId).toBe(
			"food-ordering",
    );
    // The Behavior's org wins over the connection's org ("org-connection").
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
      linkedBehavior: null,
      commandDispatcher: { tryHandle, tryHandleSlashText },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ text: "/lobu link crm-ABC123" }),
			"dm",
    );

    expect(tryHandle).toHaveBeenCalledTimes(1);
    expect(tryHandle.mock.calls[0]?.[0]).toBe("link");
    expect(tryHandle.mock.calls[0]?.[1]).toBe("crm-ABC123");
    // The preview menu was NOT posted, and no agent run was queued.
    expect(
      thread.post.mock.calls.every(
				(c: unknown[]) => !String(c[0]).includes("/lobu link"),
			),
    ).toBe(true);
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  test("a bare preview-code paste in a DM dispatches link, not the menu", async () => {
    const tryHandle = mock(async () => true);
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedBehavior: null,
      commandDispatcher: {
        tryHandle,
        tryHandleSlashText: mock(async () => false),
      },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ text: "crm-ABC123" }),
			"dm",
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
      linkedBehavior: null,
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
			"dm",
    );

    expect(tryHandle).not.toHaveBeenCalled();
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
  });

  test("connection-owner fallback in a group channel materializes the chat-link Behavior", async () => {
    // No Behavior matches; the connection owns an agent, so routing falls back
    // to `source:"connection"`. The channel has no subscription row, so it would
    // be invisible to history/ACL/search — the materializer writes the row.
    const {
      bridge,
      enqueueMessage,
      materializeConnectionFallbackLink,
    } = makePreviewHarness({
      previewMode: false,
      metadata: { teamId: "T_WS", botUserId: "U_BOT" },
      provideSubscriptionService: true,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ raw: { team_id: "TREAL" } }),
      "mention",
    );

    // The turn still runs.
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    // …and the missing chat-link is materialized with the real workspace team.
    expect(materializeConnectionFallbackLink).toHaveBeenCalledTimes(1);
    const call = materializeConnectionFallbackLink.mock.calls[0] as unknown[];
    expect(call[1]).toBe("org-connection"); // organizationId
    expect(call[2]).toBe(TEMPLATE_AGENT_ID); // agentId
    expect(call[3]).toBe("slack"); // platform
    expect(call[5]).toBe("TREAL"); // real T-team passed through
  });

  test("connection fallback passes no team when Slack sends only an enterprise id", async () => {
    const { bridge, materializeConnectionFallbackLink } = makePreviewHarness({
      previewMode: false,
      metadata: { teamId: "T_WS", botUserId: "U_BOT" },
      provideSubscriptionService: true,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ raw: { team_id: "E0ENTERPRISE" } }),
      "mention",
    );

    expect(materializeConnectionFallbackLink).toHaveBeenCalledTimes(1);
    const call = materializeConnectionFallbackLink.mock.calls[0] as unknown[];
    expect(call[5]).toBeUndefined(); // enterprise E… id is never used as a team
  });

  test("connection fallback materialization is create-only so it cannot clobber an existing link", async () => {
    // A mention-only Behavior exists but rejected this non-mention message, so
    // routing falls to the connection owner. The bridge still calls the
    // materializer — but it's create-only (see the DB-level preserve test in
    // agent-thread-list-scope-all), so an existing explicit link is never
    // relinked to the connection owner even under a check-then-write race.
    const behavior: MatchingBehaviorActivation = {
      behaviorId: 71,
      organizationId: "org-connection",
      agentId: "mention-only-agent",
      deviceWorkerId: null,
      agentKind: null,
      model: null,
      instructions: "Respond helpfully to the incoming message.",
      trigger: {
        kind: "event",
        connector_key: "slack",
        connection_id: 42,
        event_types: ["message.created"],
        match: { channel_id: CHANNEL_ID, mention_only: true },
        execution: "turn",
        active_run: "steer",
        output: "reply_to_source",
        skip_if_unchanged: false,
      },
    };
    const { bridge, enqueueMessage, materializeConnectionFallbackLink } =
      makePreviewHarness({
        previewMode: false,
        behaviors: [behavior],
      });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ raw: { team_id: "TREAL" } }),
      "subscribed",
    );

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    expect(materializeConnectionFallbackLink).toHaveBeenCalledTimes(1);
  });

  test("hosted-preview fallback does NOT materialize its placeholder agent", async () => {
    const { bridge, enqueueMessage, materializeConnectionFallbackLink } =
      makePreviewHarness({
        provideSubscriptionService: true,
      });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(materializeConnectionFallbackLink).not.toHaveBeenCalled();
  });

  test("connection fallback does NOT materialize for a DM", async () => {
    // DMs stay out of the bound-channel set — only group channels materialize.
    const { bridge, enqueueMessage, materializeConnectionFallbackLink } =
      makePreviewHarness({
        previewMode: false,
        metadata: { teamId: "T_WS", botUserId: "U_BOT" },
        provideSubscriptionService: true,
      });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ raw: { team_id: "TREAL" } }),
      "dm",
    );

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    expect(materializeConnectionFallbackLink).not.toHaveBeenCalled();
  });

  test("a matched Behavior does NOT trigger connection-fallback materialization", async () => {
    // source:"behavior" already owns a subscription row; no materialization.
    const { bridge, materializeConnectionFallbackLink } = makePreviewHarness({
      linkedBehavior: { agentId: "linked-agent" },
      provideSubscriptionService: true,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ raw: { team_id: "TREAL" } }),
      "mention",
    );

    expect(materializeConnectionFallbackLink).not.toHaveBeenCalled();
  });
});
