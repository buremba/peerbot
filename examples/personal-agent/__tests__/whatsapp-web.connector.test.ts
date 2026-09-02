/**
 * Parity suite for the WhatsApp Web connector.
 *
 * The assertions here are ported from the Owletto extension's
 * `whatsapp-web.test.js` — the same fixtures and the same expected values —
 * because the bar for deleting the extension-native connector is that this one
 * produces the same events from the same inputs. Where a test named a mechanism
 * that did not survive the move (the IndexedDB outbox, the activation gate, the
 * `chrome.scripting` injection path), the equivalent is asserted against what
 * replaced it: the feed checkpoint and the generic `evaluate` op.
 *
 * The tests the extension owned that have NO equivalent here — the live
 * observer relay and the per-run action ledger — are called out in the
 * connector's header. They are not silently dropped assertions; there is no
 * generic op to carry them.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import WhatsAppWebConnector from "../whatsapp-web.connector.ts";
import { whatsAppWebAdapterProgram } from "../whatsapp-web-adapter.js";
import {
  APPLE_EPOCH_OFFSET_SECONDS,
  buildCollectionPlan,
  canonicalizeJid,
  initializeBrowserCheckpoint,
  legacyAppleSecondsToUnix,
  mergeBrowserCheckpoint,
  mergeCollectedMessages,
  rawMessageId,
  toEventEnvelope,
  type BrowserCheckpoint,
} from "../whatsapp-web-helpers.ts";

/** The extension suite's fixture, unchanged. */
function message(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    chat_jid: "15551234567@s.whatsapp.net",
    chat_name: "Alice",
    sender_jid: "15551234567@s.whatsapp.net",
    push_name: "Alice",
    from_me: false,
    is_group: false,
    timestamp: 1_787_358_200,
    occurred_at: "2026-08-22T00:23:20.000Z",
    body: "hello",
    message_type: "chat",
    ...overrides,
  };
}

interface DispatchCall {
  action: string;
  input: Record<string, unknown>;
}

/**
 * Stands in for the paired extension. Every adapter RPC arrives as an
 * `evaluate` whose expression embeds a JSON request, so the fake parses the op
 * back out and answers from `responses` — the same table shape the extension
 * suite drove `chrome.scripting.executeScript` with.
 */
function makeDispatcher(
  responses: Record<string, unknown | ((input: unknown) => unknown)> = {},
  { adapterInstalled = true }: { adapterInstalled?: boolean } = {}
) {
  const calls: DispatchCall[] = [];
  const adapterOps: string[] = [];
  const injections: string[] = [];
  let installed = adapterInstalled;
  const dispatch = mock(
    async (action: string, input: Record<string, unknown>) => {
      calls.push({ action, input });
      if (action === "navigate") return { tab_id: 42, current_url: input.url };
      if (action !== "evaluate") return {};
      const expression = String(input.expression ?? "");
      // Installation probe.
      if (expression.includes("a.version ===")) return { value: installed };
      const match = expression.match(/a\.invoke\((\{[\s\S]*\})\);/);
      // Anything that is neither the probe nor an RPC is the serialised
      // program being injected.
      if (!match?.[1]) {
        injections.push(expression);
        installed = true;
        return { value: undefined };
      }
      const request = JSON.parse(match[1]) as { op: string };
      adapterOps.push(request.op);
      if (!installed) {
        return {
          value: {
            ok: false,
            error: { state: "adapter_unavailable", reason: "not installed" },
          },
        };
      }
      const entry = responses[request.op];
      const value =
        typeof entry === "function"
          ? (entry as (r: unknown) => unknown)(request)
          : entry;
      return {
        value: value ?? {
          ok: false,
          error: { state: "unsupported_operation", reason: request.op },
        },
      };
    }
  );
  return {
    dispatcher: { dispatch } as never,
    calls,
    adapterOps,
    injections,
    mediaCalls: () => adapterOps.filter((op) => op === "download_media"),
    uninstallAdapter: () => {
      installed = false;
    },
  };
}

const READY = { ok: true, status: { state: "ready" }, capabilities: {} };

function syncCtx(
  checkpoint: BrowserCheckpoint | null,
  dispatcher: unknown,
  config: Record<string, unknown> = {}
) {
  return {
    feedKey: "messages",
    config,
    checkpoint,
    credentials: null,
    entityIds: [],
    sessionState: { chrome_dispatcher: dispatcher },
  } as never;
}

let connector: WhatsAppWebConnector;
beforeEach(() => {
  connector = new WhatsAppWebConnector();
});

function messagesFeed() {
  const feed = connector.definition.feeds?.messages;
  if (!feed?.sync) throw new Error("messages feed is not declared");
  return { ...feed, sync: feed.sync };
}

// ── canonical identity and cutover (verbatim from the extension suite) ──

describe("canonical WhatsApp identity and cutover", () => {
  it("uses raw key.id and never the serialized compound key", () => {
    expect(
      rawMessageId({ id: "3EB0ABC", _serialized: "false_123@c.us_3EB0ABC_in" })
    ).toBe("3EB0ABC");
    expect(
      rawMessageId({ _serialized: "false_123@c.us_3EB0ABC_in" })
    ).toBeNull();
    expect(rawMessageId("true_123@c.us_3EB0ABC_out")).toBeNull();
  });

  it("canonicalizes phone JIDs while retaining group and LID forms", () => {
    expect(canonicalizeJid("15551234567@c.us")).toBe(
      "15551234567@s.whatsapp.net"
    );
    expect(canonicalizeJid("123-456@g.us")).toBe("123-456@g.us");
    expect(canonicalizeJid("999@lid")).toBe("999@lid");
  });

  it("converts the verified legacy Apple checkpoint exactly", () => {
    expect(APPLE_EPOCH_OFFSET_SECONDS).toBe(978_307_200);
    expect(legacyAppleSecondsToUnix(809_050_984)).toBe(1_787_358_184);
    const checkpoint = initializeBrowserCheckpoint({
      last_pk: 66_904,
      last_message_date: 809_050_984,
    });
    expect(checkpoint.cutover_unix_seconds).toBe(1_787_358_184);
    expect(checkpoint.legacy_last_pk).toBe(66_904);
    expect(checkpoint.backfill.complete).toBe(true);
  });

  it("sends the history budget as a relative span the page can resolve", () => {
    const { request } = buildCollectionPlan({});
    // Absolute instants cannot cross the connector/page boundary: they run on
    // different machines, so a shared epoch is off by the clock skew.
    expect(request).not.toHaveProperty("deadline");
    expect(request.budget_ms).toBeGreaterThan(0);
    const source = whatsAppWebAdapterProgram.toString();
    expect(source).toContain("request.budget_ms");
    expect(source).not.toContain("request.deadline");
  });

  it("bounds legacy reconciliation and does not replay older history", () => {
    const { request } = buildCollectionPlan({
      checkpoint: { last_pk: 66_904, last_message_date: 809_050_984 },
    });
    expect(request.minimum_timestamp).toBe(1_787_358_184);
    expect(request.backfill_disabled).toBe(true);
    const merged = mergeCollectedMessages(
      [
        message("old", { timestamp: (request.minimum_timestamp ?? 0) - 1 }),
        message("overlap", { timestamp: request.minimum_timestamp }),
        message("new", { timestamp: 1_787_358_200 }),
      ],
      [],
      request.minimum_timestamp
    );
    expect(merged.map((row) => row.id)).toEqual(["overlap", "new"]);
  });
});

// ── event shape ────────────────────────────────────────────────────────

describe("event shape", () => {
  it("preserves legacy-compatible title, text, and canonical id", () => {
    const normalized = mergeCollectedMessages([message("3EB0")], [])[0];
    if (!normalized) throw new Error("fixture did not normalize");
    const event = toEventEnvelope(normalized, undefined, {
      legacyOverlap: true,
    });
    expect(event.origin_id).toBe("3EB0");
    expect(event.title).toBe("Alice");
    expect(event.payload_text).toBe("hello");
    // Exact fixture for an ordinary inbound 1:1 text message. The only
    // deliberate change from the extension's expectation is `source`, which
    // names the connector producing the row.
    expect(event.metadata).toEqual({
      source: "whatsapp_web",
      origin_id: "3EB0",
      chat_jid: "15551234567@s.whatsapp.net",
      is_group: false,
      from_me: false,
      sender_jid: "15551234567@s.whatsapp.net",
      sender_phone: "15551234567",
      push_name: "Alice",
    });
    expect(event.occurred_at.toISOString()).toBe("2026-08-22T00:23:20.000Z");
    expect(event.semantic_type).toBe("message");
    expect(event.attachments).toBeUndefined();
  });

  it("adds direct-inbound attribution only to new non-overlap messages", () => {
    const inbound = mergeCollectedMessages([message("new-direct")], [])[0];
    if (!inbound) throw new Error("fixture did not normalize");
    expect(
      toEventEnvelope(inbound, undefined).metadata?.is_direct_inbound
    ).toBe(true);
    expect(
      toEventEnvelope(inbound, undefined, { legacyOverlap: true }).metadata
    ).not.toHaveProperty("is_direct_inbound");
    expect(
      toEventEnvelope({ ...inbound, from_me: true }, undefined).metadata
    ).not.toHaveProperty("is_direct_inbound");
  });

  it("prefers the current snapshot's edits and revokes over stale state", () => {
    const current = mergeCollectedMessages(
      [
        message("same", {
          body: "edited",
          edited: true,
          revoked: true,
          reactions: [{ emoji: "👍", sender_jid: "2@s.whatsapp.net" }],
        }),
      ],
      [{ message: message("same", { body: "stale original" }) }]
    );
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      id: "same",
      edited: true,
      revoked: true,
    });
    expect(current[0]?.reactions).toHaveLength(1);
  });
});

// ── checkpoint ─────────────────────────────────────────────────────────

describe("browser checkpoint", () => {
  it("merges per-chat state without losing prior chats", () => {
    const base = initializeBrowserCheckpoint(null);
    base.backfill.chats.a = { has_more: true };
    const next = mergeBrowserCheckpoint(
      base as unknown as Record<string, unknown>,
      {
        backfill: {
          complete: false,
          cursor_chat_jid: "b",
          inventory: [],
          chats: { b: { has_more: false } },
        },
      },
      mergeCollectedMessages([message("head")], [])
    );
    expect(next.backfill.chats).toEqual({
      a: { has_more: true },
      b: { has_more: false },
    });
  });

  it("preserves recoverable known-chat inventory and round-trips into the next plan", () => {
    const next = mergeBrowserCheckpoint(
      initializeBrowserCheckpoint(null) as unknown as Record<string, unknown>,
      {
        backfill: {
          complete: false,
          cursor_chat_jid: null,
          inventory: ["a@s.whatsapp.net", "b@g.us"],
          chats: {},
        },
      },
      mergeCollectedMessages([message("older-1")], [])
    );
    expect(next.backfill).toMatchObject({
      complete: false,
      inventory: ["a@s.whatsapp.net", "b@g.us"],
    });
    expect(
      buildCollectionPlan({
        checkpoint: next as unknown as Record<string, unknown>,
      }).request.backfill
    ).toEqual(next.backfill);
  });
});

// ── the sync loop over the generic bridge ──────────────────────────────

describe("sync over the generic chrome bridge", () => {
  it("navigates into the persistent agent window and probes before collecting", async () => {
    const image = message("plain");
    const { dispatcher, calls, adapterOps } = makeDispatcher({
      probe: READY,
      collect: {
        ok: true,
        status: {},
        messages: [image],
        backfill: {
          complete: true,
          cursor_chat_jid: null,
          inventory: [],
          chats: {},
        },
      },
    });
    const result = await messagesFeed().sync(syncCtx(null, dispatcher));
    const nav = calls.find((call) => call.action === "navigate");
    expect(nav?.input).toMatchObject({
      url: "https://web.whatsapp.com/",
      persistent: true,
    });
    expect(adapterOps.slice(0, 2)).toEqual(["probe", "collect"]);
    expect(result.events.map((event) => event.origin_id)).toEqual(["plain"]);
  });

  it("re-injects the adapter when the page lost it, then retries the call", async () => {
    const { dispatcher, injections, uninstallAdapter } = makeDispatcher(
      {
        probe: READY,
        collect: {
          ok: true,
          status: {},
          messages: [message("after-reload")],
          backfill: {
            complete: true,
            cursor_chat_jid: null,
            inventory: [],
            chats: {},
          },
        },
      },
      { adapterInstalled: false }
    );
    uninstallAdapter();
    const result = await messagesFeed().sync(syncCtx(null, dispatcher));
    expect(injections).toHaveLength(1);
    // The injected expression really is the serialised adapter program, not a
    // stub: it carries the adapter's own global key and its op table.
    expect(injections[0]).toContain("__owlettoWhatsAppAdapterV1");
    expect(injections[0]).toContain("revoke_message");
    expect(injections[0]!.length).toBeGreaterThan(20_000);
    expect(result.events.map((event) => event.origin_id)).toEqual([
      "after-reload",
    ]);
  });

  it("names the remedy when WhatsApp Web is signed out", async () => {
    const { dispatcher } = makeDispatcher({
      probe: {
        ok: false,
        error: { state: "logged_out", reason: "qr_code_visible" },
      },
    });
    await expect(
      messagesFeed().sync(syncCtx(null, dispatcher))
    ).rejects.toThrow(/not signed in.*web\.whatsapp\.com.*Linked Devices/is);
  });

  it("refuses to run without a paired extension", async () => {
    await expect(messagesFeed().sync(syncCtx(null, undefined))).rejects.toThrow(
      /paired Owletto Chrome extension/i
    );
  });
});

// ── media (ported bounds) ──────────────────────────────────────────────

function imageMessages(
  count: number,
  prefix = "image"
): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) =>
    message(`${prefix}-${index}`, {
      body: "",
      message_type: "image",
      media_kind: "image",
      media_type: "image/jpeg",
    })
  );
}

function collectResponse(messages: Record<string, unknown>[]) {
  return {
    ok: true,
    status: {},
    messages,
    backfill: {
      complete: true,
      cursor_chat_jid: null,
      inventory: [],
      chats: {},
    },
  };
}

describe("media", () => {
  it("keeps media attempts bounded and marks overflow metadata-only", async () => {
    const { dispatcher, mediaCalls } = makeDispatcher({
      probe: READY,
      collect: collectResponse(imageMessages(13)),
      download_media: { ok: true, status: "unavailable" },
    });
    const result = await messagesFeed().sync(syncCtx(null, dispatcher));
    expect(mediaCalls()).toHaveLength(12);
    expect(
      result.events.filter(
        (event) => event.metadata?.media_status === "metadata_only"
      )
    ).toHaveLength(1);
  });

  it("enforces a total raw attachment budget and defers excess bytes", async () => {
    const { dispatcher } = makeDispatcher({
      probe: READY,
      collect: collectResponse(imageMessages(3, "large")),
      download_media: {
        ok: true,
        status: "downloaded",
        attachment: {
          kind: "image",
          filename: "image.jpg",
          mime_type: "image/jpeg",
          data: "AA==",
          size_bytes: 2 * 1024 * 1024,
        },
      },
    });
    const result = await messagesFeed().sync(syncCtx(null, dispatcher));
    expect(result.events.filter((event) => event.attachments)).toHaveLength(2);
    expect(
      result.events.filter(
        (event) => event.metadata?.media_status === "metadata_only"
      )
    ).toHaveLength(1);
  });

  it("respects media backoff carried in the checkpoint instead of redownloading", async () => {
    // The extension read this backoff out of IndexedDB; the connector's only
    // durable store is the checkpoint, so the second run is fed the first
    // run's checkpoint — the equivalent continuity.
    const images = imageMessages(1, "retry");
    const first = makeDispatcher({
      probe: READY,
      collect: collectResponse(images),
      download_media: { ok: true, status: "unavailable" },
    });
    const firstRun = await messagesFeed().sync(syncCtx(null, first.dispatcher));
    expect(first.mediaCalls()).toHaveLength(1);

    const second = makeDispatcher({
      probe: READY,
      collect: collectResponse(images),
      download_media: { ok: true, status: "unavailable" },
    });
    await messagesFeed().sync(
      syncCtx(firstRun.checkpoint as BrowserCheckpoint, second.dispatcher)
    );
    expect(second.mediaCalls()).toHaveLength(0);
  });

  it("never hydrates or stamps media status on a legacy-overlap row", async () => {
    const legacyCheckpoint = initializeBrowserCheckpoint({
      last_pk: 1,
      last_message_date: 809_050_984,
    });
    const overlap = message("overlap-media", {
      timestamp: 1_787_358_184,
      occurred_at: new Date(1_787_358_184 * 1000).toISOString(),
      message_type: "image",
      media_kind: "image",
      media_type: "image/jpeg",
    });
    const { dispatcher, mediaCalls } = makeDispatcher({
      probe: READY,
      collect: collectResponse([overlap]),
      download_media: { ok: true, status: "downloaded" },
    });
    const result = await messagesFeed().sync(
      syncCtx(legacyCheckpoint, dispatcher)
    );
    expect(mediaCalls()).toHaveLength(0);
    expect(result.events[0]?.metadata).not.toHaveProperty("media_status");
  });
});

// ── checkpoint clearing ────────────────────────────────────────────────

describe("checkpoint fields clear when their cause is gone", () => {
  // mergeBrowserCheckpoint spreads the PRIOR checkpoint forward, so a field
  // that is only ever conditionally assigned can never leave the checkpoint.
  // A stale `dirty` list would pin backfill.complete to false forever and make
  // every run re-request markers the adapter already reconciled.
  it("drops dirty markers the adapter reconciled", async () => {
    const priorDirty = {
      key: "chat-1:100",
      chat_jid: "15551234567@s.whatsapp.net",
      message_id: "3EB0",
      minimum_timestamp: null,
      reason: "missing_stable_timestamp_or_identity",
    };
    const prior = initializeBrowserCheckpoint(null);
    prior.dirty = [priorDirty];

    const { dispatcher } = makeDispatcher({
      probe: READY,
      collect: {
        ...collectResponse([message("3EB0")]),
        dirty_reconciled: [{ key: priorDirty.key, message_id: "3EB0" }],
      },
    });
    const result = await messagesFeed().sync(syncCtx(prior, dispatcher));
    const next = result.checkpoint as BrowserCheckpoint;
    expect(next.dirty ?? []).toEqual([]);
    expect(next.backfill.complete).toBe(true);
    expect(next.diagnostics?.dirty_reconciliation).toBeUndefined();
  });

  it("drops media retry rows once nothing is pending", async () => {
    const prior = initializeBrowserCheckpoint(null);
    prior.media = {
      "stale-retry": {
        id: "stale-retry",
        revision: "0-00000000",
        status: "unavailable",
        retryable: true,
        attempts: 3,
        next_attempt_at: Date.now() - 1,
        updated_at: Date.now() - 1,
      },
    };
    const { dispatcher } = makeDispatcher({
      probe: READY,
      // A plain text message: nothing media-eligible, so no retry row survives.
      collect: collectResponse([message("plain-text")]),
    });
    const result = await messagesFeed().sync(syncCtx(prior, dispatcher));
    expect((result.checkpoint as BrowserCheckpoint).media ?? {}).toEqual({});
  });
});

// ── the action table ───────────────────────────────────────────────────

describe("actions", () => {
  it("declares the exact action table with the same approval posture", () => {
    const actions = connector.definition.actions ?? {};
    expect(Object.keys(actions).sort()).toEqual([
      "draft_message",
      "edit_message",
      "react_message",
      "revoke_message",
      "search_messages",
      "send_message",
    ]);
    expect(actions.search_messages?.requiresApproval).toBe(false);
    expect(actions.search_messages?.kind).toBe("read");
    // A draft only fills the composer; the human still presses send.
    expect(actions.draft_message?.requiresApproval).toBe(false);
    for (const key of [
      "send_message",
      "edit_message",
      "react_message",
      "revoke_message",
    ]) {
      expect(actions[key]?.requiresApproval).toBe(true);
      expect(actions[key]?.kind).toBe("write");
    }
    expect(actions.revoke_message?.annotations?.destructiveHint).toBe(true);
  });

  it("normalizes bounded search results", async () => {
    const { dispatcher } = makeDispatcher({
      probe: READY,
      search_messages: {
        ok: true,
        source: "whatsapp_fts",
        results: [
          message("hit-1"),
          { id: "no-timestamp", chat_jid: "1@c.us" },
          message("hit-2", { chat_jid: "status@broadcast" }),
        ],
      },
    });
    const result = await connector.execute({
      actionKey: "search_messages",
      input: { query: "hello" },
      credentials: null,
      config: {},
      sessionState: { chrome_dispatcher: dispatcher },
    } as never);
    expect(result.success).toBe(true);
    expect(result.output?.source).toBe("whatsapp_fts");
    // The undatable row and the status broadcast are both dropped.
    expect(
      (result.output?.results as Array<{ id: string }>).map((row) => row.id)
    ).toEqual(["hit-1"]);
  });

  it("treats a send with no raw message ID as a failure", async () => {
    const { dispatcher } = makeDispatcher({
      probe: READY,
      send_message: { ok: true, sent: true, chat_jid: "1@s.whatsapp.net" },
    });
    const result = await connector.execute({
      actionKey: "send_message",
      input: { chat_jid: "1@s.whatsapp.net", text: "hi" },
      credentials: null,
      config: {},
      sessionState: { chrome_dispatcher: dispatcher },
    } as never);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no raw WhatsApp message ID/);
  });

  it("returns the adapter output verbatim for a successful send", async () => {
    const { dispatcher } = makeDispatcher({
      probe: READY,
      send_message: {
        ok: true,
        sent: true,
        chat_jid: "1@s.whatsapp.net",
        message_id: "3EB0NEW",
      },
    });
    const result = await connector.execute({
      actionKey: "send_message",
      input: { chat_jid: "1@s.whatsapp.net", text: "hi" },
      credentials: null,
      config: {},
      sessionState: { chrome_dispatcher: dispatcher },
    } as never);
    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      sent: true,
      chat_jid: "1@s.whatsapp.net",
      message_id: "3EB0NEW",
    });
  });

  it("surfaces an adapter failure as an action error, not a throw", async () => {
    const { dispatcher } = makeDispatcher({
      probe: READY,
      revoke_message: {
        ok: false,
        error: {
          state: "capability_unavailable",
          reason: "revoke unavailable",
        },
      },
    });
    const result = await connector.execute({
      actionKey: "revoke_message",
      input: { message_id: "3EB0" },
      credentials: null,
      config: {},
      sessionState: { chrome_dispatcher: dispatcher },
    } as never);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/capability_unavailable/);
  });

  it("rejects an action the connector does not declare", async () => {
    const result = await connector.execute({
      actionKey: "delete_account",
      input: {},
      credentials: null,
      config: {},
      sessionState: {},
    } as never);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown action/);
  });
});

// ── placement ──────────────────────────────────────────────────────────

describe("placement", () => {
  it("stays out of the reserved chrome.* namespace", () => {
    // A `chrome.*` key declares "the extension implements this natively", and
    // the gateway then withholds the bundle — a connector that ships its own
    // code can never live there. This is the whole point of the move.
    expect(connector.definition.key).toBe("whatsapp.web");
    expect(connector.definition.key.startsWith("chrome")).toBe(false);
  });

  it("declares no interactive auth handshake", () => {
    // The QR is rendered by web.whatsapp.com in the user's own browser, and an
    // auth run carries no chrome dispatcher, so there is nothing to relay.
    expect(connector.definition.authSchema?.methods).toEqual([
      { type: "none" },
    ]);
  });
});

describe("quarantined messages", () => {
  /**
   * The adapter and the connector meet on the DirtyMarker shape. A message with
   * no stable timestamp is quarantined by the adapter and carried in the
   * checkpoint's `dirty` list until a later run reconciles it.
   *
   * Two fields do that work, and both have to arrive: `key` is what
   * `reconciledKeys` matches to DROP a marker, and `message_id` is what the
   * adapter filters `dirty_ranges` on to look one up. A marker missing either
   * is not "slightly wrong" — it is permanently stuck, and because `dirty`
   * being non-empty pins `backfill.complete = false`, the backfill never
   * finishes either.
   */
  it("carries a quarantined message forward with a reconcilable identity", async () => {
    const dispatcher = makeDispatcher({
      probe: READY,
      collect: {
        ok: true,
        messages: [],
        quarantined: [
          {
            key: "111@s.whatsapp.net:QUARANTINED-1",
            message_id: "QUARANTINED-1",
            chat_jid: "111@s.whatsapp.net",
            reason: "missing_stable_timestamp",
          },
        ],
        chats_seen: 1,
        backfill: { complete: true },
      },
    });
    const { checkpoint } = await messagesFeed().sync(
      syncCtx(initializeBrowserCheckpoint({}), dispatcher.dispatcher)
    );

    const dirty = (checkpoint as { dirty?: unknown[] }).dirty ?? [];
    expect(dirty).toHaveLength(1);
    const marker = dirty[0] as Record<string, unknown>;
    expect(marker.message_id).toBe("QUARANTINED-1");
    expect(marker.key).toBe("111@s.whatsapp.net:QUARANTINED-1");
  });

  it("does not accumulate a duplicate when the same message is re-quarantined", async () => {
    const quarantined = [
      {
        key: "111@s.whatsapp.net:QUARANTINED-1",
        message_id: "QUARANTINED-1",
        chat_jid: "111@s.whatsapp.net",
        reason: "missing_stable_timestamp",
      },
    ];
    const run = (checkpoint: BrowserCheckpoint) =>
      messagesFeed().sync(
        syncCtx(
          checkpoint,
          makeDispatcher({
            probe: READY,
            collect: {
              ok: true,
              messages: [],
              quarantined,
              chats_seen: 1,
              backfill: { complete: true },
            },
          }).dispatcher
        )
      );
    const first = await run(initializeBrowserCheckpoint({}));
    const second = await run(first.checkpoint as BrowserCheckpoint);
    expect((second.checkpoint as { dirty?: unknown[] }).dirty).toHaveLength(1);
  });
});
