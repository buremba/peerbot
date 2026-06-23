import { beforeAll, describe, expect, mock, test } from 'bun:test';
// The connector delegates its sync loop to the cursor paginator; the shared mock
// provides a faithful real generator (not a throwing stub), so this exercises
// the genuine paging semantics while keeping the browser stack out.
import { connectorSdkMock } from './connector-sdk.mock';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let JiraConnector: any;

beforeAll(async () => {
  const mod = await import('../jira');
  JiraConnector = mod.default;
});

interface JiraPage {
  issues?: Array<{ id?: string; key?: string; fields?: Record<string, unknown> }>;
  nextPageToken?: string;
}

/** Build a fake http client whose `json()` serves a queue of /search/jql pages. */
function fakeHttp(pages: JiraPage[]) {
  const calls: Array<string | null> = [];
  let i = 0;
  return {
    calls,
    client: {
      json: async (url: string) => {
        const u = new URL(url, 'https://api.atlassian.com');
        calls.push(u.searchParams.get('nextPageToken'));
        return pages[i++] ?? { issues: [] };
      },
    },
  };
}

function makeCtx() {
  return {
    config: { cloud_id: 'cloud-1', jql: 'order by updated DESC' },
    credentials: { accessToken: 'tok' },
    sessionState: null,
    checkpoint: null,
  };
}

describe('JiraConnector.sync pagination', () => {
  test('follows nextPageToken across pages and stops when the token is absent', async () => {
    const connector = new JiraConnector();
    const { client, calls } = fakeHttp([
      { issues: [{ id: '1' }, { id: '2' }], nextPageToken: 'p2' },
      { issues: [{ id: '3' }], nextPageToken: 'p3' },
      { issues: [{ id: '4' }] }, // no token -> last page
    ]);
    connector.client = () => client;

    const result = await connector.sync(makeCtx());

    // 4 issues across 3 pages, all mapped to events.
    expect(result.events).toHaveLength(4);
    expect(result.events.map((e: { origin_id: string }) => e.origin_id)).toEqual([
      'jira_issue_1',
      'jira_issue_2',
      'jira_issue_3',
      'jira_issue_4',
    ]);
    // First page sends no cursor, then follows p2, p3.
    expect(calls).toEqual([null, 'p2', 'p3']);
    expect(result.metadata).toEqual({ items_found: 4 });
  });

  test('stops on an empty page even when a token is returned (degenerate cursor guard)', async () => {
    const connector = new JiraConnector();
    const { client, calls } = fakeHttp([
      { issues: [{ id: '1' }], nextPageToken: 'p2' },
      { issues: [], nextPageToken: 'p3' }, // empty page but token present -> must stop
      { issues: [{ id: 'should-not-fetch' }] },
    ]);
    connector.client = () => client;

    const result = await connector.sync(makeCtx());

    expect(result.events).toHaveLength(1);
    // Only two fetches: page 1, then the empty page 2; page 3 is never requested.
    expect(calls).toEqual([null, 'p2']);
  });
});
