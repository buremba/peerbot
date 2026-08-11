/**
 * Google Calendar Connector (V1 runtime)
 *
 * Syncs calendar events from Google Calendar and supports creating
 * new events via the Calendar API v3.
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
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

// ---------------------------------------------------------------------------
// Calendar API types
// ---------------------------------------------------------------------------

interface CalendarEvent {
  id: string;
  status: string;
  htmlLink: string;
  summary?: string;
  description?: string;
  location?: string;
  creator?: { email?: string; displayName?: string };
  organizer?: { email?: string; displayName?: string };
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus?: string;
  }>;
  created: string;
  updated: string;
}

interface CalendarEventListResponse {
  kind: string;
  summary?: string;
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

interface CalendarCheckpoint {
  sync_token?: string;
  last_sync_at?: string;
}

interface CalendarConfig extends Record<string, unknown> {
  calendar_id?: string;
  query?: string;
  lookback_days?: number;
  lookahead_days?: number;
  max_results?: number;
}

const CALENDAR_EVENT_COLUMNS = [
  { name: 'id', type: 'text' },
  { name: 'summary', type: 'text' },
  { name: 'description', type: 'text' },
  { name: 'location', type: 'text' },
  { name: 'status', type: 'text' },
  { name: 'start_time', type: 'text' },
  { name: 'end_time', type: 'text' },
  { name: 'all_day', type: 'boolean' },
  { name: 'organizer', type: 'text' },
  { name: 'attendee_count', type: 'number' },
  { name: 'created_at', type: 'text' },
  { name: 'updated_at', type: 'text' },
  { name: 'url', type: 'text' },
] as const;

/**
 * Does this events.list failure mean "the syncToken itself is no longer
 * usable" (as opposed to "your credentials are wrong")?
 *
 * Two shapes qualify:
 *  - 410 GONE — Google's documented signal that an incremental sync token has
 *    expired or been invalidated.
 *  - 403 with `insufficientPermissions` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT` —
 *    a token minted under a *previous* grant. Google validates the syncToken
 *    against the grant that produced it, so re-authorizing the connection with
 *    the same scopes leaves the old token permanently rejected even though the
 *    live credentials are fine.
 *
 * In both cases the recovery is identical and is what Google documents: drop
 * the token and perform a full resync.
 *
 * A genuinely-missing scope produces the *same* 403 body, so this predicate
 * cannot distinguish them on its own — the caller resolves the ambiguity by
 * retrying exactly once without the token. If the scope really is missing the
 * full sync fails the same way and that error propagates, which is why the
 * retry is bounded to a single attempt and never becomes a resync loop.
 */
function isSyncTokenRejection(status: number, body: string): boolean {
  if (status === 410) return true;
  if (status !== 403) return false;
  return (
    body.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || body.includes('insufficientPermissions')
  );
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class GoogleCalendarConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'google.calendar',
    name: 'Google Calendar',
    description: 'Syncs calendar events from Google Calendar and supports creating new events.',
    version: '1.1.1',
    faviconDomain: 'calendar.google.com',
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'google',
          requiredScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
          optionalScopes: ['https://www.googleapis.com/auth/calendar.events'],
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
      events: {
        key: 'events',
        name: 'Events',
        requiredScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        description:
          'Live Google Calendar events (virtual by default); reads current state directly from Google without copying events into Lobu.',
        virtual: true,
        configSchema: {
          type: 'object',
          properties: {
            calendar_id: {
              type: 'string',
              default: 'primary',
              description: 'Calendar ID to read (default: "primary").',
            },
            query: {
              type: 'string',
              description: 'Optional Google Calendar free-text query applied to live reads.',
            },
            lookback_days: {
              type: 'integer', minimum: 1, maximum: 365, default: 30,
              description: 'Number of past days included in live reads.',
            },
            lookahead_days: {
              type: 'integer', minimum: 1, maximum: 730, default: 365,
              description: 'Number of future days included in live reads.',
            },
            max_results: {
              type: 'integer', minimum: 1, maximum: 2500, default: 100,
              description: 'Maximum events returned per live read.',
            },
          },
        },
        eventKinds: {
          calendar_event: {
            description: 'A Google Calendar event',
            metadataSchema: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                location: { type: 'string' },
                organizer: { type: 'string' },
                attendee_count: { type: 'number' },
                start_time: { type: 'string' },
                end_time: { type: 'string' },
                all_day: { type: 'boolean' },
              },
            },
          },
        },
      },
      changes: {
        key: 'changes',
        name: 'Calendar changes',
        requiredScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        description:
          'Durable incremental Google Calendar changes for Behaviors and event-driven workflows. Collected only when explicitly created.',
        configSchema: {
          type: 'object',
          properties: {
            calendar_id: {
              type: 'string',
              default: 'primary',
              description: 'Calendar ID to watch (default: "primary").',
            },
            lookback_days: {
              type: 'integer', minimum: 1, maximum: 365, default: 30,
              description: 'Number of days to look back on initial collection.',
            },
            max_results: {
              type: 'integer', minimum: 1, maximum: 2500, default: 100,
              description:
                'Maximum events to persist during initial collection; incremental collections persist every change.',
            },
          },
        },
        eventKinds: {
          calendar_event: {
            description: 'A Google Calendar event change',
            metadataSchema: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                location: { type: 'string' },
                organizer: { type: 'string' },
                attendee_count: { type: 'number' },
                start_time: { type: 'string' },
                end_time: { type: 'string' },
                all_day: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    actions: {
      create_event: {
        key: 'create_event',
        name: 'Create Event',
        description: 'Create a new event on Google Calendar.',
        requiresApproval: true,
        requiredScopes: ['https://www.googleapis.com/auth/calendar.events'],
        inputSchema: {
          type: 'object',
          required: ['summary', 'start', 'end'],
          properties: {
            summary: { type: 'string', description: 'Event title.' },
            start: { type: 'string', description: 'Start time (ISO 8601 datetime).' },
            end: { type: 'string', description: 'End time (ISO 8601 datetime).' },
            description: { type: 'string', description: 'Event description.' },
            location: { type: 'string', description: 'Event location.' },
            attendees: {
              type: 'string',
              description: 'Comma-separated attendee email addresses.',
            },
            calendar_id: {
              type: 'string',
              description: 'Calendar ID (default: "primary").',
            },
          },
        },
      },
      update_event: {
        key: 'update_event',
        name: 'Update Event',
        description: 'Update an existing calendar event.',
        requiresApproval: true,
        requiredScopes: ['https://www.googleapis.com/auth/calendar.events'],
        inputSchema: {
          type: 'object',
          required: ['event_id'],
          properties: {
            event_id: { type: 'string', description: 'Event ID to update.' },
            calendar_id: {
              type: 'string',
              description: 'Calendar ID (default: "primary").',
            },
            summary: { type: 'string', description: 'Event title.' },
            start: { type: 'string', description: 'Start time (ISO 8601 datetime).' },
            end: { type: 'string', description: 'End time (ISO 8601 datetime).' },
            description: { type: 'string', description: 'Event description.' },
            location: { type: 'string', description: 'Event location.' },
          },
        },
      },
      delete_event: {
        key: 'delete_event',
        name: 'Delete Event',
        description: 'Delete/cancel an event.',
        requiresApproval: true,
        requiredScopes: ['https://www.googleapis.com/auth/calendar.events'],
        inputSchema: {
          type: 'object',
          required: ['event_id'],
          properties: {
            event_id: { type: 'string', description: 'Event ID to delete.' },
            calendar_id: {
              type: 'string',
              description: 'Calendar ID (default: "primary").',
            },
          },
        },
      },
      get_event: {
        key: 'get_event',
        kind: 'read',
        requiresApproval: false,
        name: 'Get Event',
        description: 'Get full event details.',
        inputSchema: {
          type: 'object',
          required: ['event_id'],
          properties: {
            event_id: { type: 'string', description: 'Event ID to retrieve.' },
            calendar_id: {
              type: 'string',
              description: 'Calendar ID (default: "primary").',
            },
          },
        },
      },
    },
  };

  private readonly BASE_URL = 'https://www.googleapis.com/calendar/v3';

  // -------------------------------------------------------------------------
  // Live pushdown (virtual events feed) — current state, never persisted.
  // -------------------------------------------------------------------------

  async query(ctx: QueryContext<CalendarConfig>): Promise<QueryResult> {
    return this.liveRead(ctx, []);
  }

  async search(ctx: SearchContext<CalendarConfig>): Promise<QueryResult> {
    return this.liveRead(ctx, ctx.terms ?? []);
  }

  private async liveRead(
    ctx: QueryContext<CalendarConfig>,
    terms: string[]
  ): Promise<QueryResult> {
    const token = ctx.credentials?.accessToken;
    if (!token) {
      throw new Error('Google Calendar virtual-feed reads require Google OAuth credentials.');
    }
    if (ctx.feedKey && ctx.feedKey !== 'events') {
      throw new Error(
        "Google Calendar live queries are only supported for the virtual events feed; got '" +
          ctx.feedKey +
          "'."
      );
    }
    if (ctx.sort && !(ctx.sort.column === 'start_time' && ctx.sort.order === 'asc')) {
      throw new Error(
        "Google Calendar virtual feed only supports sort {column:'start_time', order:'asc'}."
      );
    }

    const calendarId = ctx.config.calendar_id || 'primary';
    const lookbackDays = ctx.config.lookback_days ?? 30;
    const lookaheadDays = ctx.config.lookahead_days ?? 365;
    const requestedLimit = Math.min(Math.max(Math.trunc(ctx.limit ?? 50), 1), 2500);
    const configuredLimit = Math.min(
      Math.max(Math.trunc(ctx.config.max_results ?? 100), 1),
      2500
    );
    const limit = Math.min(requestedLimit, configuredLimit);
    const offset = Math.max(Math.trunc(ctx.offset ?? 0), 0);
    const want = offset + limit;
    const maxReachable = 250 * 200;
    if (want > maxReachable) {
      throw new Error(
        'Google Calendar virtual feed offset+limit (' +
          want +
          ') exceeds max reachable depth ' +
          maxReachable +
          '. Narrow the query or lower offset.'
      );
    }

    const timeMin = new Date();
    timeMin.setDate(timeMin.getDate() - lookbackDays);
    const timeMax = new Date();
    timeMax.setDate(timeMax.getDate() + lookaheadDays);

    const baseQuery = (ctx.query || ctx.config.query || '').trim();
    const queryParts = [baseQuery, ...terms.map((term) => term.trim())].filter(Boolean);
    const q = queryParts.join(' ');
    const http = this.client(token);
    const rows: Record<string, unknown>[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    while (rows.length < want && pages < 200) {
      pages += 1;
      const params = new URLSearchParams({
        maxResults: String(Math.min(250, Math.max(1, want - rows.length))),
        orderBy: 'startTime',
        singleEvents: 'true',
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
      });
      if (q) params.set('q', q);
      if (pageToken) params.set('pageToken', pageToken);

      const url =
        this.BASE_URL +
        '/calendars/' +
        encodeURIComponent(calendarId) +
        '/events?' +
        params.toString();
      const response = await http.raw(url);
      if (!response.ok) {
        throw new Error(
          'Calendar events.list error (' + response.status + '): ' + (await response.text())
        );
      }
      const data = (await response.json()) as CalendarEventListResponse;
      for (const event of data.items ?? []) {
        const row = this.calendarEventToRow(event);
        if (row) rows.push(row);
      }
      if (!data.nextPageToken || (data.items ?? []).length === 0) break;
      pageToken = data.nextPageToken;
    }

    if (rows.length < want && pageToken && pages >= 200) {
      throw new Error(
        'Google Calendar virtual feed pagination depth cap hit before offset+limit (' +
          want +
          '). Narrow the query or lower offset.'
      );
    }

    return {
      rows: rows.slice(offset, offset + limit),
      columns: [...CALENDAR_EVENT_COLUMNS],
    };
  }

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const token = ctx.credentials?.accessToken;
    if (!token) {
      throw new Error('Google Calendar requires Google OAuth credentials.');
    }

    const http = this.client(token);
    const calendarId = (ctx.config.calendar_id as string) || 'primary';
    const maxResults = Math.min((ctx.config.max_results as number) ?? 100, 2500);
    const lookbackDays = (ctx.config.lookback_days as number) ?? 30;

    const checkpoint = (ctx.checkpoint ?? {}) as CalendarCheckpoint;
    const events: EventEnvelope[] = [];
    const durableChanges = ctx.feedKey === 'changes';

    // No cursor-version guard: v1.1.0 changes tokens (minted without
    // showDeleted) were retired by a one-time migration that cleared any
    // unversioned changes checkpoint. Hosted prod carried exactly one such feed
    // and it was already versioned, so the migration was a no-op. Self-hosted
    // installs upgrading from that release with a v1.1.0 changes token are out
    // of migration reach and may see Google reject the token under the current
    // query shape; their recovery is to clear the feed checkpoint.
    if (checkpoint.sync_token) {
      const result = await this.syncWithToken(
        http,
        calendarId,
        checkpoint.sync_token,
        maxResults,
        durableChanges
      );
      if (result) {
        return this.buildResult(result.events, result.nextSyncToken);
      }
      // The stored token was rejected (see isSyncTokenRejection). Fall through
      // to a full sync exactly once — no retry loop. The full sync below either
      // succeeds and overwrites the checkpoint with a token minted under the
      // current grant, or throws (the scope is genuinely missing) and the error
      // reaches the run record instead of being swallowed.
    }

    // Full sync
    const timeMin = new Date();
    timeMin.setDate(timeMin.getDate() - lookbackDays);
    const timeMax = new Date();
    timeMax.setDate(timeMax.getDate() + 365); // Include future events

    let nextSyncToken: string | undefined;

    // Safety bound — at 250 events/page, 200 pages = 50k events, more than
    // any reasonable calendar window. Stops a runaway loop if the upstream
    // ever returns a self-referential page token.
    const MAX_PAGES = 200;

    const pages = paginateByCursor<CalendarEvent, string>(
      async (pageToken) => {
        // Google permits timeMin on the initial full sync but forbids it with
        // syncToken. Other durable parameters remain stable across both paths.
        const params = durableChanges
          ? new URLSearchParams({
              maxResults: '250',
              singleEvents: 'true',
              showDeleted: 'true',
              timeMin: timeMin.toISOString(),
            })
          : new URLSearchParams({
              maxResults: '250',
              orderBy: 'startTime',
              singleEvents: 'true',
              timeMin: timeMin.toISOString(),
              timeMax: timeMax.toISOString(),
            });
        if (pageToken) {
          params.set('pageToken', pageToken);
        }

        const url = `${this.BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
        const response = await http.raw(url);

        if (!response.ok) {
          throw new Error(
            `Calendar events.list error (${response.status}): ${await response.text()}`
          );
        }

        const data = (await response.json()) as CalendarEventListResponse;
        // Google only returns nextSyncToken on the LAST page (no nextPageToken).
        // Capture it whenever present so the trailing value survives; the
        // generator keeps paging until nextPageToken is exhausted, otherwise the
        // sync token is never obtained and every subsequent sync re-runs the full
        // window from scratch.
        nextSyncToken = data.nextSyncToken;
        return { items: data.items ?? [], nextCursor: data.nextPageToken };
      },
      { maxPages: MAX_PAGES }
    );

    // Keep paginating past `maxResults`, just stop appending events once the cap
    // is reached, so the trailing nextSyncToken is still captured.
    for await (const items of pages) {
      for (const calEvent of items) {
        if (events.length >= maxResults) break;
        const envelope = durableChanges
          ? this.calendarEventToChangeEnvelope(calEvent)
          : this.calendarEventToEnvelope(calEvent);
        if (envelope) events.push(envelope);
      }
    }

    if (durableChanges && !nextSyncToken) {
      throw new Error(
        'Google Calendar changes traversal completed without a durable sync token.'
      );
    }

    return this.buildResult(events, nextSyncToken);
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------

  async execute(ctx: ActionContext): Promise<ActionResult> {
    try {
      const token = ctx.credentials?.accessToken;
      if (!token) {
        return {
          success: false,
          error: 'Google Calendar actions require Google OAuth credentials.',
        };
      }

      const http = this.client(token);

      switch (ctx.actionKey) {
        case 'create_event':
          return await this.createEvent(http, ctx.input);
        case 'update_event':
          return await this.updateEvent(http, ctx.input);
        case 'delete_event':
          return await this.deleteEvent(http, ctx.input);
        case 'get_event':
          return await this.getEvent(http, ctx.input);
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
  // Incremental sync
  // -------------------------------------------------------------------------

  private async syncWithToken(
    http: HttpClient,
    calendarId: string,
    syncToken: string,
    maxResults: number,
    durableChanges: boolean
  ): Promise<{ events: EventEnvelope[]; nextSyncToken?: string } | null> {
    const events: EventEnvelope[] = [];
    let nextSyncToken: string | undefined;
    // The stored syncToken was rejected (410 expired, or 403 because it was
    // minted under a superseded grant) — abort and let the caller drop it and
    // fall through to a full sync. Signalled out of the generator via this flag.
    let syncTokenRejected = false;

    // Same hard ceiling as the full-sync path — defensive only.
    const MAX_PAGES = 200;

    const pages = paginateByCursor<CalendarEvent, string>(
      async (pageToken) => {
        // Consume every incremental change before advancing the durable token;
        // max_results limits only the historical bootstrap.
        const params = durableChanges
          ? new URLSearchParams({
              maxResults: '250',
              syncToken,
              singleEvents: 'true',
              showDeleted: 'true',
            })
          : new URLSearchParams({
              maxResults: String(Math.max(1, Math.min(250, maxResults - events.length))),
              syncToken,
            });
        if (pageToken) {
          params.set('pageToken', pageToken);
        }

        const url = `${this.BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
        const response = await http.raw(url);

        if (!response.ok) {
          const body = await response.text();
          if (isSyncTokenRejection(response.status, body)) {
            syncTokenRejected = true;
            return { items: [], nextCursor: undefined };
          }
          throw new Error(`Calendar events.list error (${response.status}): ${body}`);
        }

        const data = (await response.json()) as CalendarEventListResponse;
        // Capture the trailing nextSyncToken; generator pages until exhausted.
        nextSyncToken = data.nextSyncToken;
        return { items: data.items ?? [], nextCursor: data.nextPageToken };
      },
      { maxPages: MAX_PAGES }
    );

    for await (const items of pages) {
      for (const calEvent of items) {
        const envelope = durableChanges
          ? this.calendarEventToChangeEnvelope(calEvent)
          : this.calendarEventToEnvelope(calEvent);
        if (envelope) events.push(envelope);
      }
    }

    if (syncTokenRejected) return null;
    if (durableChanges && !nextSyncToken) {
      throw new Error(
        'Google Calendar incremental changes traversal completed without a durable sync token.'
      );
    }

    return { events, nextSyncToken };
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async createEvent(http: HttpClient, input: Record<string, unknown>): Promise<ActionResult> {
    const summary = input.summary as string;
    const start = input.start as string;
    const end = input.end as string;
    const description = input.description as string | undefined;
    const location = input.location as string | undefined;
    const attendeesStr = input.attendees as string | undefined;
    const calendarId = (input.calendar_id as string) || 'primary';

    if (!summary || !start || !end) {
      return { success: false, error: 'summary, start, and end are required.' };
    }

    const eventBody: Record<string, unknown> = {
      summary,
      start: { dateTime: start },
      end: { dateTime: end },
    };

    if (description) eventBody.description = description;
    if (location) eventBody.location = location;

    if (attendeesStr) {
      const attendees = attendeesStr
        .split(',')
        .map((email) => email.trim())
        .filter((email) => email.length > 0)
        .map((email) => ({ email }));
      if (attendees.length > 0) {
        eventBody.attendees = attendees;
      }
    }

    const url = `${this.BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events`;
    const response = await http.raw(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Calendar create error (${response.status}): ${errText}` };
    }

    const created = (await response.json()) as CalendarEvent;

    return {
      success: true,
      output: {
        event_id: created.id,
        html_link: created.htmlLink,
        summary: created.summary,
        start: created.start.dateTime || created.start.date,
        end: created.end.dateTime || created.end.date,
      },
    };
  }

  private async updateEvent(http: HttpClient, input: Record<string, unknown>): Promise<ActionResult> {
    const eventId = input.event_id as string;
    const calendarId = (input.calendar_id as string) || 'primary';

    if (!eventId) {
      return { success: false, error: 'event_id is required.' };
    }

    const patch: Record<string, unknown> = {};
    if (input.summary !== undefined) patch.summary = input.summary;
    if (input.description !== undefined) patch.description = input.description;
    if (input.location !== undefined) patch.location = input.location;
    if (input.start !== undefined) patch.start = { dateTime: input.start as string };
    if (input.end !== undefined) patch.end = { dateTime: input.end as string };

    const url = `${this.BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const response = await http.raw(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Calendar update error (${response.status}): ${errText}` };
    }

    const updated = (await response.json()) as CalendarEvent;

    return {
      success: true,
      output: {
        event_id: updated.id,
        url: updated.htmlLink,
        summary: updated.summary,
      },
    };
  }

  private async deleteEvent(http: HttpClient, input: Record<string, unknown>): Promise<ActionResult> {
    const eventId = input.event_id as string;
    const calendarId = (input.calendar_id as string) || 'primary';

    if (!eventId) {
      return { success: false, error: 'event_id is required.' };
    }

    const url = `${this.BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const response = await http.raw(url, { method: 'DELETE' });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Calendar delete error (${response.status}): ${errText}` };
    }

    return {
      success: true,
      output: { deleted: true, event_id: eventId },
    };
  }

  private async getEvent(http: HttpClient, input: Record<string, unknown>): Promise<ActionResult> {
    const eventId = input.event_id as string;
    const calendarId = (input.calendar_id as string) || 'primary';

    if (!eventId) {
      return { success: false, error: 'event_id is required.' };
    }

    const url = `${this.BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const response = await http.raw(url);

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Calendar get error (${response.status}): ${errText}` };
    }

    const event = (await response.json()) as CalendarEvent;

    return {
      success: true,
      output: {
        event_id: event.id,
        summary: event.summary,
        start: event.start.dateTime || event.start.date,
        end: event.end.dateTime || event.end.date,
        description: event.description,
        location: event.location,
        attendees: event.attendees?.map((a) => ({
          email: a.email,
          name: a.displayName,
          status: a.responseStatus,
        })),
        organizer: event.organizer
          ? { email: event.organizer.email, name: event.organizer.displayName }
          : undefined,
        url: event.htmlLink,
        status: event.status,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private calendarEventToRow(calEvent: CalendarEvent): Record<string, unknown> | null {
    if (calEvent.status === 'cancelled') return null;
    const startTime = calEvent.start.dateTime || calEvent.start.date;
    if (!startTime) return null;
    const endTime = calEvent.end.dateTime || calEvent.end.date || '';
    return {
      id: calEvent.id,
      summary: calEvent.summary || '(no title)',
      description: calEvent.description || '',
      location: calEvent.location || '',
      status: calEvent.status,
      start_time: startTime,
      end_time: endTime,
      all_day: !calEvent.start.dateTime,
      organizer: calEvent.organizer?.displayName || calEvent.organizer?.email || '',
      attendee_count: calEvent.attendees?.length ?? 0,
      created_at: calEvent.created,
      updated_at: calEvent.updated,
      url: calEvent.htmlLink,
    };
  }

  private calendarEventToChangeEnvelope(calEvent: CalendarEvent): EventEnvelope {
    const startTime = calEvent.start?.dateTime || calEvent.start?.date;
    const endTime = calEvent.end?.dateTime || calEvent.end?.date;
    const changedAt = new Date(calEvent.updated || startTime || Date.now());
    const occurredAt = Number.isNaN(changedAt.getTime()) ? new Date() : changedAt;
    const isCancelled = calEvent.status === 'cancelled';

    const parts: string[] = [];
    if (calEvent.description) {
      parts.push(calEvent.description);
    }
    if (calEvent.attendees && calEvent.attendees.length > 0) {
      const attendeeList = calEvent.attendees.map((a) => a.displayName || a.email).join(', ');
      parts.push(`Attendees: ${attendeeList}`);
    }

    return {
      origin_id: calEvent.id,
      title: calEvent.summary || (isCancelled ? '(cancelled calendar event)' : '(no title)'),
      payload_text: parts.join('\n\n'),
      author_name: calEvent.organizer?.displayName || calEvent.organizer?.email,
      source_url: calEvent.htmlLink,
      occurred_at: occurredAt,
      origin_type: 'calendar_event',
      metadata: {
        status: calEvent.status,
        change_type: isCancelled ? 'cancelled' : 'upserted',
        ...(calEvent.location ? { location: calEvent.location } : {}),
        ...(calEvent.organizer?.email ? { organizer: calEvent.organizer.email } : {}),
        attendee_count: calEvent.attendees?.length ?? 0,
        ...(startTime ? { start_time: startTime } : {}),
        ...(endTime ? { end_time: endTime } : {}),
        all_day: Boolean(startTime && !calEvent.start?.dateTime),
      },
    };
  }

  private calendarEventToEnvelope(calEvent: CalendarEvent): EventEnvelope | null {
    if (calEvent.status === 'cancelled') return null;

    const startTime = calEvent.start.dateTime || calEvent.start.date;
    if (!startTime) return null;

    const occurredAt = new Date(startTime);
    if (Number.isNaN(occurredAt.getTime())) return null;

    const isAllDay = !calEvent.start.dateTime;
    const endTime = calEvent.end.dateTime || calEvent.end.date;

    // Build payload text from description + attendees
    const parts: string[] = [];
    if (calEvent.description) {
      parts.push(calEvent.description);
    }
    if (calEvent.attendees && calEvent.attendees.length > 0) {
      const attendeeList = calEvent.attendees.map((a) => a.displayName || a.email).join(', ');
      parts.push(`Attendees: ${attendeeList}`);
    }

    return {
      origin_id: calEvent.id,
      title: calEvent.summary || '(no title)',
      payload_text: parts.join('\n\n'),
      author_name: calEvent.organizer?.displayName || calEvent.organizer?.email,
      source_url: calEvent.htmlLink,
      occurred_at: occurredAt,
      origin_type: 'calendar_event',
      metadata: {
        status: calEvent.status,
        ...(calEvent.location ? { location: calEvent.location } : {}),
        ...(calEvent.organizer?.email ? { organizer: calEvent.organizer.email } : {}),
        attendee_count: calEvent.attendees?.length ?? 0,
        start_time: startTime,
        ...(endTime ? { end_time: endTime } : {}),
        all_day: isAllDay,
      },
    };
  }

  private buildResult(
    events: EventEnvelope[],
    syncToken: string | undefined
  ): SyncResult {
    // Sort events by occurred_at descending
    events.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());

    // Built fresh rather than spread over the previous checkpoint: the whole
    // object replaces the stored one, so a run that recovered from a rejected
    // token cannot leave that token behind. When the sync produced no new token
    // the key is absent, and the next run correctly starts from a full sync.
    const newCheckpoint: CalendarCheckpoint = {
      ...(syncToken ? { sync_token: syncToken } : {}),
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

  // Auth-aware client (Bearer + retry/backoff on transient 429/5xx). Built per
  // token so each sync/action uses its own credentials. `.raw()` preserves the
  // existing `response.ok`/status-code branching (e.g. sync-token rejection).
  private client(token: string): HttpClient {
    return createHttpClient({ token, errorPrefix: 'Calendar API' });
  }
}
