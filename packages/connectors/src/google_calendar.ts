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

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class GoogleCalendarConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'google.calendar',
    name: 'Google Calendar',
    description: 'Syncs calendar events from Google Calendar and supports creating new events.',
    version: '1.0.0',
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
        description: 'Syncs calendar events from Google Calendar.',
        configSchema: {
          type: 'object',
          properties: {
            calendar_id: {
              type: 'string',
              default: 'primary',
              description: 'Calendar ID to sync (default: "primary").',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 365,
              default: 30,
              description: 'Number of days to look back on initial sync.',
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 2500,
              default: 100,
              description: 'Maximum events to fetch per sync.',
            },
          },
        },
        eventKinds: {
          event: {
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
    },
    actions: {
      create_event: {
        key: 'create_event',
        name: 'Create Event',
        description: 'Create a new event on Google Calendar.',
        requiresApproval: true,
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

    // Try incremental sync with syncToken first
    if (checkpoint.sync_token) {
      const result = await this.syncWithToken(http, calendarId, checkpoint.sync_token, maxResults);
      if (result) {
        return this.buildResult(result.events, result.nextSyncToken, result.events.length);
      }
      // syncToken invalid (410) -- fall through to full sync
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
        // Always request a full page — `maxResults` is a soft cap on *stored*
        // events, not a reason to shrink the request size (shrinking to 1 once
        // the cap is hit would crawl a busy calendar one event per round-trip).
        const params = new URLSearchParams({
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
        const envelope = this.calendarEventToEnvelope(calEvent);
        if (envelope) events.push(envelope);
      }
    }

    return this.buildResult(events, nextSyncToken, events.length);
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
    maxResults: number
  ): Promise<{ events: EventEnvelope[]; nextSyncToken?: string } | null> {
    const events: EventEnvelope[] = [];
    let nextSyncToken: string | undefined;
    // 410 Gone means the syncToken is expired — abort and let the caller fall
    // through to a full sync. Signalled out of the generator via this flag.
    let syncTokenExpired = false;

    // Same hard ceiling as the full-sync path — defensive only.
    const MAX_PAGES = 200;

    const pages = paginateByCursor<CalendarEvent, string>(
      async (pageToken) => {
        const params = new URLSearchParams({
          // Page size shrinks toward the remaining cap as events accumulate,
          // matching the original dynamic sizing.
          maxResults: String(Math.max(1, Math.min(250, maxResults - events.length))),
          syncToken,
        });
        if (pageToken) {
          params.set('pageToken', pageToken);
        }

        const url = `${this.BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
        const response = await http.raw(url);

        if (response.status === 410) {
          syncTokenExpired = true;
          return { items: [], nextCursor: undefined };
        }

        if (!response.ok) {
          throw new Error(
            `Calendar events.list error (${response.status}): ${await response.text()}`
          );
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
        const envelope = this.calendarEventToEnvelope(calEvent);
        if (envelope) events.push(envelope);
      }
    }

    if (syncTokenExpired) return null;

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
      origin_type: 'event',
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
    syncToken: string | undefined,
    itemsFound: number
  ): SyncResult {
    // Sort events by occurred_at descending
    events.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());

    const newCheckpoint: CalendarCheckpoint = {
      ...(syncToken ? { sync_token: syncToken } : {}),
      last_sync_at: new Date().toISOString(),
    };

    return {
      events,
      checkpoint: newCheckpoint as Record<string, unknown>,
      metadata: {
        items_found: itemsFound,
      },
    };
  }

  // Auth-aware client (Bearer + retry/backoff on transient 429/5xx). Built per
  // token so each sync/action uses its own credentials. `.raw()` preserves the
  // existing `response.ok`/status-code branching (e.g. 410 sync-token expiry).
  private client(token: string): HttpClient {
    return createHttpClient({ token, errorPrefix: 'Calendar API' });
  }
}
