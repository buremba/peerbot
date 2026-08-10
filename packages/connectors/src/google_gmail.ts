/**
 * Gmail Connector (V1 runtime)
 *
 * Syncs email threads from Gmail and supports sending emails
 * via the Gmail API v1.
 */

import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  createHttpClient,
  type EventEnvelope,
  type HttpClient,
  paginateByCursor,
  type QueryContext,
  type QueryResult,
  type SearchContext,
  sleep,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

// ---------------------------------------------------------------------------
// Gmail API types
// ---------------------------------------------------------------------------

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet: string;
  payload: GmailMessagePayload;
  internalDate: string;
}

interface GmailMessagePayload {
  headers: GmailHeader[];
  mimeType: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePayload[];
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailThreadListResponse {
  threads?: Array<{ id: string; historyId: string; snippet: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailThreadGetResponse {
  id: string;
  historyId: string;
  messages: GmailMessage[];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GmailCheckpoint {
  last_sync_at?: string;
}

interface GmailConfig {
  label?: string;
  /** Labels to union in the sync query (e.g. ["INBOX", "SENT"]). When set, overrides `label`. */
  labels?: string[];
  max_results?: number;
  lookback_days?: number;
  /**
   * Only emit threads whose counterparty is plausibly a human, and stamp every
   * emitted thread `person_relevant`. Drives person minting/merging from a
   * narrow, high-signal subset of the mailbox while everything else stays a
   * virtual/live read. Receipt-only bulk senders (newsletters, no-reply,
   * brand addresses) are dropped.
   */
  human_senders_only?: boolean;
}

/** Stable column set returned by live `query()`/`search()` pushdown reads. */
const GMAIL_SEARCH_COLUMNS = [
  { name: 'id', type: 'string' },
  { name: 'thread_id', type: 'string' },
  { name: 'subject', type: 'string' },
  { name: 'from', type: 'string' },
  { name: 'from_name', type: 'string' },
  { name: 'from_email', type: 'string' },
  { name: 'date', type: 'string' },
  { name: 'snippet', type: 'string' },
  { name: 'url', type: 'string' },
];

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class GmailConnector extends ConnectorRuntime<GmailCheckpoint, GmailConfig> {
  readonly definition: ConnectorDefinition = {
    key: 'google.gmail',
    name: 'Gmail',
    description:
      'Syncs Gmail threads, live-reads matching messages, and supports sending, drafts, and replies.',
    version: '1.0.3',
    faviconDomain: 'mail.google.com',
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'google',
          requiredScopes: [
            'https://www.googleapis.com/auth/gmail.readonly',
            // compose covers drafts.create AND messages.send, so it is the single
            // write scope for create_draft/reply/send_email. It must be required
            // (not optional) — optional scopes are only requested when the caller
            // explicitly asks for them, so an unadorned connect() would omit it
            // and every write op would 403 insufficient-scope.
            'https://www.googleapis.com/auth/gmail.compose',
          ],
          loginScopes: ['openid', 'email', 'profile'],
          clientIdKey: 'GOOGLE_CLIENT_ID',
          clientSecretKey: 'GOOGLE_CLIENT_SECRET',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          tokenEndpointAuthMethod: 'client_secret_post',
          loginProvisioning: {
            autoCreateConnection: true,
          },
        },
      ],
    },
    feeds: {
      threads: {
        key: 'threads',
        name: 'Threads',
        requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        description:
          'Collected feeds sync Gmail threads; virtual feeds return live matching messages. Collected sync powers contact promotion (replied attributions).',
        // Collected remains the default: contact promotion + Behaviors need
        // durable events. Virtual is fully supported when the caller sets
        // virtual:true (query() / search() already implemented).
        configSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Optional Gmail search scope for virtual-feed reads (platform config.query), e.g. "label:INBOX newer_than:30d".',
            },
            label: {
              type: 'string',
              default: 'INBOX',
              description: 'Gmail label to sync (e.g. "INBOX", "SENT", "STARRED").',
            },
            labels: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Labels to union in the sync query, e.g. ["INBOX", "SENT"]. When set, overrides `label` so outbound-initiated threads are covered.',
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 500,
              default: 50,
              description: 'Maximum threads per sync; maximum messages per virtual page.',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 365,
              default: 30,
              description: 'Number of days to look back on initial sync.',
            },
            human_senders_only: {
              type: 'boolean',
              default: false,
              description:
                'Emit only threads whose counterparty is plausibly a human sender (drives person building). Sets `person_relevant` and drops bulk/brand/auto threads.',
            },
          },
        },
        eventKinds: {
          thread: {
            description: 'A Gmail email thread',
            metadataSchema: {
              type: 'object',
              properties: {
                message_count: { type: 'number' },
                label_ids: { type: 'array', items: { type: 'string' } },
                snippet: { type: 'string' },
                from_email: { type: 'string' },
                from_name: { type: 'string' },
                replied: {
                  type: 'boolean',
                  description:
                    'True when the thread contains both a counterparty message and a mailbox-authored SENT-labeled message — the interaction signal that gates contact promotion.',
                },
                person_relevant: {
                  type: 'boolean',
                  description:
                    'True when the counterparty is plausibly a human sender (a replied thread, or a human-looking sender under human_senders_only). Gates person minting.',
                },
              },
            },
            attributions: [
              {
                role: 'authored_by',
                // Promote on interaction, never on receipt alone. Every from-address
                // is a sender — overwhelmingly brands, newsletters, and no-reply
                // system addresses, all of which carry a from_name — so receipt
                // alone must not mint a contact. The gate is `person_relevant`,
                // computed by the connector: it is `replied` (a genuine
                // bidirectional exchange) by default, and a "plausible human"
                // heuristic when the feed opts into `human_senders_only`. Only
                // person-relevant senders materialize a `person`; everything else
                // still links to an existing contact on identity match. A thread
                // replied to after its first sync re-syncs (the reply is a new
                // message inside the `after:` window), so promotion follows the
                // reply.
                autoCreate: true,
                target: {
                  entityType: 'person',
                  createWhen: { path: 'metadata.person_relevant', equals: true },
                  titlePath: 'metadata.from_name',
                  identities: [{ namespace: 'email', eventPath: 'metadata.from_email' }],
                },
                traits: {
                  from_name: {
                    eventPath: 'metadata.from_name',
                    behavior: 'prefer_non_empty',
                  },
                  last_email_at: {
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
    actions: {
      send_email: {
        key: 'send_email',
        name: 'Send Email',
        description: 'Send an email via Gmail.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['to', 'subject', 'body'],
          properties: {
            to: { type: 'string', description: 'Recipient email address.' },
            subject: { type: 'string', description: 'Email subject line.' },
            body: { type: 'string', description: 'Email body (plain text).' },
            cc: { type: 'string', description: 'CC recipients (comma-separated).' },
            bcc: { type: 'string', description: 'BCC recipients (comma-separated).' },
          },
        },
      },
      create_draft: {
        key: 'create_draft',
        name: 'Create Draft',
        description: 'Create a draft email in Gmail.',
        inputSchema: {
          type: 'object',
          required: ['to', 'subject', 'body'],
          properties: {
            to: { type: 'string', description: 'Recipient email address.' },
            subject: { type: 'string', description: 'Email subject line.' },
            body: { type: 'string', description: 'Email body (plain text).' },
            cc: { type: 'string', description: 'CC recipients (comma-separated).' },
            bcc: { type: 'string', description: 'BCC recipients (comma-separated).' },
            thread_id: {
              type: 'string',
              description: 'Thread ID to attach the draft to (for replies).',
            },
          },
        },
      },
      reply: {
        key: 'reply',
        name: 'Reply to Thread',
        description: 'Send a reply to an existing email thread.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['thread_id', 'body'],
          properties: {
            thread_id: { type: 'string', description: 'Thread ID to reply to.' },
            body: { type: 'string', description: 'Reply body (plain text).' },
            to: {
              type: 'string',
              description: 'Override recipient (defaults to original sender).',
            },
            cc: { type: 'string', description: 'CC recipients (comma-separated).' },
          },
        },
      },
      search: {
        key: 'search',
		kind: 'read',
        name: 'Search Emails',
        description: 'Search emails by query.',
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query: {
              type: 'string',
              description: "Gmail search query e.g. 'from:someone subject:hello'.",
            },
            max_results: {
              type: 'integer',
              description: 'Maximum number of results to return (default 10).',
            },
          },
        },
      },
      get_thread: {
        key: 'get_thread',
		kind: 'read',
        name: 'Get Thread',
        description: 'Read full thread content.',
        inputSchema: {
          type: 'object',
          required: ['thread_id'],
          properties: {
            thread_id: { type: 'string', description: 'Thread ID to read.' },
          },
        },
      },
    },
  };

  private readonly BASE_URL = 'https://www.googleapis.com/gmail/v1/users/me';
  private readonly RATE_LIMIT_MS = 100;

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const syncStartedAt = new Date();
    const token = ctx.credentials?.accessToken;
    if (!token) {
      throw new Error('Gmail requires Google OAuth credentials.');
    }

    const label = ctx.config.label || 'INBOX';
    const labels = Array.isArray(ctx.config.labels)
      ? ctx.config.labels.filter((l) => typeof l === 'string' && l.trim().length > 0)
      : [];
    const maxResults = Math.min(ctx.config.max_results ?? 50, 500);
    const lookbackDays = ctx.config.lookback_days ?? 30;
    const humanSendersOnly = ctx.config.human_senders_only === true;

    const checkpoint = ctx.checkpoint ?? {}

    // Determine the "after" date for the query
    const afterDate = checkpoint.last_sync_at
      ? new Date(checkpoint.last_sync_at)
      : (() => {
          const d = new Date();
          d.setDate(d.getDate() - lookbackDays);
          return d;
        })();

    // Gmail's `after:` accepts a Unix timestamp (epoch seconds) for second-level
    // precision. Using `YYYY/MM/DD` (day granularity, host timezone) meant every
    // sync within the same day re-fetched the whole day's threads as duplicates.
    const afterEpochSeconds = Math.floor(afterDate.getTime() / 1000);
    // `labels` unions multiple labels (e.g. INBOX + SENT) so outbound-initiated
    // threads — often the strongest "this is a real contact" signal — are covered.
    const query =
      labels.length > 0
        ? `after:${afterEpochSeconds} (${labels.map((l) => `label:${l}`).join(' OR ')})`
        : `after:${afterEpochSeconds} label:${label}`;

    const http = this.createClient(token);
    const events: EventEnvelope[] = [];
    let totalCollected = 0;

    const pages = paginateByCursor<NonNullable<GmailThreadListResponse['threads']>[number], string>(
      async (pageToken) => {
        const params = new URLSearchParams({
          q: query,
          maxResults: String(Math.min(100, maxResults - totalCollected)),
        });
        if (pageToken) {
          params.set('pageToken', pageToken);
        }

        const listUrl = `${this.BASE_URL}/threads?${params.toString()}`;
        const listResponse = await http.raw(listUrl);

        if (!listResponse.ok) {
          throw new Error(
            `Gmail threads.list error (${listResponse.status}): ${await listResponse.text()}`
          );
        }

        const listData = (await listResponse.json()) as GmailThreadListResponse;
        return { items: listData.threads ?? [], nextCursor: listData.nextPageToken };
      },
      { delayMs: this.RATE_LIMIT_MS }
    );

    for await (const threads of pages) {
      if (threads.length === 0) break;

      // Fetch each thread with metadata format
      for (const threadStub of threads) {
        try {
          const threadUrl = `${this.BASE_URL}/threads/${threadStub.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`;
          const threadResponse = await http.raw(threadUrl);

          if (!threadResponse.ok) continue;

          const thread = (await threadResponse.json()) as GmailThreadGetResponse;

          if (!thread.messages || thread.messages.length === 0) continue;

          const firstMessage = thread.messages[0];
          const isSent = (m: GmailMessage) => (m.labelIds ?? []).includes('SENT');
          const sentMessage = thread.messages.find(isSent);
          const inboundMessage = thread.messages.find((message) => !isSent(message));
          // Prefer the first counterparty-authored message so an owner-started
          // thread never promotes the mailbox owner's own address. When the
          // thread is outbound-only (no reply yet), fall back to the sent
          // message's To header so the recipient still surfaces.
          const counterpartyMessage = inboundMessage ?? sentMessage;
          const subject = this.getHeader(firstMessage, 'Subject') || '(no subject)';
          const addressHeader =
            counterpartyMessage === sentMessage
              ? this.getHeader(counterpartyMessage, 'To')
              : this.getHeader(counterpartyMessage, 'From');
          const from = addressHeader || 'Unknown';
          const { name: fromName, email: fromEmail } = this.parseFromHeader(from);
          const dateHeader = this.getHeader(firstMessage, 'Date');
          const occurredAt = dateHeader
            ? new Date(dateHeader)
            : new Date(parseInt(firstMessage.internalDate, 10));

          if (Number.isNaN(occurredAt.getTime())) continue;

          // A bidirectional exchange has at least one mailbox-authored message
          // and one inbound counterparty message, regardless of who started it.
          // An outbound-only thread (no reply yet) is NOT replied — the sent
          // fallback exists so the recipient surfaces, not so it counts as an
          // interaction.
          const replied = inboundMessage !== undefined && sentMessage !== undefined;
          // Person-relevance gates minting: `replied` by default; a "plausible
          // human" heuristic when the feed opts into human_senders_only.
          const personRelevant = humanSendersOnly
            ? isHumanSender(fromEmail, fromName, replied)
            : replied;

          // Under human_senders_only the sync is deliberately narrow — only
          // person-relevant threads are persisted (everything else stays a live
          // read), so the DB only holds the high-signal set that drives person
          // building.
          if (humanSendersOnly && !personRelevant) continue;

          const event: EventEnvelope = {
            origin_id: thread.id,
            title: subject,
            payload_text: firstMessage.snippet || '',
            author_name: from,
            source_url: `https://mail.google.com/mail/u/0/#inbox/${thread.id}`,
            occurred_at: occurredAt,
            origin_type: 'thread',
            metadata: {
              message_count: thread.messages.length,
              label_ids: firstMessage.labelIds ?? [],
              snippet: firstMessage.snippet,
              replied,
              person_relevant: personRelevant,
              ...(fromEmail ? { from_email: fromEmail } : {}),
              ...(fromName ? { from_name: fromName } : {}),
            },
          };

          events.push(event);
          totalCollected++;

          await sleep(this.RATE_LIMIT_MS);
        } catch {
          /* skip individual thread failures */
        }
      }

      if (totalCollected >= maxResults) break;
    }

    // Sort by occurred_at descending
    events.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());

    const newCheckpoint: GmailCheckpoint = {
      // Keep events that arrive while this sync is running inside the next window.
      last_sync_at: syncStartedAt.toISOString(),
    };

    return {
      events,
      checkpoint: newCheckpoint,
      metadata: {
        items_found: events.length,
      },
    };
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------

  async execute(ctx: ActionContext): Promise<ActionResult> {
    try {
      const token = ctx.credentials?.accessToken;
      if (!token) {
        return { success: false, error: 'Gmail actions require Google OAuth credentials.' };
      }

      const http = this.createClient(token);

      switch (ctx.actionKey) {
        case 'send_email':
          return await this.sendEmail(http, ctx.input);
        case 'create_draft':
          return await this.createDraft(http, ctx.input);
        case 'reply':
          return await this.replyToThread(http, ctx.input);
        case 'search':
          return await this.searchEmails(http, ctx.input);
        case 'get_thread':
          return await this.getThread(http, ctx.input);
        default:
          return { success: false, error: `Unknown action: ${ctx.actionKey}` };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Live pushdown (virtual feeds) — read-only, never persisted.
  // `query()` runs the feed's configured Gmail search string; `search()` adds
  // keyword `terms` as an AND predicate (Gmail's `q` is space-separated = AND).
  // Both return the same row shape so a virtual `threads` feed is consistent
  // whether read bare or with recall terms pushed down.
  // -------------------------------------------------------------------------

  async query(ctx: QueryContext<GmailConfig>): Promise<QueryResult> {
    return this.liveSearch(ctx, ctx.query, []);
  }

  async search(ctx: SearchContext<GmailConfig>): Promise<QueryResult> {
    return this.liveSearch(ctx, ctx.query, ctx.terms ?? []);
  }

  /**
   * Shared live read: build a Gmail `q` from the base predicate plus optional
   * keyword terms, list matching messages, then fetch each message's metadata
   * (Subject/From/Date) + snippet. Returns rows + a stable column set.
   */
  private async liveSearch(
    ctx: QueryContext<GmailConfig>,
    baseQuery: string,
    terms: string[]
  ): Promise<QueryResult> {
    const token = ctx.credentials?.accessToken;
    if (!token) {
      throw new Error('Gmail virtual-feed reads require Google OAuth credentials.');
    }

    // Gmail's `q` is space-separated = AND. Compose the feed's optional scope
    // (config.query) with the caller's terms as raw Gmail search syntax — each
    // connector interprets search() terms; we do not escape operators here.
    // An empty string means no `q` filter — list the authenticated mailbox.
    const parts = [baseQuery.trim(), ...terms.map((t) => t.trim())].filter(Boolean);
    const q = parts.join(' ');

    // Gmail search has no arbitrary sort — results are always reverse-chronological
    // (newest first). Reject a sort we can't honor rather than silently ignore it.
    if (ctx.sort && !(ctx.sort.column === 'date' && ctx.sort.order === 'desc')) {
      throw new Error(
        `Gmail virtual feed only supports sort {column:'date', order:'desc'} (newest first); got ${JSON.stringify(ctx.sort)}.`
      );
    }

    const limit = Math.min(Math.max(Math.trunc(ctx.limit ?? ctx.config.max_results ?? 25), 1), 100);
    const offset = Math.max(Math.trunc(ctx.offset ?? 0), 0);

    // Apply offset by listing offset+limit ids then dropping the leading `offset`.
    // Gmail's list endpoint has no offset param, only forward pagination.
    const http = this.createClient(token);
    const ids = (await this.listMessageIds(http, q, offset + limit)).slice(offset, offset + limit);
    const rows = await this.fetchMessageRows(http, ids);

    // No `total`: Gmail's list endpoint returns no reliable match count, and
    // `resultSizeEstimate` is a coarse estimate — reporting the page length as a
    // total would be wrong. Callers page until a short page.
    return { rows, columns: GMAIL_SEARCH_COLUMNS };
  }

  private async listMessageIds(
    http: HttpClient,
    q: string,
    want: number
  ): Promise<Array<{ id: string; threadId: string }>> {
    const out: Array<{ id: string; threadId: string }> = [];
    let pageToken: string | undefined;
    do {
      const remaining = want - out.length;
      if (remaining <= 0) break;
      const params = new URLSearchParams({
        maxResults: String(Math.min(100, remaining)),
      });
      if (q) params.set('q', q);
      if (pageToken) params.set('pageToken', pageToken);
      const res = await http.raw(`${this.BASE_URL}/messages?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`Gmail messages.list error (${res.status}): ${await res.text()}`);
      }
      const data = (await res.json()) as {
        messages?: Array<{ id: string; threadId: string }>;
        nextPageToken?: string;
      };
      for (const m of data.messages ?? []) out.push({ id: m.id, threadId: m.threadId });
      pageToken = data.nextPageToken;
    } while (pageToken && out.length < want);
    return out.slice(0, want);
  }

  private async fetchMessageRows(
    http: HttpClient,
    ids: Array<{ id: string; threadId: string }>
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (const m of ids) {
      const url = `${this.BASE_URL}/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;
      const res = await http.raw(url);
      if (!res.ok) continue; // skip a single unreachable message, keep the batch reliable
      const msg = (await res.json()) as GmailMessage;
      const rawFrom = this.getHeader(msg, 'From') || 'Unknown';
      const { name, email } = this.parseFromHeader(rawFrom);
      rows.push({
        id: msg.id,
        thread_id: msg.threadId,
        subject: this.getHeader(msg, 'Subject') || '(no subject)',
        from: rawFrom,
        from_name: name,
        from_email: email,
        date: this.getHeader(msg, 'Date') || '',
        snippet: msg.snippet || '',
        url: `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}`,
      });
    }
    return rows;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async sendEmail(http: HttpClient, input: Record<string, unknown>): Promise<ActionResult> {
    const to = input.to as string;
    const subject = input.subject as string;
    const body = input.body as string;
    const cc = input.cc as string | undefined;
    const bcc = input.bcc as string | undefined;

    if (!to || !subject || !body) {
      return { success: false, error: 'to, subject, and body are required.' };
    }

    // Build RFC 2822 message
    const messageParts: string[] = [`To: ${to}`, `Subject: ${subject}`];
    if (cc) messageParts.push(`Cc: ${cc}`);
    if (bcc) messageParts.push(`Bcc: ${bcc}`);
    messageParts.push('Content-Type: text/plain; charset=utf-8');
    messageParts.push('');
    messageParts.push(body);

    const rawMessage = messageParts.join('\r\n');
    const encoded = this.base64UrlEncode(rawMessage);

    const sendUrl = `${this.BASE_URL}/messages/send`;
    const response = await http.raw(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encoded }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Gmail send error (${response.status}): ${errText}` };
    }

    const result = (await response.json()) as { id: string; threadId: string; labelIds: string[] };

    return {
      success: true,
      output: {
        message_id: result.id,
        thread_id: result.threadId,
        url: `https://mail.google.com/mail/u/0/#inbox/${result.threadId}`,
      },
    };
  }

  private async createDraft(
    http: HttpClient,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const to = input.to as string;
    const subject = input.subject as string;
    const body = input.body as string;
    const cc = input.cc as string | undefined;
    const bcc = input.bcc as string | undefined;
    const threadId = input.thread_id as string | undefined;

    if (!to || !subject || !body) {
      return { success: false, error: 'to, subject, and body are required.' };
    }

    const messageParts: string[] = [`To: ${to}`, `Subject: ${subject}`];
    if (cc) messageParts.push(`Cc: ${cc}`);
    if (bcc) messageParts.push(`Bcc: ${bcc}`);
    messageParts.push('Content-Type: text/plain; charset=utf-8', '', body);

    const raw = this.base64UrlEncode(messageParts.join('\r\n'));
    const draftBody: { message: { raw: string; threadId?: string } } = { message: { raw } };
    if (threadId) draftBody.message.threadId = threadId;

    const response = await http.raw(`${this.BASE_URL}/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draftBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Gmail draft error (${response.status}): ${errText}` };
    }

    const result = (await response.json()) as {
      id: string;
      message: { id: string; threadId: string };
    };
    return {
      success: true,
      output: {
        draft_id: result.id,
        message_id: result.message.id,
        thread_id: result.message.threadId,
        url: `https://mail.google.com/mail/u/0/#drafts/${result.message.id}`,
      },
    };
  }

  private async replyToThread(
    http: HttpClient,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const threadId = input.thread_id as string;
    const body = input.body as string;
    const cc = input.cc as string | undefined;

    if (!threadId || !body) {
      return { success: false, error: 'thread_id and body are required.' };
    }

    // Fetch the thread to get the last message's headers
    const threadRes = await http.raw(
      `${this.BASE_URL}/threads/${threadId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Message-ID`
    );
    if (!threadRes.ok) {
      return {
        success: false,
        error: `Failed to fetch thread (${threadRes.status}): ${await threadRes.text()}`,
      };
    }

    const thread = (await threadRes.json()) as { messages: GmailMessage[] };
    const lastMsg = thread.messages[thread.messages.length - 1];
    const subject = this.getHeader(lastMsg, 'Subject') || '';
    const from = this.getHeader(lastMsg, 'From') || '';
    const messageId = this.getHeader(lastMsg, 'Message-ID') || '';
    const to = (input.to as string) || from;

    const messageParts: string[] = [
      `To: ${to}`,
      `Subject: ${subject.startsWith('Re:') ? subject : `Re: ${subject}`}`,
      `In-Reply-To: ${messageId}`,
      `References: ${messageId}`,
    ];
    if (cc) messageParts.push(`Cc: ${cc}`);
    messageParts.push('Content-Type: text/plain; charset=utf-8', '', body);

    const raw = this.base64UrlEncode(messageParts.join('\r\n'));

    const response = await http.raw(`${this.BASE_URL}/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw, threadId }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Gmail reply error (${response.status}): ${errText}` };
    }

    const result = (await response.json()) as { id: string; threadId: string };
    return {
      success: true,
      output: {
        message_id: result.id,
        thread_id: result.threadId,
        url: `https://mail.google.com/mail/u/0/#inbox/${result.threadId}`,
      },
    };
  }

  private async searchEmails(
    http: HttpClient,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const query = input.query as string;
    const maxResults = (input.max_results as number) || 10;

    if (!query) {
      return { success: false, error: 'query is required.' };
    }

    const params = new URLSearchParams({
      q: query,
      maxResults: String(maxResults),
    });
    const listUrl = `${this.BASE_URL}/messages?${params.toString()}`;
    const listResponse = await http.raw(listUrl);

    if (!listResponse.ok) {
      const errText = await listResponse.text();
      return { success: false, error: `Gmail search error (${listResponse.status}): ${errText}` };
    }

    const listData = (await listResponse.json()) as {
      messages?: Array<{ id: string; threadId: string }>;
    };

    if (!listData.messages || listData.messages.length === 0) {
      return { success: true, output: { messages: [] } };
    }

    const messages: Array<{
      id: string;
      thread_id: string;
      subject: string;
      from: string;
      date: string;
      url: string;
    }> = [];

    for (const msg of listData.messages) {
      const msgUrl = `${this.BASE_URL}/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;
      const msgResponse = await http.raw(msgUrl);
      if (!msgResponse.ok) continue;

      const msgData = (await msgResponse.json()) as GmailMessage;
      messages.push({
        id: msgData.id,
        thread_id: msgData.threadId,
        subject: this.getHeader(msgData, 'Subject') || '(no subject)',
        from: this.getHeader(msgData, 'From') || 'Unknown',
        date: this.getHeader(msgData, 'Date') || '',
        url: `https://mail.google.com/mail/u/0/#inbox/${msgData.threadId}`,
      });
    }

    return { success: true, output: { messages } };
  }

  private async getThread(http: HttpClient, input: Record<string, unknown>): Promise<ActionResult> {
    const threadId = input.thread_id as string;

    if (!threadId) {
      return { success: false, error: 'thread_id is required.' };
    }

    const url = `${this.BASE_URL}/threads/${threadId}?format=full`;
    const response = await http.raw(url);

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Gmail thread error (${response.status}): ${errText}` };
    }

    const thread = (await response.json()) as GmailThreadGetResponse;
    const subject =
      thread.messages.length > 0
        ? this.getHeader(thread.messages[0], 'Subject') || '(no subject)'
        : '(no subject)';

    const messages = thread.messages.map((msg) => ({
      id: msg.id,
      from: this.getHeader(msg, 'From') || 'Unknown',
      date: this.getHeader(msg, 'Date') || '',
      snippet: msg.snippet,
      body: this.extractBody(msg.payload),
    }));

    return {
      success: true,
      output: {
        thread_id: thread.id,
        subject,
        messages,
        url: `https://mail.google.com/mail/u/0/#inbox/${thread.id}`,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private getHeader(message: GmailMessage, name: string): string | undefined {
    const header = message.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
    return header?.value;
  }

  /**
   * Parse an RFC 5322 From header into display name and email address.
   * Accepts: "Name <addr@host>", "<addr@host>", "addr@host", or quoted names.
   */
  private parseFromHeader(raw: string): { name: string | null; email: string | null } {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === 'Unknown') return { name: null, email: null };

    const angleMatch = trimmed.match(/^(.*?)<([^>]+)>\s*$/);
    if (angleMatch) {
      const name = angleMatch[1].trim().replace(/^"|"$/g, '').trim();
      const email = angleMatch[2].trim();
      return { name: name || null, email: email || null };
    }

    if (trimmed.includes('@') && !trimmed.includes(' ')) {
      return { name: null, email: trimmed };
    }

    return { name: trimmed, email: null };
  }

  private extractBody(payload: GmailMessagePayload): string {
    // Try to get body from payload.body.data directly
    if (payload.body?.data) {
      return this.base64UrlDecode(payload.body.data);
    }

    // Search through parts for text/plain or text/html
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return this.base64UrlDecode(part.body.data);
        }
      }
      // Fallback to text/html if no plain text
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          return this.base64UrlDecode(part.body.data);
        }
      }
      // Recurse into nested parts (e.g. multipart/alternative inside multipart/mixed)
      for (const part of payload.parts) {
        if (part.parts) {
          const nested = this.extractBody(part);
          if (nested) return nested;
        }
      }
    }

    return '';
  }

  private base64UrlDecode(data: string): string {
    const padded = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(padded, 'base64').toString('utf-8');
  }

  private base64UrlEncode(str: string): string {
    const encoded = Buffer.from(str, 'utf-8').toString('base64');
    return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private createClient(token: string): HttpClient {
    return createHttpClient({ token, errorPrefix: 'Gmail API' });
  }
}

// ---------------------------------------------------------------------------
// Human-sender heuristic (person-relevant sync mode)
// ---------------------------------------------------------------------------

/**
 * Local-parts that are almost never a human counterparty: automated/system
 * addresses (no-reply, bounce, mailer-daemon) and shared brand inboxes
 * (info@, marketing@, support@, hello@, …). Matched against the lowercased
 * local part of the From address.
 */
const AUTOMATED_LOCAL_PARTS = /^(?:no[._-]?reply|do[._-]?not[._-]?reply|donotreply|noreply|no\.reply|bounce|mailer[._-]?daemon|postmaster|abuse|notif(?:ications?)?|alert(?:s)?|support|team|info|news(?:letter)?|market(?:ing)?|contact|updates?|jobs|careers|press|media|events?|webmaster|automated|robot|hello|sales|billing|accounts|security|admin|root)$/;

/**
 * Consumer mail providers — a bare address here is overwhelmingly a personal
 * mailbox even without a display name or a replied thread.
 */
const CONSUMER_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'yahoo.com',
  'ymail.com',
  'proton.me',
  'protonmail.com',
  'fastmail.com',
  'zoho.com',
  'mail.com',
  'aol.com',
]);

/**
 * A display name that looks like a person's name: two or more capitalized
 * words ("John Smith", "Ana-Maria O'Brien"). Single-word brands ("LinkedIn",
 * "Spotify") and lowercase handles fail this, so a non-consumer corporate
 * sender needs a human-looking name to clear the bar.
 */
const HUMAN_NAME_RE = /^[A-ZÀ-Ý][a-zà-ÿ]+(?:[ '\u2019-][A-ZÀ-Ý][a-zà-ÿ]+)+$/;

/**
 * Whether a thread's counterparty is plausibly a human sender, deciding person
 * minting under `human_senders_only`. A replied thread is always human — the
 * mailbox owner's own engagement is the strongest signal — so it short-circuits
 * the address checks. An unreplied thread needs a non-automated address AND (a
 * consumer-mail domain OR a human-looking display name). Missing/unparseable
 * addresses are never human — there is nothing to attribute.
 */
export function isHumanSender(
  email: string | null | undefined,
  name: string | null | undefined,
  replied: boolean
): boolean {
  if (replied) return true;
  if (!email) return false;
  const at = email.lastIndexOf('@');
  if (at <= 0) return false;
  const local = email.slice(0, at).trim().toLowerCase();
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!local || !domain || AUTOMATED_LOCAL_PARTS.test(local)) return false;
  if (CONSUMER_MAIL_DOMAINS.has(domain)) return true;
  if (!name) return false;
  return HUMAN_NAME_RE.test(name.trim());
}
