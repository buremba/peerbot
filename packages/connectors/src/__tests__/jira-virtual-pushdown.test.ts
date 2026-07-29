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

beforeAll(async () => {
  const mod = await import('../jira');
  JiraConnector = mod.default;
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
    description: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Users ' },
            { type: 'text', text: 'stuck' },
          ],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Please retry' }],
        },
      ],
    },
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
  config: {
    cloud_id: 'cloud-1',
    site_cloud_id: 'cloud-1',
    site_url: 'https://support.atlassian.net',
  },
  sessionState: null,
};

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
      description: 'Users stuck\nPlease retry',
      url: 'https://support.atlassian.net/browse/SUPP-1',
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
      query: 'project = SUPP ORDER BY updated DESC',
      terms: ['auth', 'timeout'],
      limit: 5,
    });
    expect(cap.jqls[0]).toBe(
      '(project = SUPP) AND (text ~ "auth" AND text ~ "timeout") ORDER BY updated DESC',
    );
  });

  test('search() escapes quoted terms', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const c = connectorWith(cap);
    await c.search({
      ...BASE_CTX,
      query: '',
      terms: ['say "hi"'],
      limit: 5,
    });
    expect(cap.jqls[0]).toBe(
      '(updated >= -90d) AND (text ~ "say \\"hi\\"") ORDER BY updated DESC',
    );
  });

  test('does not treat ORDER BY text inside a quoted value as a sort clause', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const c = connectorWith(cap);
    await c.query({
      ...BASE_CTX,
      query: 'text ~ "order by updated"',
      limit: 5,
    });
    expect(cap.jqls[0]).toBe('text ~ "order by updated" ORDER BY updated DESC');
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

  test('pages beyond Jira per-request limits to honor the caller limit', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const corpus = Array.from({ length: 150 }, (_, index) => ({
      id: String(20_000 + index),
      key: `BIG-${index + 1}`,
      summary: `Issue ${index + 1}`,
      status: 'Open',
    }));
    const c = connectorWith(cap, corpus);
    const res = await c.query({
      ...BASE_CTX,
      query: 'project = BIG',
      limit: 150,
    });
    expect(res.rows).toHaveLength(150);
    expect(cap.maxResults).toEqual([100, 50]);
    expect(cap.tokens).toEqual([null, '100']);
  });

  test('rejects offset+limit beyond max reachable pagination depth', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const c = connectorWith(cap);
    // PAGE_SIZE=100 × MAX_PAGES=50 → 5000 max. offset=5000 limit=1 ⇒ 5001.
    await expect(
      c.query({
        ...BASE_CTX,
        query: 'project = SUPP',
        limit: 1,
        offset: 5000,
      }),
    ).rejects.toThrow(/max reachable depth/);
    expect(cap.jqls).toHaveLength(0);
  });

  test('uses max_results as an optional feed cap', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const c = connectorWith(cap);
    const res = await c.query({
      ...BASE_CTX,
      config: { ...BASE_CTX.config, max_results: 2 },
      query: 'project = SUPP',
      limit: 50,
    });
    expect(res.rows).toHaveLength(2);
    expect(cap.maxResults).toEqual([2]);
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

  test('rejects caller sort when the JQL already contains ORDER BY', async () => {
    const c = connectorWith({ jqls: [], maxResults: [], tokens: [], urls: [] });
    await expect(
      c.query({
        ...BASE_CTX,
        query: 'project = SUPP ORDER BY key ASC',
        sort: { column: 'updated_at', order: 'desc' },
        limit: 5,
      }),
    ).rejects.toThrow(/already contains ORDER BY/);
  });

  test('applies supported sort columns', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const c = connectorWith(cap);
    await c.query({
      ...BASE_CTX,
      query: 'project = SUPP',
      sort: { column: 'created_at', order: 'asc' },
      limit: 5,
    });
    expect(cap.jqls[0]).toBe('project = SUPP ORDER BY created ASC');
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

  test('deduplicates accessible resources that describe the same cloud site', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const c = connectorWith(cap, undefined, {
      accessibleResources: [
        {
          id: 'shared-cloud',
          url: 'https://shared.atlassian.net',
          scopes: ['read:jira-work'],
        },
        {
          id: 'shared-cloud',
          url: 'https://shared.atlassian.net',
          scopes: ['read:confluence-content.summary'],
        },
      ],
    });
    const config: Record<string, unknown> = {};
    const res = await c.query({
      credentials: { accessToken: 'tok' },
      config,
      sessionState: null,
      query: 'project = SUPP',
      limit: 5,
    });
    expect(res.rows).toHaveLength(3);
    expect(config.cloud_id).toBe('shared-cloud');
  });

  test('clears stale site metadata when discovery does not return it', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const c = connectorWith(cap, undefined, {
      accessibleResources: [
        {
          id: 'lazy-cloud',
          scopes: ['read:jira-work'],
        },
      ],
    });
    const config: Record<string, unknown> = {
      site_url: 'https://stale.atlassian.net',
      site_name: 'Stale',
    };
    await c.query({
      credentials: { accessToken: 'tok' },
      config,
      sessionState: null,
      query: 'project = SUPP',
      limit: 5,
    });
    expect(config).toEqual({ cloud_id: 'lazy-cloud', site_cloud_id: 'lazy-cloud' });
  });

  test('does not use inherited site_url when feed overrides cloud_id', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const c = connectorWith(cap, [
      {
        id: '20001',
        key: 'B-1',
        summary: 'Other site issue',
        status: 'Open',
        self: 'https://api.atlassian.com/ex/jira/cloud-b/rest/api/3/issue/20001',
      },
    ]);
    const res = await c.query({
      credentials: { accessToken: 'tok' },
      // Connection had site A; feed overrides to cloud B without a matching site_url.
      config: {
        cloud_id: 'cloud-b',
        site_cloud_id: 'cloud-a',
        site_url: 'https://site-a.atlassian.net',
      },
      sessionState: null,
      query: 'project = B',
      limit: 5,
    });
    expect(res.rows).toHaveLength(1);
    // Must not emit site-a browse links for cloud-b issues.
    expect(res.rows[0].url).toBe(
      'https://api.atlassian.com/ex/jira/cloud-b/rest/api/3/issue/20001',
    );
    expect(String(res.rows[0].url)).not.toContain('site-a.atlassian.net');
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

  test('requires an explicit cloud_id for a multi-site token', async () => {
    const cap: Capture = { jqls: [], maxResults: [], tokens: [], urls: [] };
    const c = connectorWith(cap, undefined, {
      accessibleResources: [
        { id: 'cloud-a', scopes: ['read:jira-work'] },
        { id: 'cloud-b', scopes: ['read:jira-work'] },
      ],
    });
    await expect(
      c.query({
        credentials: { accessToken: 'tok' },
        config: {},
        sessionState: null,
        query: 'project = X',
        limit: 5,
      }),
    ).rejects.toThrow(/multiple Cloud sites/);
  });

  test('registerWebhook does not reuse search-only JQL as a dynamic-webhook filter', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const c = new JiraConnector();
    c.client = () => ({
      json: async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        return { webhookRegistrationResult: [{ createdWebhookId: 42 }] };
      },
    });

    await c.registerWebhook({
      credentials: { accessToken: 'tok' },
      config: { cloud_id: 'cloud-1', query: 'updated >= -30d' },
      sessionState: null,
      callbackUrl: 'https://example.test/webhook',
    });

    expect(
      (requestBody?.webhooks as Array<{ jqlFilter: string }>)[0]?.jqlFilter,
    ).toBe('');
  });
});
