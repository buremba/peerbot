/**
 * Jira Connector (V1 runtime)
 *
 * Syncs Jira Cloud issues via the REST v3 API (Atlassian 3LO OAuth) and
 * subscribes to real-time issue/comment deliveries via Jira dynamic webhooks
 * (registered at connect time); the raw deliveries are landed downstream
 * (extract-load), so this connector only owns the subscription lifecycle here.
 */

import { randomBytes } from 'node:crypto';
import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  paginateByCursor,
  requireBearerClient,
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
   * Atlassian Cloud id for the target site. The Atlassian REST base is
   * `https://api.atlassian.com/ex/jira/{cloudId}/...`.
   * NOTE: other Atlassian connectors don't yet exist in this repo to mirror, so
   * we accept `cloud_id` from config and also fall back to
   * `sessionState.cloud_id` / `credentials.scope` style hints if present.
   */
  cloud_id?: string;
  /** Optional JQL filter. Defaults to `updated >= -{lookback_days}d`. */
  jql?: string;
  lookback_days?: number;
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

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class JiraConnector extends ConnectorRuntime<JiraCheckpoint, JiraConfig> {
  readonly definition: ConnectorDefinition = {
    key: 'jira',
    name: 'Jira',
    description: 'Syncs Jira Cloud issues and receives real-time issue/comment webhooks.',
    version: '1.0.0',
    faviconDomain: 'atlassian.com',
    webhook: {
      // Jira dynamic webhooks HMAC-sign the raw body with the registration
      // secret and send `x-hub-signature: sha256=<hex>`. Jira does not send a
      // stable delivery id header, so dedupe falls back to a body hash
      // (no `dedupeHeader`).
      signatureHeader: 'x-hub-signature',
      algorithm: 'sha256',
      signaturePrefix: 'sha256=',
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
        description: 'Sync Jira issues via JQL.',
        configSchema: {
          type: 'object',
          properties: {
            cloud_id: {
              type: 'string',
              description: 'Atlassian Cloud id for the target Jira site.',
            },
            jql: {
              type: 'string',
              description: 'Optional JQL filter. Defaults to recently-updated issues.',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 730,
              default: 365,
              description: 'Initial sync lookback window (used when jql is unset).',
            },
          },
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
  // sync
  // -------------------------------------------------------------------------

  async sync(ctx: SyncContext<JiraCheckpoint, JiraConfig>): Promise<SyncResult<JiraCheckpoint>> {
    const base = this.restBase(ctx.config, ctx.sessionState);
    const http = this.client(ctx.credentials);
    const lookbackDays = ctx.config.lookback_days ?? 365;
    const jql = ctx.config.jql ?? `updated >= -${lookbackDays}d order by updated DESC`;

    const events: EventEnvelope[] = [];

    // `/rest/api/3/search` was removed by Atlassian (CHANGE-2046); the
    // replacement `/search/jql` paginates with an opaque nextPageToken and
    // returns no total — iterate until the token is absent.
    const pages = paginateByCursor<JiraIssue, string>(
      async (nextPageToken) => {
        const params = new URLSearchParams({
          jql,
          maxResults: String(this.PAGE_SIZE),
          fields: 'summary,description,status,assignee,reporter,created,updated',
        });
        if (nextPageToken) params.set('nextPageToken', nextPageToken);
        const data = await http.json<JiraSearchResponse>(
          `${base}/search/jql?${params.toString()}`,
          { method: 'GET', headers: { Accept: 'application/json' } }
        );
        return { items: data.issues ?? [], nextCursor: data.nextPageToken };
      },
      { maxPages: this.MAX_PAGES }
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
    ctx: WebhookRegistrationContext<JiraConfig>
  ): Promise<WebhookRegistration> {
    const base = this.restBase(ctx.config, ctx.sessionState);
    const http = this.client(ctx.credentials);
    const secret = randomBytes(32).toString('hex');
    const jql = ctx.config.jql ?? 'order by updated DESC';

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

    const base = this.restBase(ctx.config, ctx.sessionState);
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

  private restBase(
    config: JiraConfig,
    sessionState: Record<string, unknown> | null | undefined
  ): string {
    const cloudId = asString(config.cloud_id) ?? asString(sessionState?.cloud_id);
    if (!cloudId) {
      throw new Error(
        'Jira requires a cloud_id (set config.cloud_id, the Atlassian Cloud id for the target site).'
      );
    }
    return `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
  }

  private client(credentials: SyncCredentials | null) {
    return requireBearerClient(credentials, {
      errorPrefix: 'Jira API',
      label: 'Jira',
    });
  }
}
