/**
 * Linear Connector (V1 runtime)
 *
 * Syncs Linear issues via the GraphQL API and subscribes to real-time
 * Issue/Comment deliveries via inbound webhooks (registered at connect time);
 * the raw deliveries are landed downstream (extract-load), so this connector
 * only owns the subscription lifecycle here.
 */

import { randomBytes } from 'node:crypto';
import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
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

interface LinearConfig {
  /** Optional team filter (Linear team key, e.g. "ENG"). */
  team_key?: string;
  lookback_days?: number;
}

interface LinearCheckpoint {
  last_sync_at?: string;
}

interface LinearUser {
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
}

interface LinearWorkflowState {
  name?: string | null;
  type?: string | null;
}

interface LinearIssueNode {
  id: string;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  state?: LinearWorkflowState | null;
  assignee?: LinearUser | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

const GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

function actorName(user: LinearUser | null | undefined): string | undefined {
  return user?.displayName ?? user?.name ?? user?.email ?? undefined;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class LinearConnector extends ConnectorRuntime<LinearCheckpoint, LinearConfig> {
  readonly definition: ConnectorDefinition = {
    key: 'linear',
    name: 'Linear',
    description: 'Syncs Linear issues and receives real-time issue/comment webhooks.',
    version: '1.0.0',
    faviconDomain: 'linear.app',
    webhook: {
      signatureHeader: 'linear-signature',
      algorithm: 'sha256',
      // Linear signs the raw body with HMAC-SHA256 and sends a bare hex digest
      // (no `sha256=` prefix). It does not send a stable delivery id header, so
      // dedupe falls back to a body hash (no `dedupeHeader`).
    },
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'linear',
          requiredScopes: ['read'],
          optionalScopes: ['write'],
          authorizationUrl: 'https://linear.app/oauth/authorize',
          tokenUrl: 'https://api.linear.app/oauth/token',
          tokenEndpointAuthMethod: 'client_secret_post',
          clientIdKey: 'LINEAR_CLIENT_ID',
          clientSecretKey: 'LINEAR_CLIENT_SECRET',
          required: true,
          description: 'Linear OAuth enables reading issues and registering webhooks.',
          setupInstructions:
            'Create an OAuth application in Linear Settings > API > OAuth applications. Set the redirect URL to {{redirect_uri}}, then copy the client ID and client secret below.',
        },
      ],
    },
    feeds: {
      issues: {
        key: 'issues',
        name: 'Issues',
        description: 'Sync Linear issues.',
        configSchema: {
          type: 'object',
          properties: {
            team_key: {
              type: 'string',
              description: 'Optional Linear team key filter (e.g. "ENG").',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 730,
              default: 365,
              description: 'Initial sync lookback window.',
            },
          },
        },
        eventKinds: {
          issue: {
            description: 'A Linear issue',
            metadataSchema: {
              type: 'object',
              properties: {
                identifier: { type: 'string' },
                state: { type: 'string' },
                state_type: { type: 'string' },
                assignee: { type: 'string' },
                updated_at: { type: 'string' },
              },
            },
          },
          comment: {
            description: 'A comment on a Linear issue',
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

  private readonly PAGE_SIZE = 50;
  private readonly MAX_PAGES = 50;

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  async sync(ctx: SyncContext<LinearCheckpoint, LinearConfig>): Promise<SyncResult<LinearCheckpoint>> {
    const events: EventEnvelope[] = [];
    let cursor: string | null = null;
    let pages = 0;

    const filter = ctx.config.team_key
      ? `, filter: { team: { key: { eq: ${JSON.stringify(ctx.config.team_key)} } } }`
      : '';

    while (pages < this.MAX_PAGES) {
      const after: string = cursor ? `, after: ${JSON.stringify(cursor)}` : '';
      const query: string = `
        query {
          issues(first: ${this.PAGE_SIZE}${after}, orderBy: updatedAt${filter}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              identifier
              title
              description
              url
              state { name type }
              assignee { name displayName email }
              createdAt
              updatedAt
            }
          }
        }
      `;

      const response = await this.graphql<{
        issues?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: LinearIssueNode[];
        };
      }>(ctx.credentials, query);

      const nodes = response.issues?.nodes ?? [];
      for (const node of nodes) {
        const event = this.issueEvent(node);
        if (event) events.push(event);
      }

      pages += 1;
      const pageInfo = response.issues?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      cursor = pageInfo.endCursor;
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
    ctx: WebhookRegistrationContext<LinearConfig>
  ): Promise<WebhookRegistration> {
    const secret = randomBytes(32).toString('hex');
    const mutation = `
      mutation {
        webhookCreate(input: {
          url: ${JSON.stringify(ctx.callbackUrl)},
          resourceTypes: ["Issue", "Comment"],
          secret: ${JSON.stringify(secret)},
          enabled: true
        }) {
          success
          webhook { id }
        }
      }
    `;

    const response = await this.graphql<{
      webhookCreate?: { success?: boolean; webhook?: { id?: string } };
    }>(ctx.credentials, mutation);

    const id = response.webhookCreate?.webhook?.id;
    if (!id) {
      throw new Error('Linear webhookCreate did not return a webhook id.');
    }

    return { externalId: id, secret };
  }

  async unregisterWebhook(ctx: WebhookRegistrationContext<LinearConfig>): Promise<void> {
    const externalId = ctx.externalId;
    if (!externalId) return;

    const mutation = `
      mutation {
        webhookDelete(id: ${JSON.stringify(externalId)}) { success }
      }
    `;

    await this.graphql<{ webhookDelete?: { success?: boolean } }>(ctx.credentials, mutation);
  }

  // -------------------------------------------------------------------------
  // Mapping helpers
  // -------------------------------------------------------------------------

  private issueEvent(node: LinearIssueNode | null): EventEnvelope | null {
    if (!node?.id) return null;
    const createdAt = new Date(node.createdAt ?? node.updatedAt ?? Date.now());
    if (Number.isNaN(createdAt.getTime())) return null;

    return {
      origin_id: `linear_issue_${node.id}`,
      title: node.title ?? node.identifier ?? undefined,
      payload_text: (node.description ?? '').trim(),
      author_name: actorName(node.assignee),
      source_url: node.url ?? undefined,
      occurred_at: createdAt,
      origin_type: 'issue',
      metadata: {
        identifier: node.identifier ?? null,
        state: node.state?.name ?? null,
        state_type: node.state?.type ?? null,
        assignee: actorName(node.assignee) ?? null,
        updated_at: node.updatedAt ?? null,
      },
    };
  }

  // -------------------------------------------------------------------------
  // GraphQL transport
  // -------------------------------------------------------------------------

  private async graphql<T>(
    credentials: SyncCredentials | null,
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const http = requireBearerClient(credentials, {
      errorPrefix: 'Linear API',
      label: 'Linear',
    });
    const response = await http.json<{ data?: T; errors?: Array<{ message?: string }> }>(
      GRAPHQL_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: variables ?? {} }),
      }
    );

    if (response.errors?.length) {
      throw new Error(`Linear GraphQL error: ${response.errors.map((e) => e.message).join('; ')}`);
    }
    return (response.data ?? {}) as T;
  }
}
