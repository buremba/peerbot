import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let MicrosoftOutlookConnector: any;

beforeAll(async () => {
  MicrosoftOutlookConnector = (await import('../microsoft_outlook')).default;
});

// `folder` is free-form connection config interpolated into the Graph path, and
// Graph takes an opaque folder id there as well as a well-known name. Reserved
// characters must survive as one path segment: a raw '/' retargets the request.
const FOLDER_ID = 'AQMkAGI2/Ly8+Zm9sZGVy=';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function graphMessage(id: string) {
  return {
    id,
    conversationId: `conversation-${id}`,
    subject: `Subject ${id}`,
    bodyPreview: `Preview ${id}`,
    from: { emailAddress: { name: 'Sender', address: 'sender@example.com' } },
    toRecipients: [{ emailAddress: { name: 'Recipient', address: 'to@example.com' } }],
    ccRecipients: [],
    receivedDateTime: '2026-08-20T10:00:00Z',
    sentDateTime: '2026-08-20T09:59:00Z',
    hasAttachments: false,
    importance: 'normal',
    isRead: true,
    webLink: `https://outlook.office.com/mail/${id}`,
  };
}

function graphEvent(id: string) {
  return {
    id,
    subject: `Event ${id}`,
    bodyPreview: `Agenda ${id}`,
    organizer: { emailAddress: { name: 'Organizer', address: 'owner@example.com' } },
    attendees: [{ emailAddress: { name: 'Guest', address: 'guest@example.com' } }],
    start: { dateTime: '2026-08-28T10:00:00Z', timeZone: 'UTC' },
    end: { dateTime: '2026-08-28T11:00:00Z', timeZone: 'UTC' },
    location: { displayName: 'Room 1' },
    isAllDay: false,
    isCancelled: false,
    webLink: `https://outlook.office.com/calendar/${id}`,
    createdDateTime: '2026-08-01T10:00:00Z',
  };
}

describe('MicrosoftOutlookConnector runtime', () => {
  test('requires OAuth before issuing a Graph request', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Graph was called without credentials');
    }) as typeof fetch;

    const connector = new MicrosoftOutlookConnector();

    await expect(
      connector.sync({ feedKey: 'messages', config: {}, credentials: null, checkpoint: {} })
    ).rejects.toThrow('Microsoft Outlook requires OAuth authentication');
  });

  test('encodes an opaque mail-folder id and follows Graph next links up to max_results', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      urls.push(url);
      const page = urls.length === 1
        ? { value: [graphMessage('one')], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page' }
        : { value: [graphMessage('two'), graphMessage('three')] };
      return Response.json(page);
    }) as typeof fetch;

    const connector = new MicrosoftOutlookConnector();
    const result = await connector.sync({
      feedKey: 'messages',
      config: { folder: FOLDER_ID, max_results: 2, lookback_days: 30 },
      credentials: { accessToken: 'token' },
      checkpoint: {},
    });

    expect(new URL(urls[0]).pathname).toContain(
      '/mailFolders/AQMkAGI2%2FLy8%2BZm9sZGVy%3D/messages'
    );
    expect(urls[1]).toBe('https://graph.microsoft.com/v1.0/next-page');
    expect(result.events.map((event: { origin_id: string }) => event.origin_id)).toEqual([
      'outlook_msg_one',
      'outlook_msg_two',
    ]);
    expect(result.events[0]).toMatchObject({
      origin_type: 'email',
      author_name: 'Sender',
      metadata: { from: 'sender@example.com', to: 'Recipient', is_read: true },
    });
  });

  test('emits an origin_type the feed declares as an event kind', async () => {
    globalThis.fetch = (async () => Response.json({ value: [graphEvent('meeting')] })) as typeof fetch;

    const connector = new MicrosoftOutlookConnector();
    const result = await connector.sync({
      feedKey: 'calendar',
      config: { max_results: 10, lookback_days: 7, lookahead_days: 30 },
      credentials: { accessToken: 'token' },
      checkpoint: {},
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      origin_id: 'outlook_evt_meeting',
      origin_type: 'calendar_event',
      metadata: {
        organizer: 'owner@example.com',
        attendee_count: 1,
        start_time: '2026-08-28T10:00:00Z',
      },
    });
    expect(
      Object.keys(connector.definition.feeds.calendar.eventKinds)
    ).toContain(result.events[0].origin_type);
  });
});
