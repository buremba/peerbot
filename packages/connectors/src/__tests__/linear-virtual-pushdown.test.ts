/**
 * Linear virtual-feed pushdown — query()/search() via GraphQL issues filter.
 */

import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let LinearConnector: any;

beforeAll(async () => {
  const mod = await import('../linear');
  LinearConnector = mod.default;
});

interface Capture {
  queries: string[];
}

function connectorWith(capture: Capture, nodes: Array<Record<string, unknown>>) {
  const c = new LinearConnector();
  c.graphql = async (_creds: unknown, query: string) => {
    capture.queries.push(query);
    const first = Number(query.match(/issues\(first: (\d+)/)?.[1] ?? nodes.length);
    const start = Number(query.match(/after: "(\d+)"/)?.[1] ?? 0);
    const pageNodes = nodes.slice(start, start + first);
    const next = start + pageNodes.length;
    return {
      issues: {
        pageInfo: {
          hasNextPage: next < nodes.length,
          endCursor: next < nodes.length ? String(next) : null,
        },
        nodes: pageNodes,
      },
    };
  };
  return c;
}

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
    expect(cap.queries[0]).toContain('filter: { and:');
    expect(cap.queries[0]).toContain('ENG');
    expect(cap.queries[0]).toContain('updatedAt: { gte:');
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

  test('pages beyond Linear per-request limits to honor the caller limit', async () => {
    const cap: Capture = { queries: [] };
    const nodes = Array.from({ length: 120 }, (_, index) => ({
      id: `iss-${index + 1}`,
      identifier: `ENG-${index + 1}`,
      title: `Issue ${index + 1}`,
      state: { name: 'Todo', type: 'unstarted' },
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    }));
    const c = connectorWith(cap, nodes);
    const res = await c.query({
      credentials: { accessToken: 'tok' },
      config: {},
      sessionState: null,
      query: '',
      limit: 120,
    });
    expect(res.rows).toHaveLength(120);
    expect(cap.queries).toHaveLength(3);
    expect(cap.queries[0]).toContain('issues(first: 50');
    expect(cap.queries[1]).toContain('issues(first: 50, after: "50"');
    expect(cap.queries[2]).toContain('issues(first: 20, after: "100"');
  });

  test('rejects offset+limit beyond max reachable pagination depth', async () => {
    const cap: Capture = { queries: [] };
    const c = connectorWith(cap, []);
    // PAGE_SIZE=50 × MAX_PAGES=50 → 2500 max. offset=2500 limit=1 ⇒ 2501.
    await expect(
      c.query({
        credentials: { accessToken: 'tok' },
        config: {},
        sessionState: null,
        query: '',
        limit: 1,
        offset: 2500,
      }),
    ).rejects.toThrow(/max reachable depth/);
    expect(cap.queries).toHaveLength(0);
  });

  test('uses max_results as an optional feed cap', async () => {
    const cap: Capture = { queries: [] };
    const nodes = Array.from({ length: 5 }, (_, index) => ({
      id: `iss-${index + 1}`,
      identifier: `ENG-${index + 1}`,
      title: `Issue ${index + 1}`,
    }));
    const c = connectorWith(cap, nodes);
    const res = await c.query({
      credentials: { accessToken: 'tok' },
      config: { max_results: 2 },
      sessionState: null,
      query: '',
      limit: 50,
    });
    expect(res.rows).toHaveLength(2);
    expect(cap.queries).toHaveLength(1);
    expect(cap.queries[0]).toContain('issues(first: 2');
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

  test('rejects caller-defined sort instead of silently returning updated order', async () => {
    const c = connectorWith({ queries: [] }, []);
    await expect(
      c.query({
        credentials: { accessToken: 'tok' },
        config: {},
        sessionState: null,
        query: '',
        sort: { column: 'created_at', order: 'asc' },
      }),
    ).rejects.toThrow(/does not support caller-defined sort/);
  });

  test('feed definition defaults issues to virtual', () => {
    const c = new LinearConnector();
    expect(c.definition.feeds?.issues?.virtual).toBe(true);
    expect(c.definition.version).toBe('1.1.0');
  });
});
