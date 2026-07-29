/**
 * Jira Connector (V1 runtime)
 *
 * Live-reads Jira Cloud issues via JQL (`query()` / `search()` for virtual feeds)
 * and optionally syncs them into events (`sync()` for collected feeds). Real-time
 * issue/comment deliveries arrive via Jira dynamic webhooks (registered at connect
 * time); raw deliveries land downstream (extract-load) as the reactive signal spine
 * for Behaviors — virtual feeds never poll.
 */

import { randomBytes } from 'node:crypto';
import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  paginateByCursor,
  type QueryContext,
  type QueryResult,
  requireBearerClient,
  type SearchContext,
  type SyncContext,
  type SyncCredentials,
  type SyncResult,
  type WebhookRegistration,
  type WebhookRegistrationContext,
} from '@lobu/connector-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JiraConfig {
  /**
   * Atlassian Cloud id for the target site. REST base is
   * `https://api.atlassian.com/ex/jira/{cloudId}/…`.
   *
   * Auto-stamped onto **connection.config** after OAuth from
   * `/oauth/token/accessible-resources`. Virtual reads merge connection.config
   * (same as sync/poll), so feeds usually need no cloud_id. Fallbacks, in order:
   * `config.cloud_id` → `sessionState.cloud_id` → live accessible-resources lookup
   * with the OAuth access token (first site with a jira scope, else first site).
   */
  cloud_id?: string;
  /** Site URL from OAuth discovery (informational; not required for REST). */
  site_url?: string;
  /** Site display name from OAuth discovery. */
  site_name?: string;
  /**
   * Base JQL scope for virtual-feed reads (platform `config.query` contract).
   * Empty defaults to `updated >= -90d` — Atlassian rejects unbounded JQL on
   * `/search/jql`.
   */
  query?: string;
  /**
   * Legacy / sync JQL filter. Virtual reads prefer `query`, then `jql`.
   * Defaults to `updated >= -{lookback_days}d` on collected sync.
   */
  jql?: string;
  lookback_days?: number;
  /** Max issues per live virtual-feed page (clamped). Default 50. */
  max_results?: number;
}

interface JiraCheckpoint {
  last_sync_at?: string;
}

interface JiraUser {
  displayName?: string | null;
  emailAddress?: string | null;
  accountId?: string | null;
}

interface JiraIssueFields {
  summary?: string | null;
  description?: unknown;
  status?: { name?: string | null } | null;
  assignee?: JiraUser | null;
  reporter?: JiraUser | null;
  priority?: { name?: string | null } | null;
  project?: { key?: string | null; name?: string | null } | null;
  labels?: string[] | null;
  created?: string | null;
  updated?: string | null;
}

interface JiraIssue {
  id?: string;
  key?: string;
  self?: string;
  fields?: JiraIssueFields;
}

interface JiraSearchResponse {
  issues?: JiraIssue[];
  /** Token-based pagination cursor for the /search/jql endpoint (absent on the last page). */
  nextPageToken?: string;
  isLast?: boolean;
}

/** Stable column set returned by live `query()`/`search()` pushdown reads. */
const JIRA_ISSUE_COLUMNS = [
  { name: 'id', type: 'string' },
  { name: 'key', type: 'string' },
  { name: 'summary', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'assignee', type: 'string' },
  { name: 'reporter', type: 'string' },
  { name: 'priority', type: 'string' },
  { name: 'project_key', type: 'string' },
  { name: 'project_name', type: 'string' },
  { name: 'labels', type: 'string' },
  { name: 'created_at', type: 'string' },
  { name: 'updated_at', type: 'string' },
  { name: 'description', type: 'string' },
  { name: 'url', type: 'string' },
] as const;

const ISSUE_FIELDS =
  'summary,description,status,assignee,reporter,priority,project,labels,created,updated';

/** Sort columns the live path can honor by rewriting ORDER BY. */
const SORT_COLUMNS: Record<string, string> = {
  updated: 'updated',
  updated_at: 'updated',
  created: 'created',
  created_at: 'created',
  key: 'key',
  priority: 'priority',
  status: 'status',
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function actorName(user: JiraUser | null | undefined): string | undefined {
  return user?.displayName ?? user?.emailAddress ?? undefined;
}

/**
 * Jira v3 descriptions/comment bodies use the Atlassian Document Format (ADF) —
 * a nested JSON node tree. Flatten its text nodes to plain text. Strings (older
 * payloads) pass through unchanged.
 */
function adfToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const node = value as { type?: string; text?: string; content?: unknown[] };
  if (typeof node.text === 'string') return node.text;
  if (Array.isArray(node.content)) {
    const parts = node.content.map((child) => adfToText(child));
    // Block-level nodes (paragraph, heading, listItem) get a newline separator.
    const sep = node.type && node.type !== 'text' ? '\n' : '';
    return parts.join(sep).trim();
  }
  return '';
}

/** Escape a value embedded in a JQL double-quoted string. */
function escapeJqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build the JQL sent to `/search/jql`.
 * - Base: `ctx.query` (platform virtual contract) → `config.jql` → optional default.
 * - Recall terms: each becomes `text ~ "term"` AND-ed onto the base (Jira text search).
 * - Sort: only applied when the base has no ORDER BY and a supported sort is given.
 */
/**
 * Peel a trailing `ORDER BY …` so terms can be AND-composed without wrapping
 * the sort clause (Jira rejects `(… ORDER BY …) AND (text ~ "x")`).
 */
function splitTrailingOrderBy(jql: string): { body: string; orderBy: string | null } {
  const m = jql.match(/^(.*?)\s+(\border\s+by\b[\s\S]+)$/i);
  if (!m) return { body: jql.trim(), orderBy: null };
  return { body: m[1].trim(), orderBy: m[2].trim() };
}

export function buildJiraJql(args: {
  baseQuery: string;
  terms?: string[];
  sort?: { column: string; order: 'asc' | 'desc' };
  defaultWhenEmpty?: string;
}): string {
  const trimmed = args.baseQuery.trim();
  // Prefer an explicit default restriction over bare ORDER BY — Atlassian
  // rejects unbounded JQL on /search/jql.
  let jql = trimmed.length > 0 ? trimmed : (args.defaultWhenEmpty ?? 'updated >= -90d');

  // If the base is only ORDER BY, treat the restriction as empty and keep sort.
  let { body, orderBy } = splitTrailingOrderBy(jql);
  if (!body && orderBy) {
    body = args.defaultWhenEmpty ?? 'updated >= -90d';
  }

  const terms = (args.terms ?? []).map((t) => t.trim()).filter(Boolean);
  if (terms.length > 0) {
    const textClauses = terms.map((t) => `text ~ "${escapeJqlString(t)}"`).join(' AND ');
    body = body.length > 0 ? `(${body}) AND (${textClauses})` : textClauses;
  }

  if (orderBy) {
    if (args.sort) {
      throw new Error(
        'Jira virtual feed: cannot apply sort when the base JQL already contains ORDER BY',
      );
    }
    return body.length > 0 ? `${body} ${orderBy}` : orderBy;
  }

  if (args.sort) {
    const field = SORT_COLUMNS[args.sort.column];
    if (!field) {
      throw new Error(
        `Jira virtual feed sort column '${args.sort.column}' is unsupported; ` +
          `use one of: ${Object.keys(SORT_COLUMNS).join(', ')}`,
      );
    }
    const dir = args.sort.order === 'asc' ? 'ASC' : 'DESC';
    return body.length > 0 ? `${body} ORDER BY ${field} ${dir}` : `ORDER BY ${field} ${dir}`;
  }

  return body.length > 0 ? `${body} ORDER BY updated DESC` : 'updated >= -90d ORDER BY updated DESC';
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class JiraConnector extends ConnectorRuntime<JiraCheckpoint, JiraConfig> {
  readonly definition: ConnectorDefinition = {
    key: 'jira',
    name: 'Jira',
    description:
      'Live-reads Jira Cloud issues via JQL (virtual feeds) and receives real-time issue/comment webhooks.',
    version: '1.1.2',
    faviconDomain: 'atlassian.com',
    webhook: {
      // Jira dynamic webhooks HMAC-sign the raw body with the registration
      // secret and send `x-hub-signature: sha256=<hex>`. Jira does not send a
      // stable delivery id header, so dedupe falls back to a body hash
      // (no `dedupeHeader`).
      signatureHeader: 'x-hub-signature',
      algorithm: 'sha256',
      signaturePrefix: 'sha256=',
      // App-installation delivery: one webhook is configured ONCE on the Jira
      // Connect app; deliveries route via `/api/v1/app-webhooks/jira`. Jira
      // bodies don't carry the cloudId, but every entity exposes a REST `self`
      // URL on its site host — the tenant is that host (one install per site).
      delivery: 'app_installation',
      routingKeyPaths: [
        'self',
        'issue.self',
        'comment.self',
        'user.self',
        'project.self',
        'version.self',
      ],
      routingKeyTransform: 'url-host',
    },
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'jira',
          requiredScopes: [
            'read:jira-work',
            'read:jira-user',
            'manage:jira-webhook',
            'offline_access',
          ],
          authorizationUrl: 'https://auth.atlassian.com/authorize',
          tokenUrl: 'https://auth.atlassian.com/oauth/token',
          tokenEndpointAuthMethod: 'client_secret_post',
          authParams: { audience: 'api.atlassian.com', prompt: 'consent' },
          clientIdKey: 'JIRA_CLIENT_ID',
          clientSecretKey: 'JIRA_CLIENT_SECRET',
          required: true,
          description: 'Atlassian (Jira) 3LO OAuth enables reading issues and managing webhooks.',
          setupInstructions:
            'Create an OAuth 2.0 (3LO) app in the Atlassian Developer Console. Set the callback URL to {{redirect_uri}}, enable the Jira API scopes, then copy the client ID and secret below.',
        },
      ],
    },
    feeds: {
      issues: {
        key: 'issues',
        name: 'Issues',
        description:
          'Live Jira issues via JQL (virtual by default). Webhooks carry create/update/comment signals; optional collected sync still uses the same JQL.',
        // Default new feeds to virtual — live JQL at read time, no event copy.
        // Callers can still create collected feeds with virtual: false.
        virtual: true,
        configSchema: {
          type: 'object',
          properties: {
            cloud_id: {
              type: 'string',
              description:
                'Atlassian Cloud id (usually auto-set on the connection after OAuth). Optional feed-level override for multi-site tokens.',
            },
            query: {
              type: 'string',
              description:
                'Base JQL for virtual reads (platform config.query). Empty defaults to updated >= -90d.',
            },
            jql: {
              type: 'string',
              description:
                'Legacy JQL filter (collected sync + fallback when query is unset). Defaults to recently-updated issues on sync.',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 730,
              default: 365,
              description: 'Collected-sync lookback window when jql/query is unset.',
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 50,
              description: 'Maximum issues to return per virtual-feed read page.',
            },
          },
        },
        // Webhook events for this feed: store-mode is preferred for virtual
        // (never polled). App-installation extract-load still lands raw
        // deliveries; feed routing uses these event names when present.
        webhook: {
          events: ['jira:issue_created', 'jira:issue_updated', 'comment_created'],
          mode: 'store',
        },
        eventKinds: {
          issue: {
            description: 'A Jira issue',
            metadataSchema: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                status: { type: 'string' },
                assignee: { type: 'string' },
                reporter: { type: 'string' },
                updated_at: { type: 'string' },
              },
            },
          },
          comment: {
            description: 'A comment on a Jira issue',
            metadataSchema: {
              type: 'object',
              properties: {
                updated_at: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };

  private readonly PAGE_SIZE = 100;
  private readonly MAX_PAGES = 50;

  // -------------------------------------------------------------------------
  // Live pushdown (virtual feeds) — read-only, never persisted.
  // query() runs the feed's base JQL; search() AND-composes text ~ terms.
  // -------------------------------------------------------------------------

  async query(ctx: QueryContext<JiraConfig>): Promise<QueryResult> {
    return this.liveSearch(ctx, []);
  }

  async search(ctx: SearchContext<JiraConfig>): Promise<QueryResult> {
    return this.liveSearch(ctx, ctx.terms ?? []);
  }

  /**
   * Shared live read against `/rest/api/3/search/jql`. Returns the stable issue
   * row shape; never persists events. Pagination: page until offset+limit issues
   * are collected, then slice (opaque nextPageToken has no random access).
   */
  private async liveSearch(
    ctx: QueryContext<JiraConfig>,
    terms: string[],
  ): Promise<QueryResult> {
    if (!ctx.credentials?.accessToken) {
      throw new Error('Jira virtual-feed reads require Atlassian OAuth credentials.');
    }

    // Platform stores the scope fence in config.query; ctx.query is that value.
    // Fall back to legacy config.jql so older feed configs still work live.
    const baseQuery =
      asString(ctx.query) ?? asString(ctx.config.query) ?? asString(ctx.config.jql) ?? '';

    const jql = buildJiraJql({
      baseQuery,
      terms,
      sort: ctx.sort,
    });

    const limit = Math.min(
      Math.max(Math.trunc(ctx.limit ?? ctx.config.max_results ?? 50), 1),
      100,
    );
    const offset = Math.max(Math.trunc(ctx.offset ?? 0), 0);
    const want = offset + limit;

    const base = await this.restBase(ctx.config, ctx.sessionState, ctx.credentials);
    const http = this.client(ctx.credentials);

    const collected: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    let pages = 0;

    while (collected.length < want && pages < this.MAX_PAGES) {
      pages += 1;
      const pageSize = Math.min(this.PAGE_SIZE, want - collected.length);
      const params = new URLSearchParams({
        jql,
        maxResults: String(pageSize),
        fields: ISSUE_FIELDS,
      });
      if (nextPageToken) params.set('nextPageToken', nextPageToken);

      const data = await http.json<JiraSearchResponse>(
        `${base}/search/jql?${params.toString()}`,
        { method: 'GET', headers: { Accept: 'application/json' } },
      );
      const issues = data.issues ?? [];
      collected.push(...issues);
      // Empty page or no further cursor → done (same degenerate-cursor guard as sync).
      if (issues.length === 0 || !data.nextPageToken) break;
      nextPageToken = data.nextPageToken;
    }

    const page = collected.slice(offset, offset + limit);
    const rows = page.map((issue) => this.issueRow(issue)).filter((r) => r !== null);

    // No reliable total from /search/jql — omit rather than lie with page length.
    return { rows, columns: [...JIRA_ISSUE_COLUMNS] };
  }

  // -------------------------------------------------------------------------
  // sync (collected feeds only — virtual feeds never call this)
  // -------------------------------------------------------------------------

  async sync(ctx: SyncContext<JiraCheckpoint, JiraConfig>): Promise<SyncResult<JiraCheckpoint>> {
    const base = await this.restBase(ctx.config, ctx.sessionState, ctx.credentials);
    const http = this.client(ctx.credentials);
    const lookbackDays = ctx.config.lookback_days ?? 365;
    const jql = buildJiraJql({
      baseQuery: asString(ctx.config.query) ?? asString(ctx.config.jql) ?? '',
      defaultWhenEmpty: `updated >= -${lookbackDays}d`,
    });

    const events: EventEnvelope[] = [];

    // `/rest/api/3/search` was removed by Atlassian (CHANGE-2046); the
    // replacement `/search/jql` paginates with an opaque nextPageToken and
    // returns no total — iterate until the token is absent.
    const pages = paginateByCursor<JiraIssue, string>(
      async (nextPageToken) => {
        const params = new URLSearchParams({
          jql,
          maxResults: String(this.PAGE_SIZE),
          fields: ISSUE_FIELDS,
        });
        if (nextPageToken) params.set('nextPageToken', nextPageToken);
        const data = await http.json<JiraSearchResponse>(
          `${base}/search/jql?${params.toString()}`,
          { method: 'GET', headers: { Accept: 'application/json' } },
        );
        return { items: data.issues ?? [], nextCursor: data.nextPageToken };
      },
      { maxPages: this.MAX_PAGES },
    );

    for await (const issues of pages) {
      for (const issue of issues) {
        const event = this.issueEvent(issue);
        if (event) events.push(event);
      }
      // Preserve the original early-exit on an empty page even when a token is
      // returned — guards against a degenerate self-referential cursor.
      if (issues.length === 0) break;
    }

    return {
      events,
      checkpoint: { last_sync_at: new Date().toISOString() },
      metadata: { items_found: events.length },
    };
  }

  // -------------------------------------------------------------------------
  // Webhooks (subscription lifecycle — raw deliveries land downstream)
  // -------------------------------------------------------------------------

  async registerWebhook(
    ctx: WebhookRegistrationContext<JiraConfig>,
  ): Promise<WebhookRegistration> {
    const base = await this.restBase(ctx.config, ctx.sessionState, ctx.credentials);
    const http = this.client(ctx.credentials);
    const secret = randomBytes(32).toString('hex');
    // Bound the filter — unbounded JQL can fail webhook create the same way
    // /search/jql rejects empty windows.
    const jql =
      asString(ctx.config.query) ?? asString(ctx.config.jql) ?? 'updated >= -90d';

    const response = await http.json<{
      webhookRegistrationResult?: Array<{ createdWebhookId?: number; errors?: string[] }>;
    }>(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        url: ctx.callbackUrl,
        webhooks: [
          {
            jqlFilter: jql,
            events: ['jira:issue_created', 'jira:issue_updated', 'comment_created'],
          },
        ],
        // Jira HMAC-signs deliveries with this secret when supplied.
        secret,
      }),
    });

    const result = response.webhookRegistrationResult?.[0];
    const id = result?.createdWebhookId;
    if (id == null) {
      const errors = result?.errors?.join('; ') ?? 'no webhook id returned';
      throw new Error(`Jira webhook registration failed: ${errors}`);
    }

    return { externalId: String(id), secret };
  }

  async unregisterWebhook(ctx: WebhookRegistrationContext<JiraConfig>): Promise<void> {
    const externalId = ctx.externalId;
    if (!externalId) return;

    const base = await this.restBase(ctx.config, ctx.sessionState, ctx.credentials);
    const http = this.client(ctx.credentials);

    await http.request(`${base}/webhook`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ webhookIds: [Number(externalId)] }),
    });
  }

  // -------------------------------------------------------------------------
  // Mapping helpers
  // -------------------------------------------------------------------------

  private issueRow(issue: JiraIssue | undefined): Record<string, unknown> | null {
    if (!issue?.id) return null;
    const fields = issue.fields ?? {};
    const labels = Array.isArray(fields.labels) ? fields.labels.join(', ') : null;
    return {
      id: issue.id,
      key: issue.key ?? null,
      summary: fields.summary ?? null,
      status: fields.status?.name ?? null,
      assignee: actorName(fields.assignee) ?? null,
      reporter: actorName(fields.reporter) ?? null,
      priority: fields.priority?.name ?? null,
      project_key: fields.project?.key ?? null,
      project_name: fields.project?.name ?? null,
      labels,
      created_at: fields.created ?? null,
      updated_at: fields.updated ?? null,
      description: adfToText(fields.description) || null,
      url: this.issueUrl(issue) ?? null,
    };
  }

  private issueEvent(issue: JiraIssue | undefined): EventEnvelope | null {
    if (!issue?.id) return null;
    const fields = issue.fields ?? {};
    const createdAt = new Date(fields.created ?? fields.updated ?? Date.now());
    if (Number.isNaN(createdAt.getTime())) return null;

    return {
      origin_id: `jira_issue_${issue.id}`,
      title: fields.summary ?? issue.key ?? undefined,
      payload_text: adfToText(fields.description),
      author_name: actorName(fields.reporter ?? fields.assignee),
      source_url: this.issueUrl(issue),
      occurred_at: createdAt,
      origin_type: 'issue',
      metadata: {
        key: issue.key ?? null,
        status: fields.status?.name ?? null,
        assignee: actorName(fields.assignee) ?? null,
        reporter: actorName(fields.reporter) ?? null,
        updated_at: fields.updated ?? null,
      },
    };
  }

  private issueUrl(issue: JiraIssue | undefined): string | undefined {
    return issue?.self ?? undefined;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * Resolve REST base. Prefer config/session cloud_id (stamped at OAuth onto
   * connection.config and merged by the platform). If still missing, call
   * accessible-resources with the live access token — covers reconnects and
   * older connections that predate auto-stamp.
   */
  private async restBase(
    config: JiraConfig,
    sessionState: Record<string, unknown> | null | undefined,
    credentials: SyncCredentials | null | undefined,
  ): Promise<string> {
    const cloudId = await this.resolveCloudId(config, sessionState, credentials);
    return `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
  }

  private async resolveCloudId(
    config: JiraConfig,
    sessionState: Record<string, unknown> | null | undefined,
    credentials: SyncCredentials | null | undefined,
  ): Promise<string> {
    const fromConfig = asString(config.cloud_id) ?? asString(sessionState?.cloud_id);
    if (fromConfig) return fromConfig;

    if (!credentials?.accessToken) {
      throw new Error(
        'Jira requires a cloud_id (auto-set on the connection after OAuth, or set config.cloud_id).',
      );
    }

    const http = this.client(credentials);
    const resources = await http.json<
      Array<{ id?: string; url?: string; name?: string; scopes?: string[] }>
    >('https://api.atlassian.com/oauth/token/accessible-resources', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!Array.isArray(resources) || resources.length === 0) {
      throw new Error(
        'Jira OAuth token has no accessible Atlassian Cloud sites. Reconnect and grant access to a Jira site.',
      );
    }

    const jiraScoped =
      resources.find(
        (r) =>
          typeof r.id === 'string' &&
          Array.isArray(r.scopes) &&
          r.scopes.some((s) => typeof s === 'string' && s.includes('jira')),
      ) ?? resources.find((r) => typeof r.id === 'string' && r.id.trim().length > 0);

    const id = asString(jiraScoped?.id);
    if (!id) {
      throw new Error(
        'Jira accessible-resources returned no usable cloud id. Reconnect the Jira connection.',
      );
    }

    // Cache on this job's config so subsequent calls in the same run skip the hop.
    config.cloud_id = id;
    if (asString(jiraScoped?.url)) config.site_url = asString(jiraScoped?.url);
    if (asString(jiraScoped?.name)) config.site_name = asString(jiraScoped?.name);
    return id;
  }

  private client(credentials: SyncCredentials | null) {
    return requireBearerClient(credentials, {
      errorPrefix: 'Jira API',
      label: 'Jira',
    });
  }
}
