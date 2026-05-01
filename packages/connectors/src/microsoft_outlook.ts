/**
 * Microsoft Outlook Connector (V1 runtime)
 *
 * Syncs emails and calendar events from Microsoft 365 via the Microsoft Graph API.
 * Auth via OAuth with Microsoft identity platform.
 */

import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

// ---------------------------------------------------------------------------
// Microsoft Graph API types
// ---------------------------------------------------------------------------

interface GraphMessage {
  id: string;
  conversationId: string;
  subject: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  from: { emailAddress: { name: string; address: string } };
  toRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  ccRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  receivedDateTime: string;
  sentDateTime: string;
  hasAttachments: boolean;
  importance: string;
  isRead: boolean;
  webLink: string;
  parentFolderId: string;
}

interface GraphEvent {
  id: string;
  subject: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  organizer: { emailAddress: { name: string; address: string } };
  attendees: Array<{
    emailAddress: { name: string; address: string };
    type: string;
    status: { response: string };
  }>;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location: { displayName: string };
  isAllDay: boolean;
  isCancelled: boolean;
  webLink: string;
  createdDateTime: string;
}

interface GraphPagedResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

interface OutlookCheckpoint {
  last_sync_at?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRecipients(
  recipients: Array<{ emailAddress: { name: string; address: string } }>
): string {
  return recipients.map((r) => r.emailAddress.name || r.emailAddress.address).join(', ');
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class MicrosoftOutlookConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'microsoft.outlook',
    name: 'Microsoft Outlook',
    description: 'Syncs emails and calendar events from Microsoft 365 via Graph API.',
    version: '1.0.0',
    faviconDomain: 'outlook.com',
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'microsoft',
          requiredScopes: [
            'openid',
            'email',
            'profile',
            'offline_access',
            'Mail.Read',
            'Calendars.Read',
          ],
          optionalScopes: ['Mail.Send'],
          loginScopes: ['openid', 'email', 'profile', 'offline_access', 'User.Read'],
          clientIdKey: 'MICROSOFT_CLIENT_ID',
          clientSecretKey: 'MICROSOFT_CLIENT_SECRET',
          tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
          tokenEndpointAuthMethod: 'client_secret_post',
          loginProvisioning: {
            autoCreateConnection: true,
          },
          setupInstructions:
            'Register an app in the Azure Portal (Entra ID > App registrations). Add {{redirect_uri}} as a redirect URI under "Web", then copy the Application (client) ID and create a client secret under Certificates & secrets.',
        },
      ],
    },
    feeds: {
      messages: {
        key: 'messages',
        name: 'Messages',
        requiredScopes: ['Mail.Read'],
        description: 'Syncs email messages from Outlook.',
        configSchema: {
          type: 'object',
          properties: {
            folder: {
              type: 'string',
              default: 'inbox',
              description: 'Mail folder to sync (e.g. "inbox", "sentitems", "drafts").',
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 500,
              default: 50,
              description: 'Maximum messages to fetch per sync.',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 365,
              default: 30,
              description: 'How many days back to look on initial sync.',
            },
          },
        },
        eventKinds: {
          email: {
            description: 'An email message from Outlook',
            metadataSchema: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                cc: { type: 'string' },
                importance: { type: 'string' },
                has_attachments: { type: 'boolean' },
                is_read: { type: 'boolean' },
              },
            },
          },
        },
      },
      calendar: {
        key: 'calendar',
        name: 'Calendar Events',
        requiredScopes: ['Calendars.Read'],
        description: 'Syncs calendar events from Outlook.',
        configSchema: {
          type: 'object',
          properties: {
            lookback_days: {
              type: 'integer',
              minimum: 0,
              maximum: 365,
              default: 7,
              description: 'How many days back to look for events.',
            },
            lookahead_days: {
              type: 'integer',
              minimum: 1,
              maximum: 365,
              default: 30,
              description: 'How many days ahead to look for events.',
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 500,
              default: 100,
              description: 'Maximum events to fetch per sync.',
            },
          },
        },
        eventKinds: {
          calendar_event: {
            description: 'A calendar event from Outlook',
            metadataSchema: {
              type: 'object',
              properties: {
                organizer: { type: 'string' },
                location: { type: 'string' },
                attendee_count: { type: 'number' },
                is_all_day: { type: 'boolean' },
                is_cancelled: { type: 'boolean' },
                start_time: { type: 'string' },
                end_time: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };

  private readonly API_BASE = 'https://graph.microsoft.com/v1.0';
  private readonly PAGE_SIZE = 50;
  private readonly MAX_PAGES = 10;

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const accessToken = ctx.credentials?.accessToken;
    if (!accessToken) {
      throw new Error('Microsoft Outlook requires OAuth authentication.');
    }

    switch (ctx.feedKey) {
      case 'messages':
        return this.syncMessages(ctx, accessToken);
      case 'calendar':
        return this.syncCalendar(ctx, accessToken);
      default:
        throw new Error(`Unknown feed: ${ctx.feedKey}`);
    }
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: 'Actions not supported' };
  }

  // -------------------------------------------------------------------------
  // Feed: messages
  // -------------------------------------------------------------------------

  private async syncMessages(ctx: SyncContext, accessToken: string): Promise<SyncResult> {
    const config = ctx.config as Record<string, unknown>;
    const folder = (config.folder as string) ?? 'inbox';
    const maxResults = (config.max_results as number) ?? 50;
    const lookbackDays = (config.lookback_days as number) ?? 30;

    const since = new Date();
    since.setDate(since.getDate() - lookbackDays);
    const sinceFilter = since.toISOString();

    const events: EventEnvelope[] = [];
    let url =
      `${this.API_BASE}/me/mailFolders/${folder}/messages` +
      `?$top=${Math.min(maxResults, this.PAGE_SIZE)}` +
      '&$orderby=receivedDateTime desc' +
      `&$filter=receivedDateTime ge ${sinceFilter}` +
      '&$select=id,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,importance,isRead,webLink';

    let fetched = 0;

    for (let page = 0; page < this.MAX_PAGES && fetched < maxResults; page++) {
      const data = await this.graphGet<GraphPagedResponse<GraphMessage>>(url, accessToken);

      for (const msg of data.value) {
        if (fetched >= maxResults) break;
        events.push({
          origin_id: `outlook_msg_${msg.id}`,
          title: msg.subject,
          payload_text: msg.bodyPreview || msg.subject,
          author_name: msg.from?.emailAddress?.name || msg.from?.emailAddress?.address,
          source_url: msg.webLink,
          occurred_at: new Date(msg.receivedDateTime),
          origin_type: 'email',
          metadata: {
            from: msg.from?.emailAddress?.address,
            to: formatRecipients(msg.toRecipients ?? []),
            cc: formatRecipients(msg.ccRecipients ?? []),
            importance: msg.importance,
            has_attachments: msg.hasAttachments,
            is_read: msg.isRead,
          },
        });
        fetched++;
      }

      if (ctx.emitEvents) await ctx.emitEvents(events.splice(0));

      if (!data['@odata.nextLink'] || fetched >= maxResults) break;
      url = data['@odata.nextLink'];
    }

    return {
      events,
      checkpoint: {
        last_sync_at: new Date().toISOString(),
      } satisfies OutlookCheckpoint as Record<string, unknown>,
    };
  }

  // -------------------------------------------------------------------------
  // Feed: calendar
  // -------------------------------------------------------------------------

  private async syncCalendar(ctx: SyncContext, accessToken: string): Promise<SyncResult> {
    const config = ctx.config as Record<string, unknown>;
    const lookbackDays = (config.lookback_days as number) ?? 7;
    const lookaheadDays = (config.lookahead_days as number) ?? 30;
    const maxResults = (config.max_results as number) ?? 100;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - lookbackDays);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + lookaheadDays);

    const events: EventEnvelope[] = [];
    let url =
      `${this.API_BASE}/me/calendarView` +
      `?startDateTime=${startDate.toISOString()}` +
      `&endDateTime=${endDate.toISOString()}` +
      `&$top=${Math.min(maxResults, this.PAGE_SIZE)}` +
      '&$orderby=start/dateTime' +
      '&$select=id,subject,bodyPreview,organizer,attendees,start,end,location,isAllDay,isCancelled,webLink,createdDateTime';

    let fetched = 0;

    for (let page = 0; page < this.MAX_PAGES && fetched < maxResults; page++) {
      const data = await this.graphGet<GraphPagedResponse<GraphEvent>>(url, accessToken);

      for (const evt of data.value) {
        if (fetched >= maxResults) break;
        events.push({
          origin_id: `outlook_evt_${evt.id}`,
          title: evt.subject,
          payload_text: evt.bodyPreview || evt.subject,
          author_name: evt.organizer?.emailAddress?.name || evt.organizer?.emailAddress?.address,
          source_url: evt.webLink,
          occurred_at: new Date(evt.start.dateTime),
          origin_type: 'calendar_event',
          metadata: {
            organizer: evt.organizer?.emailAddress?.address,
            location: evt.location?.displayName,
            attendee_count: evt.attendees?.length ?? 0,
            is_all_day: evt.isAllDay,
            is_cancelled: evt.isCancelled,
            start_time: evt.start.dateTime,
            end_time: evt.end.dateTime,
          },
        });
        fetched++;
      }

      if (ctx.emitEvents) await ctx.emitEvents(events.splice(0));

      if (!data['@odata.nextLink'] || fetched >= maxResults) break;
      url = data['@odata.nextLink'];
    }

    return {
      events,
      checkpoint: {
        last_sync_at: new Date().toISOString(),
      } satisfies OutlookCheckpoint as Record<string, unknown>,
    };
  }

  // -------------------------------------------------------------------------
  // API helpers
  // -------------------------------------------------------------------------

  private async graphGet<T>(url: string, accessToken: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 401) {
      throw new Error('Microsoft access token expired or invalid.');
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      throw new Error(
        `Microsoft Graph rate limit exceeded. Retry after ${retryAfter ?? 'unknown'} seconds.`
      );
    }

    if (!response.ok) {
      throw new Error(`Microsoft Graph API error (${response.status}): ${await response.text()}`);
    }

    return response.json() as Promise<T>;
  }
}
