import { beforeAll, describe, expect, mock, test } from 'bun:test';
// The connector drives both sync loops through the cursor paginator; the shared
// mock provides a faithful real generator (not a throwing stub), so this
// exercises the genuine paging semantics while keeping the browser stack out.
import { connectorSdkMock } from './connector-sdk.mock';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let GoogleCalendarConnector: any;

beforeAll(async () => {
  const mod = await import('../google_calendar');
  GoogleCalendarConnector = mod.default;
});

interface CalPage {
  status?: number;
  items?: Array<Record<string, unknown>>;
  nextPageToken?: string;
  nextSyncToken?: string;
}

/** Fake http client whose `raw()` serves a queue of events.list pages. */
function fakeHttp(pages: CalPage[]) {
  const calls: Array<string | null> = [];
  const urls: string[] = [];
  let i = 0;
  return {
    calls,
    urls,
    client: {
      raw: async (url: string) => {
        urls.push(url);
        const u = new URL(url);
        calls.push(u.searchParams.get('pageToken'));
        const page = pages[i++] ?? { items: [] };
        const status = page.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => ({
            kind: 'calendar#events',
            items: page.items ?? [],
            nextPageToken: page.nextPageToken,
            nextSyncToken: page.nextSyncToken,
          }),
          text: async () => 'err',
        } as unknown as Response;
      },
    },
  };
}

function calEvent(id: string, startIso: string) {
  return {
    id,
    status: 'confirmed',
    htmlLink: `https://cal/${id}`,
    summary: id,
    start: { dateTime: startIso },
    end: { dateTime: startIso },
    created: startIso,
    updated: startIso,
  };
}

describe('GoogleCalendarConnector full sync', () => {
  test('captures nextSyncToken from the LAST page and pages until tokens exhaust', async () => {
    const connector = new GoogleCalendarConnector();
    const { client, calls } = fakeHttp([
      { items: [calEvent('a', '2026-01-01T10:00:00Z')], nextPageToken: 'p2' },
      // last page: no nextPageToken, but carries the nextSyncToken.
      { items: [calEvent('b', '2026-01-02T10:00:00Z')], nextSyncToken: 'SYNC_TOKEN' },
    ]);
    connector.client = () => client;

    const result = await connector.sync({
      config: { calendar_id: 'primary', max_results: 100 },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    expect(result.events).toHaveLength(2);
    expect(result.checkpoint.sync_token).toBe('SYNC_TOKEN');
    expect(calls).toEqual([null, 'p2']);
  });

  test('keeps paginating past max_results to reach the trailing sync token, but stops appending', async () => {
    const connector = new GoogleCalendarConnector();
    const { client } = fakeHttp([
      { items: [calEvent('a', '2026-01-01T10:00:00Z')], nextPageToken: 'p2' },
      { items: [calEvent('b', '2026-01-02T10:00:00Z')], nextSyncToken: 'SYNC2' },
    ]);
    connector.client = () => client;

    const result = await connector.sync({
      config: { calendar_id: 'primary', max_results: 1 }, // cap at 1 stored event
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    // Only 1 event stored (cap), but the second page was still fetched so the
    // trailing sync token is captured.
    expect(result.events).toHaveLength(1);
    expect(result.checkpoint.sync_token).toBe('SYNC2');
  });
});

/**
 * Drives an incremental-then-full sync where the first (incremental) request
 * fails with `status`/`body`, and every later request is a healthy full-sync
 * page. Returns the recorded query params so the test can assert the poisoned
 * token was dropped rather than replayed.
 */
function rejectingTokenHttp(status: number, body: string) {
  const calls: Array<Record<string, string | null>> = [];
  let call = 0;
  return {
    calls,
    client: {
      raw: async (url: string) => {
        const u = new URL(url);
        calls.push({
          syncToken: u.searchParams.get('syncToken'),
          pageToken: u.searchParams.get('pageToken'),
          timeMin: u.searchParams.get('timeMin'),
        });
        call++;
        if (call === 1) {
          return {
            ok: false,
            status,
            json: async () => JSON.parse(body),
            text: async () => body,
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            kind: 'calendar#events',
            items: [calEvent('full-1', '2026-02-01T10:00:00Z')],
            nextSyncToken: 'FRESH',
          }),
          text: async () => '',
        } as unknown as Response;
      },
    },
  };
}

/** The exact body prod returns for a syncToken minted under a stale grant. */
const SCOPE_REJECTION_BODY = JSON.stringify({
  error: {
    code: 403,
    message: 'Request had insufficient authentication scopes.',
    status: 'PERMISSION_DENIED',
    errors: [{ reason: 'insufficientPermissions' }],
    details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
  },
});

describe('GoogleCalendarConnector event kind', () => {
  test('emits the calendar_event kind shared with the other calendar connectors', async () => {
    const connector = new GoogleCalendarConnector();
    const { client } = fakeHttp([
      { items: [calEvent('a', '2026-01-01T10:00:00Z')], nextSyncToken: 'S' },
    ]);
    connector.client = () => client;

    const result = await connector.sync({
      config: { calendar_id: 'primary', max_results: 100 },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    // `calendar_event` is the vocabulary microsoft_outlook and apple.calendar
    // already emit. A connector-specific synonym here is invisible to any
    // consumer that filters on the shared kind.
    expect(result.events[0].origin_type).toBe('calendar_event');
  });

  test('every emitted origin_type is declared in the feed eventKinds registry', async () => {
    const connector = new GoogleCalendarConnector();
    const { client } = fakeHttp([
      { items: [calEvent('a', '2026-01-01T10:00:00Z')], nextSyncToken: 'S' },
    ]);
    connector.client = () => client;

    const result = await connector.sync({
      config: { calendar_id: 'primary', max_results: 100 },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    // `event_kinds` is a CLOSED allowlist once non-empty: the server rejects a
    // write whose semantic_type is absent from feeds_schema[feed].eventKinds.
    // Renaming one side without the other silently stops ingestion, so pin
    // both to each other here.
    const declared = Object.keys(connector.definition.feeds.events.eventKinds);
    expect(declared).toContain('calendar_event');
    for (const event of result.events) {
      expect(declared).toContain(event.origin_type);
    }
  });
});

describe('GoogleCalendarConnector poisoned sync token recovery', () => {
  test('a 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT on the incremental request drops the token and full-syncs', async () => {
    const connector = new GoogleCalendarConnector();
    const { client, calls } = rejectingTokenHttp(403, SCOPE_REJECTION_BODY);
    connector.client = () => client;

    const result = await connector.sync({
      config: { calendar_id: 'primary', max_results: 100 },
      credentials: { accessToken: 'tok' },
      checkpoint: { sync_token: 'POISONED' },
    });

    // The poisoned token was tried once...
    expect(calls[0]?.syncToken).toBe('POISONED');
    // ...then abandoned: the next request is a full sync (windowed by timeMin,
    // carrying no syncToken at all).
    expect(calls[1]?.syncToken).toBeNull();
    expect(calls[1]?.timeMin).toBeTruthy();

    // Recovery produced real events and a fresh checkpoint that no longer
    // carries the poisoned token.
    expect(result.events).toHaveLength(1);
    expect(result.checkpoint.sync_token).toBe('FRESH');
  });

  test('a genuinely missing scope still fails loudly instead of looping full syncs', async () => {
    const connector = new GoogleCalendarConnector();
    // Both the incremental AND the full-sync retry are rejected — the signature
    // of a scope the user never granted. Recovery must not mask this.
    connector.client = () => ({
      raw: async () =>
        ({
          ok: false,
          status: 403,
          json: async () => JSON.parse(SCOPE_REJECTION_BODY),
          text: async () => SCOPE_REJECTION_BODY,
        }) as unknown as Response,
    });

    await expect(
      connector.sync({
        config: { calendar_id: 'primary', max_results: 100 },
        credentials: { accessToken: 'tok' },
        checkpoint: { sync_token: 'POISONED' },
      })
    ).rejects.toThrow(/insufficient authentication scopes/);
  });

  test('an unrelated 403 is not treated as a poisoned token', async () => {
    const connector = new GoogleCalendarConnector();
    const forbidden = JSON.stringify({
      error: { code: 403, message: 'Daily Limit Exceeded', status: 'PERMISSION_DENIED' },
    });
    const { client, calls } = rejectingTokenHttp(403, forbidden);
    connector.client = () => client;

    await expect(
      connector.sync({
        config: { calendar_id: 'primary', max_results: 100 },
        credentials: { accessToken: 'tok' },
        checkpoint: { sync_token: 'GOOD' },
      })
    ).rejects.toThrow(/Daily Limit Exceeded/);

    // Only the incremental attempt ran — no full-sync fallback was triggered.
    expect(calls).toHaveLength(1);
  });
});

describe('GoogleCalendarConnector incremental sync', () => {
  test('an expired syncToken (410) falls through to a full sync', async () => {
    const connector = new GoogleCalendarConnector();
    // First raw() call (incremental, has syncToken) returns 410; subsequent
    // calls are the full-sync path and succeed.
    let call = 0;
    const calls: Array<Record<string, string | null>> = [];
    connector.client = () => ({
      raw: async (url: string) => {
        const u = new URL(url);
        calls.push({
          syncToken: u.searchParams.get('syncToken'),
          pageToken: u.searchParams.get('pageToken'),
        });
        call++;
        if (call === 1) {
          return { ok: false, status: 410, json: async () => ({}), text: async () => 'gone' } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            kind: 'calendar#events',
            items: [calEvent('full-1', '2026-02-01T10:00:00Z')],
            nextSyncToken: 'FRESH',
          }),
          text: async () => '',
        } as unknown as Response;
      },
    });

    const result = await connector.sync({
      config: { calendar_id: 'primary', max_results: 100 },
      credentials: { accessToken: 'tok' },
      checkpoint: { sync_token: 'STALE' },
    });

    // Incremental attempt used the stale token; full sync recovered events + a
    // fresh sync token.
    expect(calls[0]?.syncToken).toBe('STALE');
    expect(result.events).toHaveLength(1);
    expect(result.checkpoint.sync_token).toBe('FRESH');
  });
});

describe('GoogleCalendarConnector virtual events feed', () => {
  test('events is virtual by default while changes remains collected', () => {
    const connector = new GoogleCalendarConnector();
    expect(connector.definition.version).toBe('1.1.1');
    expect(connector.definition.feeds.events.virtual).toBe(true);
    expect(connector.definition.feeds.changes.virtual ?? false).toBe(false);
    expect(Object.keys(connector.definition.feeds.changes.eventKinds)).toContain('calendar_event');
  });

  test('query reads live state with Calendar-native time window, q, pagination and offset', async () => {
    const connector = new GoogleCalendarConnector();
    const { client, calls, urls } = fakeHttp([
      {
        items: [
          calEvent('a', '2026-01-01T10:00:00Z'),
          calEvent('b', '2026-01-02T10:00:00Z'),
        ],
        nextPageToken: 'p2',
      },
      { items: [calEvent('c', '2026-01-03T10:00:00Z')] },
    ]);
    connector.client = () => client;

    const result = await connector.query({
      feedKey: 'events',
      query: 'project alpha',
      config: {
        calendar_id: 'team@example.com',
        lookback_days: 7,
        lookahead_days: 14,
        max_results: 10,
      },
      credentials: { accessToken: 'tok' },
      limit: 2,
      offset: 1,
      sort: { column: 'start_time', order: 'asc' },
    });

    expect(result.rows.map((row: Record<string, unknown>) => row.id)).toEqual(['b', 'c']);
    expect(calls).toEqual([null, 'p2']);
    const first = new URL(urls[0]);
    expect(first.pathname).toContain('/calendars/team%40example.com/events');
    expect(first.searchParams.get('q')).toBe('project alpha');
    expect(first.searchParams.get('singleEvents')).toBe('true');
    expect(first.searchParams.get('orderBy')).toBe('startTime');
    expect(first.searchParams.get('timeMin')).toBeTruthy();
    expect(first.searchParams.get('timeMax')).toBeTruthy();
  });

  test('search composes the stored feed query with recall terms', async () => {
    const connector = new GoogleCalendarConnector();
    const { client, urls } = fakeHttp([{ items: [calEvent('a', '2026-01-01T10:00:00Z')] }]);
    connector.client = () => client;

    await connector.search({
      feedKey: 'events',
      terms: ['alice', 'design'],
      config: { query: 'team', max_results: 10 },
      credentials: { accessToken: 'tok' },
      limit: 5,
      offset: 0,
    });

    expect(new URL(urls[0]).searchParams.get('q')).toBe('team alice design');
  });
});


describe('GoogleCalendarConnector durable changes feed', () => {
  test('initial traversal uses sync-compatible parameters, captures cursor, and preserves cancellations', async () => {
    const connector = new GoogleCalendarConnector();
    const changedAt = '2026-08-10T00:12:34.000Z';
    const cancelled = {
      ...calEvent('cancelled-1', '2026-08-12T10:00:00Z'),
      status: 'cancelled',
      summary: undefined,
      updated: changedAt,
    };
    const { client, urls } = fakeHttp([{ items: [cancelled], nextSyncToken: 'NEXT' }]);
    connector.client = () => client;

    const result = await connector.sync({
      feedKey: 'changes',
      config: { calendar_id: 'primary', max_results: 100, lookback_days: 30 },
      credentials: { accessToken: 'tok' },
      checkpoint: null,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.origin_id).toBe('cancelled-1');
    expect(result.events[0]?.occurred_at.toISOString()).toBe(changedAt);
    expect(result.events[0]?.metadata?.status).toBe('cancelled');
    expect(result.events[0]?.metadata?.change_type).toBe('cancelled');
    expect(result.checkpoint.sync_token).toBe('NEXT');

    const first = new URL(urls[0]);
    expect(first.searchParams.get('singleEvents')).toBe('true');
    expect(first.searchParams.get('showDeleted')).toBe('true');
    expect(first.searchParams.get('orderBy')).toBeNull();
    expect(first.searchParams.get('timeMin')).toBeNull();
    expect(first.searchParams.get('timeMax')).toBeNull();
    expect(first.searchParams.get('syncToken')).toBeNull();
  });

  test('incremental traversal keeps sync-compatible parameters and never drops changes before advancing the token', async () => {
    const connector = new GoogleCalendarConnector();
    const { client, urls } = fakeHttp([
      {
        items: [
          calEvent('changed-1', '2026-08-10T10:00:00Z'),
          calEvent('changed-2', '2026-08-11T10:00:00Z'),
        ],
        nextSyncToken: 'FRESH',
      },
    ]);
    connector.client = () => client;

    const result = await connector.sync({
      feedKey: 'changes',
      config: { calendar_id: 'primary', max_results: 1 },
      credentials: { accessToken: 'tok' },
      checkpoint: { sync_token: 'OLD' },
    });

    // max_results bounds only the historical bootstrap. Once a sync token
    // exists, every returned change must be persisted before advancing it.
    expect(
      result.events.map((event: { origin_id: string }) => event.origin_id).sort()
    ).toEqual(['changed-1', 'changed-2']);
    expect(result.checkpoint.sync_token).toBe('FRESH');

    const first = new URL(urls[0]);
    expect(first.searchParams.get('syncToken')).toBe('OLD');
    expect(first.searchParams.get('singleEvents')).toBe('true');
    expect(first.searchParams.get('showDeleted')).toBe('true');
    expect(first.searchParams.get('orderBy')).toBeNull();
    expect(first.searchParams.get('timeMin')).toBeNull();
    expect(first.searchParams.get('timeMax')).toBeNull();
    expect(first.searchParams.get('maxResults')).toBe('250');
  });

  test('fails closed when a changes traversal completes without a durable sync token', async () => {
    const connector = new GoogleCalendarConnector();
    const { client } = fakeHttp([{ items: [calEvent('a', '2026-08-10T10:00:00Z')] }]);
    connector.client = () => client;

    await expect(
      connector.sync({
        feedKey: 'changes',
        config: { calendar_id: 'primary', max_results: 100 },
        credentials: { accessToken: 'tok' },
        checkpoint: null,
      })
    ).rejects.toThrow(/sync token/i);
  });
});
