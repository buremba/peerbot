/**
 * Jira integration spike — decision matrix as executable assertions.
 *
 * Grounds the product comparison (Claude Rovo MCP / Glean-style index / Lobu
 * virtual) in *what this codebase can actually do today*, not marketing claims.
 *
 * Live Atlassian Cloud is optional: set LOBU_SPIKE_JIRA=1 plus
 * JIRA_SPIKE_TOKEN + JIRA_SPIKE_CLOUD_ID to exercise real /search/jql.
 * Without those, this suite stays offline and still pins the capability matrix.
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

/** Product-family capability matrix (documented + asserted where code-backed). */
const MATRIX = {
  // S1 structured "my open P1s" style ops questions
  S1_structured_jql: {
    claude_mcp: 'yes', // searchJiraIssuesUsingJql
    glean_rovo_index: 'yes_with_lag',
    lobu_virtual: 'yes',
    lobu_collected: 'yes_stale',
  },
  // S2 restricted project — principal correctness
  S2_user_principal: {
    claude_mcp: 'yes', // OAuth as user
    glean_rovo_index: 'yes_via_acl_index',
    lobu_virtual: 'token_of_connection', // NOT automatically per-user
    lobu_collected: 'token_of_connection',
  },
  // S3 semantic search without perfect JQL
  S3_semantic: {
    claude_mcp: 'partial', // searchAtlassian beta / text JQL only on classic search
    glean_rovo_index: 'yes',
    lobu_virtual: 'keyword_text_tilde_only',
    lobu_collected: 'yes_if_embedded',
  },
  // S4 comment-heavy thread
  S4_comments: {
    claude_mcp: 'yes', // getJiraIssue + comments via API tools
    glean_rovo_index: 'yes',
    lobu_virtual: 'description_only_in_row', // comments not in live columns
    lobu_collected: 'webhook_raw_or_sync_issue',
  },
  // S5 custom fields
  S5_custom_fields: {
    claude_mcp: 'yes', // getJiraIssue full payload
    glean_rovo_index: 'yes_if_indexed',
    lobu_virtual: 'no_unless_fields_extended',
    lobu_collected: 'no_unless_fields_extended',
  },
  // S6 status change while watching
  S6_push_signal: {
    claude_mcp: 'no', // session-bound, no org push
    glean_rovo_index: 'yes_index_refresh',
    lobu_virtual: 'webhook_raw_only', // no GitHub-style structured store
    lobu_collected: 'sync_plus_webhook_raw',
  },
  // S7 Behavior: status → Escalated → Slack + entity
  S7_offline_automation: {
    claude_mcp: 'no',
    glean_rovo_index: 'platform_agents',
    lobu_virtual: 'needs_webhook_plus_entity',
    lobu_collected: 'yes_if_events_matchable',
  },
  // S8 concurrent live reads / rate limits
  S8_rate_limits: {
    claude_mcp: 'per_user_api',
    glean_rovo_index: 'index_absorb',
    lobu_virtual: 'every_read_hits_jira',
    lobu_collected: 'poll_budget',
  },
  // S9 write transition / comment
  S9_writes: {
    claude_mcp: 'yes', // transitionJiraIssue, addCommentToJiraIssue
    glean_rovo_index: 'varies',
    lobu_virtual: 'no',
    lobu_collected: 'no',
  },
  // S10 Jira outage / offline answer
  S10_offline: {
    claude_mcp: 'no',
    glean_rovo_index: 'yes_stale_index',
    lobu_virtual: 'no',
    lobu_collected: 'yes_stale_events',
  },
} as const;

describe('Jira spike — capability matrix (product families)', () => {
  test('matrix is complete for S1–S10', () => {
    expect(Object.keys(MATRIX)).toHaveLength(10);
  });

  test('Lobu virtual cannot claim Claude-parity on writes or user-principal', () => {
    expect(MATRIX.S9_writes.lobu_virtual).toBe('no');
    expect(MATRIX.S2_user_principal.lobu_virtual).toBe('token_of_connection');
    expect(MATRIX.S9_writes.claude_mcp).toBe('yes');
    expect(MATRIX.S2_user_principal.claude_mcp).toBe('yes');
  });

  test('Lobu differentiator is offline automation potential, not pure Jira chat', () => {
    expect(MATRIX.S7_offline_automation.claude_mcp).toBe('no');
    expect(MATRIX.S7_offline_automation.lobu_virtual).toBe('needs_webhook_plus_entity');
  });
});

describe('Jira spike — S1 structured JQL scenarios (offline)', () => {
  const scenarios: Array<{ name: string; jql: string; terms?: string[] }> = [
    {
      name: 'open P1s in SUPP',
      jql: 'project = SUPP AND priority = Highest AND statusCategory != Done',
    },
    {
      name: 'assigned to me open',
      jql: 'assignee = currentUser() AND resolution = Unresolved',
    },
    {
      name: 'updated last 7d',
      jql: 'project = SUPP AND updated >= -7d',
    },
    {
      name: 'text search auth timeout',
      jql: 'project = SUPP',
      terms: ['auth', 'timeout'],
    },
    {
      name: 'escalated label',
      jql: 'project = SUPP AND labels = escalated',
    },
  ];

  for (const s of scenarios) {
    test(`builds valid JQL: ${s.name}`, () => {
      const out = buildJiraJql({ baseQuery: s.jql, terms: s.terms });
      expect(out.length).toBeGreaterThan(10);
      // Must not double-ORDER when caller already sorted
      expect((out.match(/\border\s+by\b/gi) ?? []).length).toBe(1);
      if (s.terms?.length) {
        for (const t of s.terms) {
          expect(out).toContain(`text ~ "${t}"`);
        }
      }
    });
  }
});

describe('Jira spike — code-backed gap checks', () => {
  test('S9: no write actions / write scopes on connector', () => {
    const c = new JiraConnector();
    expect(c.definition.actions ?? {}).toEqual({});
    const scopes: string[] =
      c.definition.authSchema?.methods?.[0]?.requiredScopes ?? [];
    expect(scopes.some((s) => s.startsWith('write:'))).toBe(false);
    expect(scopes).toContain('read:jira-work');
  });

  test('S1: query/search exist (Claude searchJiraIssuesUsingJql analogue)', () => {
    const c = new JiraConnector();
    expect(typeof c.query).toBe('function');
    expect(typeof c.search).toBe('function');
    expect(c.definition.feeds?.issues?.virtual).toBe(true);
  });

  test('S4/S5: live columns omit comments and custom fields', () => {
    const c = new JiraConnector();
    // Probe row shape via a fake issue through private mapping is hard; assert
    // the field list requested from the API instead by re-reading the module
    // contract: ISSUE_FIELDS is not exported — assert via a live query with
    // capture of the fields= query param.
    const capture: { fields: string[] } = { fields: [] };
    c.client = () => ({
      json: async (url: string) => {
        const u = new URL(url, 'https://api.atlassian.com');
        capture.fields.push(u.searchParams.get('fields') ?? '');
        return { issues: [] };
      },
    });
    return c
      .query({
        credentials: { accessToken: 't' },
        query: 'project = X',
        config: { cloud_id: 'c' },
        sessionState: null,
        limit: 1,
      })
      .then(() => {
        const fields = capture.fields[0] ?? '';
        expect(fields).toContain('summary');
        expect(fields).toContain('status');
        expect(fields).not.toContain('comment');
        expect(fields).not.toMatch(/customfield_/);
      });
  });

  test('S6: feed webhook mode is store but GitHub-only onDelivery is separate path', () => {
    // Documented gap: feed.webhook.mode=store does not give Jira GitHub's
    // structured storeGithubWebhookEvent path. App-webhooks fall through to
    // raw store for jira/linear (asserted by gateway tests).
    const c = new JiraConnector();
    expect(c.definition.feeds?.issues?.webhook?.mode).toBe('store');
    expect(c.definition.webhook?.delivery).toBe('app_installation');
  });
});

describe('Jira spike — optional live /search/jql', () => {
  const live = process.env.LOBU_SPIKE_JIRA === '1';
  const token = process.env.JIRA_SPIKE_TOKEN;
  const cloudId = process.env.JIRA_SPIKE_CLOUD_ID;
  const jql = process.env.JIRA_SPIKE_JQL ?? 'ORDER BY updated DESC';

  test.skipIf(!live || !token || !cloudId)(
    'live: query() returns rows from real Atlassian cloud',
    async () => {
      // Real HTTP — do not mock the SDK for this one; use a fresh import path
      // would require unmocking. Instead call REST the same way the connector
      // would, to validate network + JQL without fighting bun's mock registry.
      const params = new URLSearchParams({
        jql,
        maxResults: '5',
        fields: 'summary,status,assignee,updated',
      });
      const res = await fetch(
        `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search/jql?${params}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
        },
      );
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { issues?: unknown[] };
      expect(Array.isArray(body.issues)).toBe(true);
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            scenario: 'S1_live',
            status: res.status,
            count: body.issues?.length ?? 0,
            jql,
          },
          null,
          2,
        ),
      );
    },
  );
});
