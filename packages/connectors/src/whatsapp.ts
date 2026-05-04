/**
 * WhatsApp Connector (V1 runtime)
 *
 * Syncs personal WhatsApp messages via Baileys (unofficial WA Web protocol).
 * Pairing happens in authenticate() via QR scan; creds are persisted to the
 * linked auth profile. sync() assumes a valid session.
 *
 * Risks:
 *   - Violates WhatsApp ToS; personal number may be banned.
 *   - Linked devices auto-unlink if the phone is offline ~14 days.
 */

import {
  type ActionContext,
  type ActionResult,
  type AuthContext,
  type AuthResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  IDENTITY,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

// ---------------------------------------------------------------------------
// Baileys (pinned)
// ---------------------------------------------------------------------------

import {
  type AuthenticationCreds,
  type AuthenticationState,
  Browsers,
  BufferJSON,
  type ConnectionState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  makeWASocket,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
  type WAMessage,
  type WAMessageContent,
  type WAMessageKey,
} from 'baileys';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SerializedSession {
  creds?: string; // JSON w/ BufferJSON
  keys?: string; // JSON w/ BufferJSON
  /** Events collected during the paired-socket drain; emitted on first sync. */
  pending_events?: SerializedEvent[] | null;
}

interface SerializedEvent extends Omit<EventEnvelope, 'occurred_at'> {
  occurred_at: string;
}

interface ChatFrontier {
  /** Message ID + timestamp of the oldest message we've fetched in this chat. */
  oldest_id: string;
  oldest_ts: number;
  /** True once fetchMessageHistory stops returning older messages for this chat. */
  exhausted?: boolean;
}

interface WhatsAppCheckpoint {
  last_message_at?: string;
  /**
   * Per-chat backward-walk frontiers for incremental deep-history sync. Each
   * sync run advances these by fetchMessageHistory calls and persists the
   * new frontier. Next sync resumes from the same state — crash-resilient.
   */
  chat_frontiers?: Record<string, ChatFrontier>;
  paginated_at?: string;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class WhatsAppConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'whatsapp',
    name: 'WhatsApp',
    description:
      'Syncs personal WhatsApp messages via the WA Web linked-device protocol. Pair by scanning a QR from WhatsApp → Linked Devices.',
    version: '2.4.0',
    faviconDomain: 'whatsapp.com',
    authSchema: {
      methods: [
        {
          type: 'interactive',
          required: true,
          scope: 'connection',
          expectedArtifact: 'qr',
          timeoutSec: 180,
          description:
            'Open WhatsApp → Settings → Linked Devices → Link a Device and scan the QR shown after you click Connect.',
        },
      ],
    },
    feeds: {
      messages: {
        key: 'messages',
        name: 'Messages',
        description: 'Personal WhatsApp messages from 1:1 and group chats.',
        configSchema: {
          type: 'object',
          properties: {
            chat_filter: {
              type: 'string',
              enum: ['all', 'individual', 'group'],
              default: 'all',
              description: 'Which chats to include.',
            },
            max_messages_per_sync: {
              type: 'integer',
              minimum: 1,
              maximum: 500000,
              default: 100000,
              description:
                'Safety cap on messages collected per sync. Set high enough to accept full history — the phone will stop streaming on its own.',
            },
            history_wait_seconds: {
              type: 'integer',
              minimum: 5,
              maximum: 1800,
              default: 600,
              description:
                'Seconds to wait for the phone to stream history after connecting. Large mailboxes need more time — initial pair can push 30k+ messages across many batches.',
            },
            pagination_budget_seconds: {
              type: 'integer',
              minimum: 0,
              maximum: 540,
              default: 300,
              description:
                'Max seconds per sync run spent on per-chat history pagination. Pagination state is checkpointed so each run resumes where the last left off. Set to 0 to disable.',
            },
            pages_per_chat_per_sync: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 5,
              description:
                'How many 50-msg pages to pull per chat in a single sync run. Keep low to respect phone rate limits; raise if you want faster backfill.',
            },
            sync_full_history: {
              type: 'boolean',
              default: true,
              description:
                'When true (default), the one-shot post-pairing socket asks WhatsApp for a full history dump. Disable for fast pairing with recent messages only — deeper history still flows via per-sync pagination.',
            },
          },
        },
        eventKinds: {
          message: {
            description: 'A WhatsApp message (text, caption, or system).',
            metadataSchema: {
              type: 'object',
              properties: {
                chat_jid: { type: 'string' },
                is_group: { type: 'boolean' },
                from_me: { type: 'boolean' },
                participant: { type: 'string' },
                sender_jid: { type: 'string' },
                sender_phone: { type: 'string' },
                push_name: { type: 'string' },
                media_type: { type: 'string' },
                quoted_id: { type: 'string' },
                is_forwarded: { type: 'boolean' },
              },
            },
            entityLinks: [
              {
                entityType: '$member',
                autoCreate: true,
                titlePath: 'metadata.push_name',
                identities: [
                  { namespace: IDENTITY.WA_JID, eventPath: 'metadata.sender_jid' },
                  { namespace: IDENTITY.PHONE, eventPath: 'metadata.sender_phone' },
                ],
                traits: {
                  push_name: {
                    eventPath: 'metadata.push_name',
                    behavior: 'prefer_non_empty',
                  },
                  last_seen_at: {
                    eventPath: 'occurred_at',
                    behavior: 'overwrite',
                  },
                },
              },
            ],
          },
        },
      },
    },
  };

  async authenticate(ctx: AuthContext): Promise<AuthResult> {
    // Baileys hands out a fixed batch of QR refs per socket (~5) then closes
    // with DisconnectReason.timedOut. If the user hasn't scanned yet we open a
    // new socket to get fresh refs — the auth run stays alive as long as the
    // pairing sheet is open. The loop terminates on success, abort, or a hard
    // rejection from WhatsApp (loggedOut).
    const creds = initAuthCreds();
    const keyStore = makeInMemoryKeyStore({});
    const authState: AuthenticationState = { creds, keys: keyStore };
    const { version } = await fetchLatestBaileysVersion();

    while (true) {
      if (ctx.signal.aborted) throw new Error('Pairing cancelled.');

      const outcome = await attemptPairing(ctx, authState, version);
      if (outcome === 'opened') break;
      if (outcome === 'aborted') throw new Error('Pairing cancelled.');
      if (outcome === 'loggedOut') {
        throw new Error('WhatsApp declined pairing. Please try again from your phone.');
      }
      // 'refsExpired' — open a fresh socket and keep the user in the flow.
    }

    // Baileys' QR flow leaves registered=false — mark it so the restart socket
    // (and later sync()) takes the re-login path instead of re-pairing.
    authState.creds.registered = true;

    // WhatsApp only pushes the history-sync notification once, shortly after
    // pairing. If we disconnect before draining it, subsequent syncs won't get
    // it back. Hold a fresh socket open until history arrives and quiets down,
    // then stash the collected events so sync() can emit them on first run.
    const maxMessages = (ctx.config.max_messages_per_sync as number) ?? 100_000;
    const historyWaitMs = ((ctx.config.history_wait_seconds as number) ?? 600) * 1000;
    const chatFilter = (ctx.config.chat_filter as 'all' | 'individual' | 'group') ?? 'all';
    const syncFullHistory = (ctx.config.sync_full_history as boolean | undefined) ?? true;

    // Auth only drains WhatsApp's one-shot history-sync dump. Deeper backfill
    // via per-chat fetchMessageHistory is handled by sync() with a checkpointed
    // frontier per chat, so a crashed pagination run can resume on the next
    // schedule rather than losing all its progress.
    const drainedEvents = await drainHistory(ctx, authState, version, {
      maxMessages,
      historyWaitMs,
      chatFilter,
      syncFullHistory,
    });

    const accountId = authState.creds.me?.id;
    const displayName = authState.creds.me?.name;
    const phone = accountId ? jidToPhone(accountId) : undefined;

    return {
      credentials: {
        ...dumpSession(authState.creds, keyStore.snapshot()),
        pending_events: drainedEvents.map(serializeEvent),
      },
      metadata: {
        account_id: accountId,
        display_name: displayName ?? (phone ? `+${phone}` : undefined),
        paired_at: new Date().toISOString(),
        history_drained: drainedEvents.length,
        sync_full_history: syncFullHistory,
        ...(phone ? { phone } : {}),
      },
    };
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const session = (ctx.sessionState ?? {}) as SerializedSession;
    if (!session.creds) {
      throw new Error('WhatsApp auth profile missing — re-pair required.');
    }

    const checkpoint = (ctx.checkpoint ?? {}) as WhatsAppCheckpoint;
    const maxMessages = (ctx.config.max_messages_per_sync as number) ?? 100_000;
    const historyWaitMs = ((ctx.config.history_wait_seconds as number) ?? 600) * 1000;
    const chatFilter = (ctx.config.chat_filter as 'all' | 'individual' | 'group') ?? 'all';
    const paginationBudgetMs = ((ctx.config.pagination_budget_seconds as number) ?? 300) * 1000;
    const pagesPerChat = (ctx.config.pages_per_chat_per_sync as number) ?? 5;

    // Pending events from the pairing drain — emit them on the first sync and
    // clear the field via auth_update so they aren't re-emitted.
    const pendingEvents: EventEnvelope[] = Array.isArray(session.pending_events)
      ? session.pending_events.map(deserializeEvent)
      : [];

    const { creds, keys } = loadAuthState(session);
    if (!creds.registered) {
      throw new Error('WhatsApp auth profile is unregistered — re-pair required.');
    }
    const keyStore = makeInMemoryKeyStore(keys);
    const authState: AuthenticationState = { creds, keys: keyStore };

    const { version } = await fetchLatestBaileysVersion();
    // Sync socket never re-requests full history — the post-pairing drain
    // covers that, and ongoing depth is handled by paginateIncremental.
    // Leaving this `true` would tempt WhatsApp to push a fresh history dump
    // on each reconnect, duplicating work the pagination path already owns.
    const sock = makeWASocket({
      version,
      auth: authState,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      logger: silentLogger,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    const chatNames = new Map<string, string>();
    const collected: WAMessage[] = [];
    let lastEventAt = Date.now();
    let loggedOut = false;

    sock.ev.on('creds.update', (partial) => {
      Object.assign(authState.creds, partial);
    });

    sock.ev.on('chats.upsert', (chats) => {
      for (const c of chats) {
        const name = (c.name as string | undefined) ?? (c.subject as string | undefined);
        if (c.id && name) chatNames.set(c.id, name);
      }
    });

    sock.ev.on('messaging-history.set', ({ messages, chats }) => {
      for (const c of chats) {
        const name = (c.name as string | undefined) ?? (c.subject as string | undefined);
        if (c.id && name) chatNames.set(c.id, name);
      }
      for (const m of messages) collected.push(m);
      lastEventAt = Date.now();
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages) collected.push(m);
      lastEventAt = Date.now();
    });

    sock.ev.on('connection.update', (u: Partial<ConnectionState>) => {
      const err = u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
      if (err?.output?.statusCode === DisconnectReason.loggedOut) loggedOut = true;
    });

    try {
      const opened = await waitForOpen(sock, 30_000);
      if (!opened) {
        sock.end(undefined);
        if (loggedOut) {
          return {
            events: pendingEvents,
            checkpoint: {} as Record<string, unknown>,
            auth_update: { creds: null, keys: null, pending_events: null }, // wipe
            metadata: { logged_out: true },
          };
        }
        throw new Error('Timed out waiting for WhatsApp connection (30s).');
      }

      // Phase 1: live drain for new messages + any residual history-sync tail.
      // Sync subprocess timeout is 10min, so we split the budget: ~2min live
      // drain, ~5min pagination, buffer for cleanup.
      const phase1Start = Date.now();
      const quietMs = 15_000;
      const liveDrainSoftCapMs = 2 * 60_000;
      while (Date.now() - phase1Start < liveDrainSoftCapMs && collected.length < maxMessages) {
        const sinceQuiet = Date.now() - lastEventAt;
        const totalElapsed = Date.now() - phase1Start;
        const effectiveHistoryWait = Math.min(historyWaitMs, liveDrainSoftCapMs);
        if (sinceQuiet >= quietMs && totalElapsed >= effectiveHistoryWait) break;
        await delay(500);
      }

      // Phase 2: per-chat incremental backward walk using fetchMessageHistory.
      // Seed frontiers from checkpoint, updating with anything newly collected
      // (pending_events on first sync, live drain since). Reuse listeners that
      // are already pushing to `collected`.
      const frontiers: Record<string, ChatFrontier> = {
        ...(checkpoint.chat_frontiers ?? {}),
      };
      seedFrontiersFromEvents(frontiers, pendingEvents);
      seedFrontiersFromMessages(frontiers, collected);

      const paginationResult = await paginateIncremental(sock, collected, frontiers, {
        budgetMs: paginationBudgetMs,
        maxPagesPerChat: pagesPerChat,
        pageSize: 50,
        abortSignal: ctx.signal,
      });

      // Turn everything collected this run into events. Don't filter by
      // `last_message_at` — pagination fetches OLDER messages on purpose, and
      // we dedupe downstream by origin_id.
      const newEvents = collectEvents(collected, chatNames, chatFilter, maxMessages, 0);
      const events = mergeEvents(pendingEvents, newEvents, maxMessages);

      const authUpdate = {
        ...dumpSession(authState.creds, keyStore.snapshot()),
        pending_events: null, // consumed
      };
      sock.end(undefined);

      const activeChats = Object.values(frontiers).filter((f) => !f.exhausted).length;

      return {
        events,
        checkpoint: {
          last_message_at: newestTimestamp(events) ?? checkpoint.last_message_at,
          chat_frontiers: frontiers,
          paginated_at: new Date().toISOString(),
        } satisfies WhatsAppCheckpoint as Record<string, unknown>,
        auth_update: authUpdate,
        metadata: {
          items_found: events.length,
          pending_drained: pendingEvents.length,
          pagination_advanced: paginationResult.advanced,
          pagination_exhausted: paginationResult.exhausted,
          chats_remaining: activeChats,
        },
      };
    } catch (error) {
      try {
        sock.end(undefined);
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: 'Actions not supported in v1.' };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PairingOutcome = 'opened' | 'refsExpired' | 'loggedOut' | 'aborted';

async function attemptPairing(
  ctx: AuthContext,
  authState: AuthenticationState,
  version: [number, number, number]
): Promise<PairingOutcome> {
  // Start from a fresh socket on each attempt so Baileys hands out a new batch
  // of QR refs. Reuse the same authState so credentials accumulate across
  // restarts (relevant once pairing actually succeeds).
  // This socket only waits for `connection: 'open'` and closes — history
  // drainage happens on a separate, post-pairing socket in drainHistory.
  const sock = makeWASocket({
    version,
    auth: authState,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    logger: silentLogger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  const credsListener = (partial: Partial<AuthenticationCreds>): void => {
    Object.assign(authState.creds, partial);
  };
  sock.ev.on('creds.update', credsListener);

  return await new Promise<PairingOutcome>((resolve) => {
    let newLogin = false;
    let settled = false;
    const settle = (outcome: PairingOutcome) => {
      if (settled) return;
      settled = true;
      sock.ev.off('connection.update', handler);
      sock.ev.off('creds.update', credsListener);
      ctx.signal.removeEventListener('abort', onAbort);
      try {
        sock.end(undefined);
      } catch {
        /* ignore */
      }
      resolve(outcome);
    };

    const onAbort = () => settle('aborted');

    const handler = (u: Partial<ConnectionState>) => {
      if (u.qr) {
        // Baileys keeps the first QR live for 60s and subsequent ones for 20s.
        // Use the longer window so the UI never flashes "Expired" between
        // legitimate rotations; the next emit will replace this value.
        void ctx.emit({
          type: 'qr',
          value: u.qr,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          instructions: 'Open WhatsApp → Settings → Linked Devices → Link a Device → scan this QR.',
        });
      }
      if (u.isNewLogin) newLogin = true;
      if (u.connection === 'open') {
        settle('opened');
        return;
      }
      if (u.connection === 'close') {
        const err = u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
        const statusCode = err?.output?.statusCode;
        if (newLogin && statusCode === DisconnectReason.restartRequired) {
          settle('opened');
        } else if (statusCode === DisconnectReason.loggedOut) {
          settle('loggedOut');
        } else {
          // timedOut, connectionClosed, connectionLost, etc. — refs ran out
          // or server dropped us; let the outer loop spin up a fresh socket.
          settle('refsExpired');
        }
      }
    };

    sock.ev.on('connection.update', handler);
    ctx.signal.addEventListener('abort', onAbort);
  });
}

/**
 * Open a fresh (post-pairing) socket, listen for `messaging-history.set` and
 * live `messages.upsert` events, and return once history has quieted. WhatsApp
 * only delivers the history-sync notification once after pairing — if we
 * disconnect before draining it, subsequent re-login sockets won't see it.
 */
async function drainHistory(
  ctx: AuthContext,
  authState: AuthenticationState,
  version: [number, number, number],
  opts: {
    maxMessages: number;
    historyWaitMs: number;
    chatFilter: 'all' | 'individual' | 'group';
    syncFullHistory: boolean;
  }
): Promise<EventEnvelope[]> {
  const sock = makeWASocket({
    version,
    auth: authState,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    logger: silentLogger,
    syncFullHistory: opts.syncFullHistory,
    markOnlineOnConnect: false,
  });

  const chatNames = new Map<string, string>();
  const collected: WAMessage[] = [];
  let lastEventAt = Date.now();

  const credsListener = (partial: Partial<AuthenticationCreds>) => {
    Object.assign(authState.creds, partial);
  };
  const chatsListener = (chats: Array<Record<string, unknown>>) => {
    for (const c of chats) {
      const id = c.id as string | undefined;
      const name = (c.name as string | undefined) ?? (c.subject as string | undefined);
      if (id && name) chatNames.set(id, name);
    }
  };
  const historyListener = ({
    messages,
    chats,
  }: {
    messages: WAMessage[];
    chats: Array<Record<string, unknown>>;
  }) => {
    chatsListener(chats);
    for (const m of messages) collected.push(m);
    lastEventAt = Date.now();
  };
  const messagesListener = ({ messages }: { messages: WAMessage[] }) => {
    for (const m of messages) collected.push(m);
    lastEventAt = Date.now();
  };

  sock.ev.on('creds.update', credsListener);
  sock.ev.on('chats.upsert', chatsListener);
  sock.ev.on('messaging-history.set', historyListener);
  sock.ev.on('messages.upsert', messagesListener);

  const cleanup = () => {
    sock.ev.off('creds.update', credsListener);
    sock.ev.off('chats.upsert', chatsListener);
    sock.ev.off('messaging-history.set', historyListener);
    sock.ev.off('messages.upsert', messagesListener);
    try {
      sock.end(undefined);
    } catch {
      /* ignore */
    }
  };

  try {
    const opened = await waitForOpen(sock, 30_000);
    if (!opened) {
      // Socket never reached open during drain — nothing collected, fall back
      // to letting the first sync() pick up history if any remains.
      return [];
    }

    // Auth runs have no subprocess timeout — we can wait as long as needed for
    // the phone to finish streaming. Quiet period detects "done"; the hard
    // ceiling is just a safety net for stuck sockets.
    const start = Date.now();
    const quietMs = 30_000;
    const softCapMs = 45 * 60_000;
    while (Date.now() - start < softCapMs && collected.length < opts.maxMessages) {
      if (ctx.signal.aborted) break;
      const sinceQuiet = Date.now() - lastEventAt;
      const totalElapsed = Date.now() - start;
      if (sinceQuiet >= quietMs && totalElapsed >= opts.historyWaitMs) break;
      await delay(500);
    }

    return collectEvents(collected, chatNames, opts.chatFilter, opts.maxMessages, 0);
  } finally {
    cleanup();
  }
}

/**
 * Per-sync incremental backward walk. Reads `frontiers` (the oldest message
 * key/timestamp seen per chat so far), issues `fetchMessageHistory` to pull
 * older pages, and returns updated frontiers. Callers persist the result in
 * `checkpoint.chat_frontiers` so the next sync run resumes from where this
 * one stopped — crash-resilient. Bounded by time budget and per-chat page
 * count to stay well inside the subprocess timeout.
 */
async function paginateIncremental(
  sock: ReturnType<typeof makeWASocket>,
  collected: WAMessage[],
  frontiers: Record<string, ChatFrontier>,
  opts: {
    budgetMs: number;
    maxPagesPerChat: number;
    pageSize: number;
    abortSignal?: AbortSignal;
  }
): Promise<{ advanced: number; exhausted: number }> {
  if (opts.budgetMs <= 0) return { advanced: 0, exhausted: 0 };

  type FetchHistoryFn = (
    count: number,
    oldestKey: WAMessageKey,
    oldestTs: number
  ) => Promise<string>;
  const fetchHistory = (sock as unknown as { fetchMessageHistory?: FetchHistoryFn })
    .fetchMessageHistory;
  if (typeof fetchHistory !== 'function') return { advanced: 0, exhausted: 0 };

  const start = Date.now();
  const perRequestWaitMs = 2500;
  const responseWindowMs = 8000;
  let advanced = 0;
  let exhausted = 0;

  // Round-robin: one request per chat per round, so no chat monopolizes the
  // budget. Stop when we've done maxPagesPerChat per chat, the budget runs
  // out, or every chat is exhausted.
  for (let round = 0; round < opts.maxPagesPerChat; round++) {
    let madeProgressThisRound = false;

    for (const [chat, frontier] of Object.entries(frontiers)) {
      if (frontier.exhausted) continue;
      if (chat === 'status@broadcast') {
        frontier.exhausted = true;
        exhausted++;
        continue;
      }
      if (Date.now() - start >= opts.budgetMs) return { advanced, exhausted };
      if (opts.abortSignal?.aborted) return { advanced, exhausted };

      const frontierKey: WAMessageKey = {
        remoteJid: chat,
        fromMe: false,
        id: frontier.oldest_id,
      };

      const beforeLen = collected.length;
      try {
        await fetchHistory.call(sock, opts.pageSize, frontierKey, frontier.oldest_ts);
      } catch {
        frontier.exhausted = true;
        exhausted++;
        continue;
      }

      // Wait for the async response. Success = we see messages in this chat
      // older than the current frontier; failure = nothing older arrives
      // within the response window, so the chat is done.
      const waitStart = Date.now();
      let newOldestTs = frontier.oldest_ts;
      let newOldestId = frontier.oldest_id;
      while (Date.now() - waitStart < responseWindowMs) {
        await delay(250);
        for (let i = beforeLen; i < collected.length; i++) {
          const m = collected[i];
          const k = m.key as WAMessageKey | undefined;
          if (!k?.id || k.remoteJid !== chat) continue;
          const ts = extractTs(m);
          if (!ts) continue;
          if (ts < newOldestTs) {
            newOldestTs = ts;
            newOldestId = k.id;
          }
        }
        if (newOldestTs < frontier.oldest_ts) break;
      }

      if (newOldestTs < frontier.oldest_ts) {
        frontier.oldest_ts = newOldestTs;
        frontier.oldest_id = newOldestId;
        advanced++;
        madeProgressThisRound = true;
      } else {
        frontier.exhausted = true;
        exhausted++;
      }

      await delay(perRequestWaitMs);
    }

    if (!madeProgressThisRound) break;
  }

  return { advanced, exhausted };
}

/**
 * Initialize pagination frontiers from already-ingested events. For chats
 * without an entry yet, seed with the oldest event we have for that chat so
 * the next fetchMessageHistory call reaches back from there.
 */
function seedFrontiersFromEvents(
  frontiers: Record<string, ChatFrontier>,
  events: EventEnvelope[]
): void {
  for (const e of events) {
    const chat = (e.metadata as { chat_jid?: string } | undefined)?.chat_jid;
    if (!chat || chat === 'status@broadcast') continue;
    const ts = Math.floor(e.occurred_at.getTime() / 1000);
    if (!ts) continue;
    const cur = frontiers[chat];
    if (!cur) {
      frontiers[chat] = { oldest_id: e.origin_id, oldest_ts: ts };
    } else if (!cur.exhausted && ts < cur.oldest_ts) {
      cur.oldest_id = e.origin_id;
      cur.oldest_ts = ts;
    }
  }
}

function seedFrontiersFromMessages(
  frontiers: Record<string, ChatFrontier>,
  messages: WAMessage[]
): void {
  for (const m of messages) {
    const key = m.key as WAMessageKey | undefined;
    const chat = key?.remoteJid;
    if (!chat || !key?.id || chat === 'status@broadcast') continue;
    const ts = extractTs(m);
    if (!ts) continue;
    const cur = frontiers[chat];
    if (!cur) {
      frontiers[chat] = { oldest_id: key.id, oldest_ts: ts };
    } else if (!cur.exhausted && ts < cur.oldest_ts) {
      cur.oldest_id = key.id;
      cur.oldest_ts = ts;
    }
  }
}

function extractTs(m: WAMessage): number | null {
  const raw = m.messageTimestamp as
    | number
    | { low?: number; toNumber?: () => number }
    | null
    | undefined;
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object') {
    if (typeof raw.toNumber === 'function') return raw.toNumber();
    if (typeof raw.low === 'number') return raw.low;
  }
  return null;
}

function serializeEvent(e: EventEnvelope): SerializedEvent {
  return { ...e, occurred_at: e.occurred_at.toISOString() };
}

function deserializeEvent(e: SerializedEvent): EventEnvelope {
  return { ...e, occurred_at: new Date(e.occurred_at) };
}

function mergeEvents(a: EventEnvelope[], b: EventEnvelope[], maxMessages: number): EventEnvelope[] {
  const seen = new Set<string>();
  const out: EventEnvelope[] = [];
  for (const e of [...a, ...b]) {
    if (seen.has(e.origin_id)) continue;
    seen.add(e.origin_id);
    out.push(e);
    if (out.length >= maxMessages) break;
  }
  out.sort((x, y) => y.occurred_at.getTime() - x.occurred_at.getTime());
  return out;
}

const silentLogger = {
  level: 'silent',
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
} as const;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForOpen(sock: ReturnType<typeof makeWASocket>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let newLogin = false;
    const timer = setTimeout(() => {
      sock.ev.off('connection.update', handler);
      resolve(false);
    }, timeoutMs);
    const handler = (u: Partial<ConnectionState>) => {
      if (u.isNewLogin) newLogin = true;
      if (u.connection === 'open') {
        clearTimeout(timer);
        sock.ev.off('connection.update', handler);
        resolve(true);
      } else if (u.connection === 'close') {
        const err = u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
        const statusCode = err?.output?.statusCode;
        if (newLogin && statusCode === DisconnectReason.restartRequired) {
          clearTimeout(timer);
          sock.ev.off('connection.update', handler);
          resolve(true);
          return;
        }
        if (statusCode === DisconnectReason.loggedOut) {
          clearTimeout(timer);
          sock.ev.off('connection.update', handler);
          resolve(false);
        }
      }
    };
    sock.ev.on('connection.update', handler);
  });
}

function loadAuthState(session: SerializedSession): {
  creds: AuthenticationCreds;
  keys: SignalDataSet;
} {
  if (!session.creds) return { creds: initAuthCreds(), keys: {} };
  try {
    const creds = JSON.parse(session.creds, BufferJSON.reviver) as AuthenticationCreds;
    const keys = session.keys
      ? (JSON.parse(session.keys, BufferJSON.reviver) as SignalDataSet)
      : {};
    return { creds, keys };
  } catch {
    return { creds: initAuthCreds(), keys: {} };
  }
}

function dumpSession(creds: AuthenticationCreds, keys: SignalDataSet): Record<string, unknown> {
  return {
    creds: JSON.stringify(creds, BufferJSON.replacer),
    keys: JSON.stringify(keys, BufferJSON.replacer),
  };
}

function makeInMemoryKeyStore(initial: SignalDataSet): SignalKeyStore & {
  snapshot: () => SignalDataSet;
} {
  const store: SignalDataSet = structuredClone(initial);
  return {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const out: { [id: string]: SignalDataTypeMap[T] } = {};
      const bucket = (store[type] ?? {}) as Record<string, SignalDataTypeMap[T]>;
      for (const id of ids) {
        if (bucket[id]) out[id] = bucket[id];
      }
      return out;
    },
    set: async (data) => {
      for (const rawType of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
        const typeData = data[rawType] as Record<string, unknown> | undefined;
        if (!typeData) continue;
        const bucket = (store[rawType] ??= {} as never) as Record<string, unknown>;
        for (const id of Object.keys(typeData)) {
          const value = typeData[id];
          if (value === null || value === undefined) delete bucket[id];
          else bucket[id] = value;
        }
      }
    },
    snapshot: () => store,
  };
}

function collectEvents(
  messages: WAMessage[],
  chatNames: Map<string, string>,
  filter: 'all' | 'individual' | 'group',
  maxMessages: number,
  sinceMs: number
): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    const event = toEvent(m, chatNames, filter);
    if (!event) continue;
    if (seen.has(event.origin_id)) continue;
    const ts = event.occurred_at.getTime();
    if (ts <= sinceMs) continue;
    seen.add(event.origin_id);
    events.push(event);
    if (events.length >= maxMessages) break;
  }
  events.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());
  return events;
}

function newestTimestamp(events: EventEnvelope[]): string | undefined {
  let newest = 0;
  for (const e of events) {
    const ts = e.occurred_at.getTime();
    if (ts > newest) newest = ts;
  }
  return newest ? new Date(newest).toISOString() : undefined;
}

export function toEvent(
  m: WAMessage,
  chatNames: Map<string, string>,
  filter: 'all' | 'individual' | 'group'
): EventEnvelope | null {
  const key = m.key as WAMessageKey | undefined;
  const chatJid = key?.remoteJid;
  const msgId = key?.id;
  if (!chatJid || !msgId) return null;

  const isGroup = chatJid.endsWith('@g.us');
  if (filter === 'individual' && isGroup) return null;
  if (filter === 'group' && !isGroup) return null;

  const text = extractText(m.message);
  if (!text) return null;

  const tsRaw =
    typeof m.messageTimestamp === 'number'
      ? m.messageTimestamp
      : ((m.messageTimestamp as { low?: number; toNumber?: () => number } | null)?.toNumber?.() ??
        (m.messageTimestamp as { low?: number } | null)?.low ??
        0);
  if (!tsRaw) return null;
  const occurredAt = new Date(tsRaw * 1000);

  const chatName = chatNames.get(chatJid) ?? jidToDisplay(chatJid);
  const authorName = m.pushName ?? (key.participant ? jidToDisplay(key.participant) : chatName);
  const fromMe = !!key.fromMe;
  const participant = key.participant ?? (isGroup ? undefined : chatJid);

  let senderJid: string | undefined;
  if (!fromMe) {
    if (isGroup) {
      senderJid = key.participant ?? undefined;
    } else if (isPersonJid(chatJid)) {
      senderJid = chatJid;
    }
  }
  const senderPhone = senderJid ? jidToPhone(senderJid) : undefined;
  const pushName = m.pushName ?? undefined;

  const quoted = m.message?.extendedTextMessage?.contextInfo?.stanzaId;
  const isForwarded = !!m.message?.extendedTextMessage?.contextInfo?.isForwarded;
  const mediaType = detectMediaType(m.message);

  return {
    origin_id: msgId,
    origin_type: 'message',
    payload_text: text,
    title: chatName,
    author_name: authorName,
    source_url: sourceUrlForChat(chatJid),
    occurred_at: occurredAt,
    origin_parent_id: chatJid,
    metadata: {
      chat_jid: chatJid,
      is_group: isGroup,
      from_me: fromMe,
      participant,
      ...(senderJid ? { sender_jid: senderJid } : {}),
      ...(senderPhone ? { sender_phone: senderPhone } : {}),
      ...(pushName ? { push_name: pushName } : {}),
      ...(mediaType ? { media_type: mediaType } : {}),
      ...(quoted ? { quoted_id: quoted } : {}),
      ...(isForwarded ? { is_forwarded: true } : {}),
    },
  };
}

function jidDomain(jid: string): string | null {
  const at = jid.indexOf('@');
  if (at <= 0) return null;
  return jid.slice(at + 1).toLowerCase();
}

function isPersonJid(jid: string): boolean {
  const domain = jidDomain(jid);
  return domain === 's.whatsapp.net' || domain === 'c.us' || domain === 'lid';
}

export function jidToPhone(jid: string): string | undefined {
  const at = jid.indexOf('@');
  if (at <= 0) return undefined;
  const domain = jid.slice(at + 1).toLowerCase();
  if (domain !== 's.whatsapp.net' && domain !== 'c.us') return undefined;
  const user = jid.slice(0, at).split(':')[0];
  if (!/^\d+$/.test(user)) return undefined;
  return user;
}

function extractText(msg: WAMessageContent | null | undefined): string | null {
  if (!msg) return null;
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg.videoMessage?.caption) return msg.videoMessage.caption;
  if (msg.documentMessage?.caption) return msg.documentMessage.caption;
  if (msg.ephemeralMessage?.message) return extractText(msg.ephemeralMessage.message);
  if (msg.viewOnceMessage?.message) return extractText(msg.viewOnceMessage.message);
  if (msg.viewOnceMessageV2?.message) return extractText(msg.viewOnceMessageV2.message);
  return null;
}

function detectMediaType(msg: WAMessageContent | null | undefined): string | null {
  if (!msg) return null;
  if (msg.imageMessage) return 'image';
  if (msg.videoMessage) return 'video';
  if (msg.audioMessage) return 'audio';
  if (msg.documentMessage) return 'document';
  if (msg.stickerMessage) return 'sticker';
  if (msg.locationMessage) return 'location';
  return null;
}

function jidToDisplay(jid: string): string {
  const at = jid.indexOf('@');
  return at > 0 ? jid.slice(0, at) : jid;
}

function sourceUrlForChat(jid: string): string | undefined {
  const domain = jidDomain(jid);
  if (domain !== 's.whatsapp.net' && domain !== 'c.us') return undefined;
  const number = jidToDisplay(jid).split(':')[0].replace(/[^\d]/g, '');
  return number ? `https://wa.me/${number}` : undefined;
}
