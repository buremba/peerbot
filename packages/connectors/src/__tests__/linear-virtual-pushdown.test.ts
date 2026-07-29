/**
 * Linear virtual-feed pushdown — query()/search() via GraphQL issues filter.
 */

import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let LinearConnector: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let buildLinearIssueFilter: any;

beforeAll(async () => {
  const mod = await import('../linear');
  LinearConnector = mod.default;
  buildLinearIssueFilter = mod.buildLinearIssueFilter;
});

interface Capture {
  queries: string[];
}

function connectorWith(capture: Capture, nodes: Array<Record<string, unknown>>) {
  const c = new LinearConnector();
  c.graphql = async (_creds: unknown, query: string) => {
    capture.queries.push(query);
    return {
      issues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes,
      },
    };
  };
  return c;
}

describe('buildLinearIssueFilter', () => {
  test('empty when no constraints', () => {
    expect(buildLinearIssueFilter({})).toBe('');
  });

  test('team key alone', () => {
    expect(buildLinearIssueFilter({ teamKey: 'ENG' })).toContain('team: { key: { eq: "ENG" } }');
  });

  test('AND-composes team + updated + text terms', () => {
    const f = buildLinearIssueFilter({
      teamKey: 'ENG',
      updatedAfterIso: '2026-01-01T00:00:00.000Z',
      textTerms: ['auth', 'timeout'],
    });
    expect(f).toContain('filter: { and:');
    expect(f).toContain('ENG');
    expect(f).toContain('2026-01-01');
    expect(f).toContain('auth');
    expect(f).toContain('timeout');
  });
});

describe('Linear virtual-feed pushdown', () => {
  test('query() returns stable row shape', async () => {
    const cap: Capture = { queries: [] };
    const c = connectorWith(cap, [
      {
        id: 'iss-1',
        identifier: 'ENG-1',
        title: 'Auth timeout',
        description: 'Users stuck',
        url: 'https://linear.app/acme/issue/ENG-1',
        state: { name: 'Todo', type: 'unstarted' },
        assignee: { displayName: 'Alice' },
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-02T00:00:00.000Z',
      },
    ]);
    const res = await c.query({
      credentials: { accessToken: 'tok' },
      config: { team_key: 'ENG', lookback_days: 30 },
      sessionState: null,
      query: 'auth',
      limit: 10,
    });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      id: 'iss-1',
      identifier: 'ENG-1',
      title: 'Auth timeout',
      state: 'Todo',
      assignee: 'Alice',
    });
    expect(res.columns.map((col: { name: string }) => col.name)).toContain('identifier');
    expect(cap.queries[0]).toContain('issues(first:');
    expect(cap.queries[0]).toContain('ENG');
    expect(cap.queries[0]).toContain('auth');
  });

  test('search() pushes terms into filter', async () => {
    const cap: Capture = { queries: [] };
    const c = connectorWith(cap, []);
    await c.search({
      credentials: { accessToken: 'tok' },
      config: {},
      sessionState: null,
      terms: ['billing'],
      limit: 5,
    });
    expect(cap.queries[0]).toContain('billing');
    expect(cap.queries[0]).toContain('containsIgnoreCase');
  });

  test('throws without credentials', async () => {
    const c = new LinearConnector();
    await expect(
      c.query({
        credentials: null,
        config: {},
        sessionState: null,
      }),
    ).rejects.toThrow(/OAuth credentials/);
  });

  test('feed definition defaults issues to virtual', () => {
    const c = new LinearConnector();
    expect(c.definition.feeds?.issues?.virtual).toBe(true);
    expect(c.definition.version).toBe('1.1.0');
  });
});
