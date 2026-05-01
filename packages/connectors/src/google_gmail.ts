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
  type EventEnvelope,
  IDENTITY,
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
// Checkpoint
// ---------------------------------------------------------------------------

interface GmailCheckpoint {
  last_sync_at?: string;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class GmailConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'google.gmail',
    name: 'Gmail',
    description: 'Syncs email threads from Gmail and supports sending emails.',
    version: '1.0.0',
    faviconDomain: 'mail.google.com',
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'google',
          requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
          optionalScopes: ['https://www.googleapis.com/auth/gmail.send'],
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
        description: 'Syncs email threads from Gmail.',
        configSchema: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              default: 'INBOX',
              description: 'Gmail label to sync (e.g. "INBOX", "SENT", "STARRED").',
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 500,
              default: 50,
              description: 'Maximum threads to fetch per sync.',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 365,
              default: 30,
              description: 'Number of days to look back on initial sync.',
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
              },
            },
            entityLinks: [
              {
                entityType: '$member',
                autoCreate: true,
                titlePath: 'metadata.from_name',
                identities: [{ namespace: IDENTITY.EMAIL, eventPath: 'metadata.from_email' }],
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
    const token = ctx.credentials?.accessToken;
    if (!token) {
      throw new Error('Gmail requires Google OAuth credentials.');
    }

    const label = (ctx.config.label as string) || 'INBOX';
    const maxResults = Math.min((ctx.config.max_results as number) ?? 50, 500);
    const lookbackDays = (ctx.config.lookback_days as number) ?? 30;

    const checkpoint = (ctx.checkpoint ?? {}) as GmailCheckpoint;

    // Determine the "after" date for the query
    const afterDate = checkpoint.last_sync_at
      ? new Date(checkpoint.last_sync_at)
      : (() => {
          const d = new Date();
          d.setDate(d.getDate() - lookbackDays);
          return d;
        })();

    const afterStr = `${afterDate.getFullYear()}/${String(afterDate.getMonth() + 1).padStart(2, '0')}/${String(afterDate.getDate()).padStart(2, '0')}`;
    const query = `after:${afterStr} label:${label}`;

    const events: EventEnvelope[] = [];
    let pageToken: string | undefined;
    let totalCollected = 0;

    while (totalCollected < maxResults) {
      const params = new URLSearchParams({
        q: query,
        maxResults: String(Math.min(100, maxResults - totalCollected)),
      });
      if (pageToken) {
        params.set('pageToken', pageToken);
      }

      const listUrl = `${this.BASE_URL}/threads?${params.toString()}`;
      const listResponse = await this.apiGet(listUrl, token);

      if (!listResponse.ok) {
        throw new Error(
          `Gmail threads.list error (${listResponse.status}): ${await listResponse.text()}`
        );
      }

      const listData = (await listResponse.json()) as GmailThreadListResponse;

      if (!listData.threads || listData.threads.length === 0) break;

      // Fetch each thread with metadata format
      for (const threadStub of listData.threads) {
        try {
          const threadUrl = `${this.BASE_URL}/threads/${threadStub.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;
          const threadResponse = await this.apiGet(threadUrl, token);

          if (!threadResponse.ok) continue;

          const thread = (await threadResponse.json()) as GmailThreadGetResponse;

          if (!thread.messages || thread.messages.length === 0) continue;

          const firstMessage = thread.messages[0];
          const subject = this.getHeader(firstMessage, 'Subject') || '(no subject)';
          const from = this.getHeader(firstMessage, 'From') || 'Unknown';
          const { name: fromName, email: fromEmail } = this.parseFromHeader(from);
          const dateHeader = this.getHeader(firstMessage, 'Date');
          const occurredAt = dateHeader
            ? new Date(dateHeader)
            : new Date(parseInt(firstMessage.internalDate, 10));

          if (Number.isNaN(occurredAt.getTime())) continue;

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
              ...(fromEmail ? { from_email: fromEmail } : {}),
              ...(fromName ? { from_name: fromName } : {}),
            },
          };

          events.push(event);
          totalCollected++;

          await this.sleep(this.RATE_LIMIT_MS);
        } catch {
          /* skip individual thread failures */
        }
      }

      pageToken = listData.nextPageToken;
      if (!pageToken) break;

      await this.sleep(this.RATE_LIMIT_MS);
    }

    // Sort by occurred_at descending
    events.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());

    const newCheckpoint: GmailCheckpoint = {
      last_sync_at: new Date().toISOString(),
    };

    return {
      events,
      checkpoint: newCheckpoint as Record<string, unknown>,
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

      switch (ctx.actionKey) {
        case 'send_email':
          return await this.sendEmail(token, ctx.input);
        case 'create_draft':
          return await this.createDraft(token, ctx.input);
        case 'reply':
          return await this.replyToThread(token, ctx.input);
        case 'search':
          return await this.searchEmails(token, ctx.input);
        case 'get_thread':
          return await this.getThread(token, ctx.input);
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
  // Actions
  // -------------------------------------------------------------------------

  private async sendEmail(token: string, input: Record<string, unknown>): Promise<ActionResult> {
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
    const response = await fetch(sendUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
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

  private async createDraft(token: string, input: Record<string, unknown>): Promise<ActionResult> {
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

    const response = await fetch(`${this.BASE_URL}/drafts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
    token: string,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const threadId = input.thread_id as string;
    const body = input.body as string;
    const cc = input.cc as string | undefined;

    if (!threadId || !body) {
      return { success: false, error: 'thread_id and body are required.' };
    }

    // Fetch the thread to get the last message's headers
    const threadRes = await this.apiGet(
      `${this.BASE_URL}/threads/${threadId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Message-ID`,
      token
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

    const response = await fetch(`${this.BASE_URL}/messages/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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

  private async searchEmails(token: string, input: Record<string, unknown>): Promise<ActionResult> {
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
    const listResponse = await this.apiGet(listUrl, token);

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
      const msgResponse = await this.apiGet(msgUrl, token);
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

  private async getThread(token: string, input: Record<string, unknown>): Promise<ActionResult> {
    const threadId = input.thread_id as string;

    if (!threadId) {
      return { success: false, error: 'thread_id is required.' };
    }

    const url = `${this.BASE_URL}/threads/${threadId}?format=full`;
    const response = await this.apiGet(url, token);

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

  private async apiGet(url: string, token: string): Promise<Response> {
    return fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
