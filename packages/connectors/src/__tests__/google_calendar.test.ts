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
  let i = 0;
  return {
    calls,
    client: {
      raw: async (url: string) => {
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
