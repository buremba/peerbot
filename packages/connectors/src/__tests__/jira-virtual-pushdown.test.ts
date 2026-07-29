/**
 * Jira virtual-feed pushdown — connector half of the live JQL seam.
 *
 * Mirrors gmail-virtual-pushdown.test.ts: stub the HTTP boundary, exercise
 * query()/search() → liveSearch → /search/jql. No network, no DB.
 *
 * Verifies:
 *  - query() builds JQL from ctx.query (platform config.query);
 *  - search() AND-composes text ~ "term" for each recall term;
 *  - stable column set + row shape;
 *  - limit clamp + offset paging via opaque nextPageToken;
 *  - unsupported sort rejected; total omitted;
 *  - missing credentials throw;
 *  - legacy config.jql falls back when query is empty.
 */

import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let JiraConnector: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let buildJiraJql: any;

beforeAll(async () => {
  const mod = await import('../jira');
  JiraConnector = mod.default;
  buildJiraJql = mod.buildJiraJql;
});

// --- fixtures ------------------------------------------------------------

interface FakeIssue {
  id: string;
  key: string;
  summary: string;
  status: string;
  assignee?: string;
  reporter?: string;
  priority?: string;
  projectKey?: string;
  projectName?: string;
  labels?: string[];
  created?: string;
  updated?: string;
  description?: unknown;
  self?: string;
}

const ISSUES: FakeIssue[] = [
  {
    id: '10001',
    key: 'SUPP-1',
    summary: 'Auth timeout on login',
    status: 'Open',
    assignee: 'Alice',
    reporter: 'Bob',
    priority: 'High',
    projectKey: 'SUPP',
    projectName: 'Support',
    labels: ['auth', 'p1'],
    created: '2026-07-01T10:00:00.000Z',
    updated: '2026-07-02T10:00:00.000Z',
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Users stuck' }] }] },
    self: 'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/10001',
  },
  {
    id: '10002',
    key: 'SUPP-2',
    summary: 'Billing invoice wrong',
    status: 'In Progress',
    assignee: 'Carol',
    reporter: 'Dan',
    priority: 'Medium',
    projectKey: 'SUPP',
    projectName: 'Support',
    created: '2026-07-03T10:00:00.000Z',
    updated: '2026-07-04T10:00:00.000Z',
    self: 'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/10002',
  },
  {
    id: '10003',
    key: 'SUPP-3',
    summary: 'Feature request: SSO',
    status: 'Open',
    projectKey: 'SUPP',
    projectName: 'Support',
    created: '2026-07-05T10:00:00.000Z',
    updated: '2026-07-06T10:00:00.000Z',
    self: 'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/10003',
  },
];

interface Capture {
  jqls: string[];
  maxResults: number[];
  tokens: Array<string | null>;
  urls: string[];
}

function toApiIssue(i: FakeIssue) {
  return {
    id: i.id,
    key: i.key,
    self: i.self,
    fields: {
      summary: i.summary,
      status: { name: i.status },
      assignee: i.assignee ? { displayName: i.assignee } : null,
      reporter: i.reporter ? { displayName: i.reporter } : null,
      priority: i.priority ? { name: i.priority } : null,
      project: i.projectKey
        ? { key: i.projectKey, name: i.projectName ?? i.projectKey }
        : null,
      labels: i.labels ?? [],
      created: i.created,
      updated: i.updated,
      description: i.description ?? null,
    },
  };
}

/**
 * Fake HTTP client for /search/jql (+ optional accessible-resources).
 * Honors maxResults + nextPageToken as a numeric cursor into the corpus so
 * offset/limit is end-to-end.
 */
function fakeHttp(
  capture: Capture,
  corpus: FakeIssue[] = ISSUES,
  opts?: {
    accessibleResources?: Array<{
      id: string;
      url?: string;
      name?: string;
      scopes?: string[];
    }>;
  },
) {
  return {
    json: async (url: string) => {
      capture.urls.push(url);
      if (url.includes('/oauth/token/accessible-resources')) {
        return opts?.accessibleResources ?? [];
      }
      const u = new URL(url, 'https://api.atlassian.com');
      capture.jqls.push(u.searchParams.get('jql') ?? '');
      const maxResults = Number(u.searchParams.get('maxResults'));
      capture.maxResults.push(maxResults);
      const start = Number(u.searchParams.get('nextPageToken') ?? '0');
      capture.tokens.push(u.searchParams.get('nextPageToken'));
      const slice = corpus.slice(start, start + maxResults);
      const next = start + maxResults;
      return {
        issues: slice.map(toApiIssue),
        ...(next < corpus.length ? { nextPageToken: String(next) } : {}),
      };
    },
  };
}

function connectorWith(
  capture: Capture,
  corpus?: FakeIssue[],
  opts?: {
    accessibleResources?: Array<{
      id: string;
      url?: string;
      name?: string;
      scopes?: string[];
    }>;
  },
) {
  const c = new JiraConnector();
  c.client = () => fakeHttp(capture, corpus, opts);
  return c;
}

const BASE_CTX = {
  credentials: { accessToken: 'tok' },
  config: { cloud_id: 'cloud-1' },
  sessionState: null,
};

describe('buildJiraJql', () => {
  test('uses base query and appends default ORDER BY when missing', () => {
    expect(buildJiraJql({ baseQuery: 'project = SUPP' })).toBe(
      'project = SUPP ORDER BY updated DESC',
    );
  });

  test('AND-composes text ~ terms', () => {
    expect(
      buildJiraJql({ baseQuery: 'project = SUPP', terms: ['auth', 'timeout'] }),
    ).toBe('(project = SUPP) AND (text ~ "auth" AND text ~ "timeout") ORDER BY updated DESC');
  });

  test('escapes quotes inside terms', () => {
    expect(buildJiraJql({ baseQuery: '', terms: ['say "hi"'] })).toBe(
      '(updated >= -90d) AND (text ~ "say \\"hi\\"") ORDER BY updated DESC',
    );
  });

  test('peels ORDER BY before AND-composing terms', () => {
    expect(
      buildJiraJql({
        baseQuery: 'updated >= -90d ORDER BY updated DESC',
        terms: ['verification'],
      }),
    ).toBe('(updated >= -90d) AND (text ~ "verification") ORDER BY updated DESC');
  });

  test('rejects sort when ORDER BY already present', () => {
    expect(() =>
      buildJiraJql({
        baseQuery: 'project = X ORDER BY key ASC',
        sort: { column: 'updated', order: 'desc' },
      }),
    ).toThrow(/already contains ORDER BY/);
  });

  test('applies supported sort columns', () => {
    expect(
      buildJiraJql({
        baseQuery: 'project = SUPP',
        sort: { column: 'created_at', order: 'asc' },
      }),
    ).toBe('project = SUPP ORDER BY created ASC');
  });
});

describe('Jira virtual-feed pushdown', () => {
  test('query() builds JQL from ctx.query and returns stable row shape', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const c = connectorWith(cap);
    const res = await c.query({
      ...BASE_CTX,
      query: 'project = SUPP',
      limit: 10,
    });

    expect(cap.jqls).toEqual(['project = SUPP ORDER BY updated DESC']);
    expect(res.columns.map((col: { name: string }) => col.name)).toEqual([
      'id',
      'key',
      'summary',
      'status',
      'assignee',
      'reporter',
      'priority',
      'project_key',
      'project_name',
      'labels',
      'created_at',
      'updated_at',
      'description',
      'url',
    ]);
    expect(res.rows).toHaveLength(3);
    expect(res.rows[0]).toMatchObject({
      id: '10001',
      key: 'SUPP-1',
      summary: 'Auth timeout on login',
      status: 'Open',
      assignee: 'Alice',
      reporter: 'Bob',
      priority: 'High',
      project_key: 'SUPP',
      labels: 'auth, p1',
      description: 'Users stuck',
    });
    expect(res.total).toBeUndefined();
  });

  test('falls back to config.jql when ctx.query is empty', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const c = connectorWith(cap);
    await c.query({
      credentials: { accessToken: 'tok' },
      query: '',
      config: { cloud_id: 'cloud-1', jql: 'assignee = currentUser()' },
      sessionState: null,
      limit: 5,
    });
    expect(cap.jqls[0]).toBe('assignee = currentUser() ORDER BY updated DESC');
  });

  test('search() AND-composes text ~ terms onto the base JQL', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const c = connectorWith(cap);
    await c.search({
      ...BASE_CTX,
      query: 'project = SUPP',
      terms: ['auth', 'timeout'],
      limit: 5,
    });
    expect(cap.jqls[0]).toBe(
      '(project = SUPP) AND (text ~ "auth" AND text ~ "timeout") ORDER BY updated DESC',
    );
  });

  test('clamps limit and pages with nextPageToken for offset', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const c = connectorWith(cap);
    // want offset 1 + limit 1 → need 2 issues; first page may fetch 2
    const res = await c.query({
      ...BASE_CTX,
      query: 'project = SUPP',
      limit: 1,
      offset: 1,
    });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].key).toBe('SUPP-2');
    expect(cap.maxResults[0]).toBe(2);
  });

  test('rejects unsupported sort columns', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const c = connectorWith(cap);
    await expect(
      c.query({
        ...BASE_CTX,
        query: 'project = SUPP',
        sort: { column: 'not_a_field', order: 'desc' },
        limit: 5,
      }),
    ).rejects.toThrow(/unsupported/);
  });

  test('throws without credentials', async () => {
    const c = new JiraConnector();
    await expect(
      c.query({
        credentials: null,
        query: 'project = X',
        config: { cloud_id: 'cloud-1' },
      }),
    ).rejects.toThrow(/OAuth credentials/);
  });

  test('feed definition defaults issues to virtual', () => {
    const c = new JiraConnector();
    expect(c.definition.feeds?.issues?.virtual).toBe(true);
    expect(c.definition.feeds?.issues?.webhook?.mode).toBe('store');
    expect(c.definition.version).toBe('1.1.2');
  });

  test('lazy-resolves cloud_id via accessible-resources when config omits it', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const c = connectorWith(cap, undefined, {
      accessibleResources: [
        {
          id: 'lazy-cloud',
          url: 'https://lazy.atlassian.net',
          name: 'Lazy',
          scopes: ['read:jira-work'],
        },
      ],
    });
    const res = await c.query({
      credentials: { accessToken: 'tok' },
      config: {},
      sessionState: null,
      query: 'project = SUPP',
      limit: 5,
    });
    expect(res.rows.length).toBeGreaterThan(0);
    expect(cap.urls.some((u) => u.includes('accessible-resources'))).toBe(true);
    expect(cap.urls.some((u) => u.includes('/ex/jira/lazy-cloud/'))).toBe(true);
    expect(cap.jqls[0]).toContain('project = SUPP');
  });

  test('throws when cloud_id missing and accessible-resources is empty', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const c = connectorWith(cap, undefined, { accessibleResources: [] });
    await expect(
      c.query({
        credentials: { accessToken: 'tok' },
        config: {},
        sessionState: null,
        query: 'project = X',
        limit: 5,
      }),
    ).rejects.toThrow(/no accessible Atlassian Cloud sites/);
  });
});
