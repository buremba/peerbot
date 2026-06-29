import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);

// ../connectors/src/linear.ts
import { randomBytes } from "node:crypto";
import {
  ConnectorRuntime,
  requireBearerClient
} from "@lobu/connector-sdk";
var GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
function actorName(user) {
  return user?.displayName ?? user?.name ?? user?.email ?? void 0;
}
var LinearConnector = class extends ConnectorRuntime {
  definition = {
    key: "linear",
    name: "Linear",
    description: "Syncs Linear issues and receives real-time issue/comment webhooks.",
    version: "1.0.0",
    faviconDomain: "linear.app",
    webhook: {
      signatureHeader: "linear-signature",
      algorithm: "sha256",
      // Linear signs the raw body with HMAC-SHA256 and sends a bare hex digest
      // (no `sha256=` prefix). It does not send a stable delivery id header, so
      // dedupe falls back to a body hash (no `dedupeHeader`).
      // App-installation delivery: one webhook configured ONCE on the Linear app;
      // every delivery carries the workspace `organizationId` — that's the tenant.
      delivery: "app_installation",
      routingKeyPath: "organizationId"
    },
    authSchema: {
      methods: [
        {
          type: "oauth",
          provider: "linear",
          requiredScopes: ["read"],
          optionalScopes: ["write"],
          authorizationUrl: "https://linear.app/oauth/authorize",
          tokenUrl: "https://api.linear.app/oauth/token",
          tokenEndpointAuthMethod: "client_secret_post",
          clientIdKey: "LINEAR_CLIENT_ID",
          clientSecretKey: "LINEAR_CLIENT_SECRET",
          required: true,
          description: "Linear OAuth enables reading issues and registering webhooks.",
          setupInstructions: "Create an OAuth application in Linear Settings > API > OAuth applications. Set the redirect URL to {{redirect_uri}}, then copy the client ID and client secret below."
        }
      ]
    },
    feeds: {
      issues: {
        key: "issues",
        name: "Issues",
        description: "Sync Linear issues.",
        configSchema: {
          type: "object",
          properties: {
            team_key: {
              type: "string",
              description: 'Optional Linear team key filter (e.g. "ENG").'
            },
            lookback_days: {
              type: "integer",
              minimum: 1,
              maximum: 730,
              default: 365,
              description: "Initial sync lookback window."
            }
          }
        },
        eventKinds: {
          issue: {
            description: "A Linear issue",
            metadataSchema: {
              type: "object",
              properties: {
                identifier: { type: "string" },
                state: { type: "string" },
                state_type: { type: "string" },
                assignee: { type: "string" },
                updated_at: { type: "string" }
              }
            }
          },
          comment: {
            description: "A comment on a Linear issue",
            metadataSchema: {
              type: "object",
              properties: {
                updated_at: { type: "string" }
              }
            }
          }
        }
      }
    }
  };
  PAGE_SIZE = 50;
  MAX_PAGES = 50;
  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------
  async sync(ctx) {
    const events = [];
    let cursor = null;
    let pages = 0;
    const filter = ctx.config.team_key ? `, filter: { team: { key: { eq: ${JSON.stringify(ctx.config.team_key)} } } }` : "";
    while (pages < this.MAX_PAGES) {
      const after = cursor ? `, after: ${JSON.stringify(cursor)}` : "";
      const query = `
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
      const response = await this.graphql(ctx.credentials, query);
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
      checkpoint: { last_sync_at: (/* @__PURE__ */ new Date()).toISOString() },
      metadata: { items_found: events.length }
    };
  }
  // -------------------------------------------------------------------------
  // Webhooks (subscription lifecycle — raw deliveries land downstream)
  // -------------------------------------------------------------------------
  async registerWebhook(ctx) {
    const secret = randomBytes(32).toString("hex");
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
    const response = await this.graphql(ctx.credentials, mutation);
    const id = response.webhookCreate?.webhook?.id;
    if (!id) {
      throw new Error("Linear webhookCreate did not return a webhook id.");
    }
    return { externalId: id, secret };
  }
  async unregisterWebhook(ctx) {
    const externalId = ctx.externalId;
    if (!externalId) return;
    const mutation = `
      mutation {
        webhookDelete(id: ${JSON.stringify(externalId)}) { success }
      }
    `;
    await this.graphql(ctx.credentials, mutation);
  }
  // -------------------------------------------------------------------------
  // Mapping helpers
  // -------------------------------------------------------------------------
  issueEvent(node) {
    if (!node?.id) return null;
    const createdAt = new Date(node.createdAt ?? node.updatedAt ?? Date.now());
    if (Number.isNaN(createdAt.getTime())) return null;
    return {
      origin_id: `linear_issue_${node.id}`,
      title: node.title ?? node.identifier ?? void 0,
      payload_text: (node.description ?? "").trim(),
      author_name: actorName(node.assignee),
      source_url: node.url ?? void 0,
      occurred_at: createdAt,
      origin_type: "issue",
      metadata: {
        identifier: node.identifier ?? null,
        state: node.state?.name ?? null,
        state_type: node.state?.type ?? null,
        assignee: actorName(node.assignee) ?? null,
        updated_at: node.updatedAt ?? null
      }
    };
  }
  // -------------------------------------------------------------------------
  // GraphQL transport
  // -------------------------------------------------------------------------
  async graphql(credentials, query, variables) {
    const http = requireBearerClient(credentials, {
      errorPrefix: "Linear API",
      label: "Linear"
    });
    const response = await http.json(
      GRAPHQL_ENDPOINT,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: variables ?? {} })
      }
    );
    if (response.errors?.length) {
      throw new Error(`Linear GraphQL error: ${response.errors.map((e) => e.message).join("; ")}`);
    }
    return response.data ?? {};
  }
};
export {
  LinearConnector as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vVXNlcnMvYnVyYWtlbXJlL0NvZGUvbG9idS8uY2xhdWRlL3dvcmt0cmVlcy9jb25uZWN0aW9ucy11bmlmeS1zMmIvcGFja2FnZXMvY29ubmVjdG9ycy9zcmMvbGluZWFyLnRzIl0sCiAgIm1hcHBpbmdzIjogIjs7O0FBU0EsU0FBUyxtQkFBbUI7QUFDNUI7QUFBQSxFQUVFO0FBQUEsRUFFQTtBQUFBLE9BTUs7QUF1Q1AsSUFBTSxtQkFBbUI7QUFFekIsU0FBUyxVQUFVLE1BQXlEO0FBQzFFLFNBQU8sTUFBTSxlQUFlLE1BQU0sUUFBUSxNQUFNLFNBQVM7QUFDM0Q7QUFNQSxJQUFxQixrQkFBckIsY0FBNkMsaUJBQWlEO0FBQUEsRUFDbkYsYUFBa0M7QUFBQSxJQUN6QyxLQUFLO0FBQUEsSUFDTCxNQUFNO0FBQUEsSUFDTixhQUFhO0FBQUEsSUFDYixTQUFTO0FBQUEsSUFDVCxlQUFlO0FBQUEsSUFDZixTQUFTO0FBQUEsTUFDUCxpQkFBaUI7QUFBQSxNQUNqQixXQUFXO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLE1BTVgsVUFBVTtBQUFBLE1BQ1YsZ0JBQWdCO0FBQUEsSUFDbEI7QUFBQSxJQUNBLFlBQVk7QUFBQSxNQUNWLFNBQVM7QUFBQSxRQUNQO0FBQUEsVUFDRSxNQUFNO0FBQUEsVUFDTixVQUFVO0FBQUEsVUFDVixnQkFBZ0IsQ0FBQyxNQUFNO0FBQUEsVUFDdkIsZ0JBQWdCLENBQUMsT0FBTztBQUFBLFVBQ3hCLGtCQUFrQjtBQUFBLFVBQ2xCLFVBQVU7QUFBQSxVQUNWLHlCQUF5QjtBQUFBLFVBQ3pCLGFBQWE7QUFBQSxVQUNiLGlCQUFpQjtBQUFBLFVBQ2pCLFVBQVU7QUFBQSxVQUNWLGFBQWE7QUFBQSxVQUNiLG1CQUNFO0FBQUEsUUFDSjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsSUFDQSxPQUFPO0FBQUEsTUFDTCxRQUFRO0FBQUEsUUFDTixLQUFLO0FBQUEsUUFDTCxNQUFNO0FB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
