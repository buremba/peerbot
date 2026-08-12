import {
  connectorFromFile,
  defineAgent,
  defineAuthProfile,
  defineBehavior,
  defineConfig,
  defineConnection,
  reactionFromFile,
  secret,
} from "@lobu/cli/config";
import type LokiActivityConnector from "./loki-activity.connector.ts";
import type productActivityDigestReaction from "./product-activity-digest.reaction.ts";

const productOps = defineAgent({
  id: "product-ops",
  name: "product-ops",
  description:
    "Runs Lobu Team's scheduled production activity digest from organization-owned connections",
  providers: [{ id: "qwen", model: "qwen3.8-max" }],
});

// Adopt the existing Lobu Team read-only grant. Credentials are intentionally
// omitted: apply preserves the live secret instead of rotating it from source.
const productActivityDbAuth = defineAuthProfile({
  slug: "lobu-prod-db-read-only",
  connector: "postgres",
  authKind: "env",
  name: "Lobu Prod DB (read-only)",
});

const productActivityDb = defineConnection({
  // A Postgres connection can instantiate its `query` feed once. Keep the
  // existing churn feed intact and reuse its auth profile on this connection.
  slug: "lobu-product-activity-db",
  connector: "postgres",
  name: "Lobu Prod DB — product activity",
  authProfile: productActivityDbAuth,
  feeds: [
    {
      feed: "query",
      name: "Lobu production activity",
      schedule: "2,22,42 * * * *",
      config: {
        primary_key: "activity_id",
        cursor_column: "occurred_at",
        max_rows_per_sync: 5000,
        // Base SELECT only — the connector adds keyset WHERE/ORDER/LIMIT.
        query: `SELECT *
          FROM (
            SELECT
              'signup:' || u.id AS activity_id,
              u."createdAt" AS occurred_at,
              'signup'::text AS activity_type,
              'New signup'::text AS title,
              concat_ws(' · ', coalesce(nullif(u.name, ''), 'Unnamed user'), u.email) AS payload_text,
              u.id AS user_id,
              u.name AS user_name,
              u.email,
              coalesce((
                SELECT string_agg(DISTINCT o.name, ', ' ORDER BY o.name)
                FROM member m
                JOIN organization o ON o.id = m."organizationId"
                WHERE m."userId" = u.id
              ), 'No organization') AS organization_name,
              NULL::text AS connector_key,
              NULL::text AS connection_name,
              NULL::text AS client_software_id,
              NULL::text AS last_action,
              NULL::bigint AS call_count,
              NULL::bigint AS failed_count
            FROM "user" u
            WHERE coalesce(u.principal_kind, 'human') = 'human'
              AND u."createdAt" > now() - interval '24 hours'

            UNION ALL

            SELECT
              'login:' || s.id AS activity_id,
              s."createdAt" AS occurred_at,
              'login'::text AS activity_type,
              'User login'::text AS title,
              concat_ws(' · ', coalesce(nullif(u.name, ''), 'Unnamed user'), u.email) AS payload_text,
              u.id AS user_id,
              u.name AS user_name,
              u.email,
              coalesce((
                SELECT string_agg(DISTINCT o.name, ', ' ORDER BY o.name)
                FROM member m
                JOIN organization o ON o.id = m."organizationId"
                WHERE m."userId" = u.id
              ), 'No organization') AS organization_name,
              NULL::text AS connector_key,
              NULL::text AS connection_name,
              NULL::text AS client_software_id,
              NULL::text AS last_action,
              NULL::bigint AS call_count,
              NULL::bigint AS failed_count
            FROM session s
            JOIN "user" u ON u.id = s."userId"
            WHERE coalesce(u.principal_kind, 'human') = 'human'
              AND s."createdAt" > now() - interval '24 hours'

            UNION ALL

            SELECT
              'connection:' || c.id AS activity_id,
              c.created_at AS occurred_at,
              'connection'::text AS activity_type,
              'New connection'::text AS title,
              concat_ws(' · ', c.connector_key, coalesce(nullif(c.display_name, ''), 'Unnamed connection'), o.name) AS payload_text,
              u.id AS user_id,
              u.name AS user_name,
              u.email,
              o.name AS organization_name,
              c.connector_key,
              c.display_name AS connection_name,
              NULL::text AS client_software_id,
              NULL::text AS last_action,
              NULL::bigint AS call_count,
              NULL::bigint AS failed_count
            FROM connections c
            JOIN organization o ON o.id = c.organization_id
            LEFT JOIN "user" u ON u.id = c.created_by
            WHERE c.deleted_at IS NULL
              AND c.created_at > now() - interval '24 hours'

            UNION ALL

            SELECT
              concat_ws(':', 'mcp', m.organization_id, m.client_identity, m.conversation_id) AS activity_id,
              m.last_activity_at AS occurred_at,
              'mcp_conversation'::text AS activity_type,
              'MCP activity'::text AS title,
              concat_ws(' · ', coalesce(m.client_software_id, 'Unknown client'), o.name, u.email) AS payload_text,
              u.id AS user_id,
              u.name AS user_name,
              u.email,
              o.name AS organization_name,
              NULL::text AS connector_key,
              NULL::text AS connection_name,
              m.client_software_id,
              m.last_action,
              m.call_count,
              m.failed_count
            FROM mcp_client_conversations m
            JOIN organization o ON o.id = m.organization_id
            LEFT JOIN "user" u ON u.id = m.user_id
            WHERE m.call_count > 0
              AND m.last_activity_at > now() - interval '24 hours'
          ) activity`,
        mapping: {
          title: "title",
          occurred_at: "occurred_at",
          payload_text: "payload_text",
        },
      },
    },
  ],
});

const productionLogsAuth = defineAuthProfile({
  slug: "lobu-production-loki",
  connector: "loki.activity",
  authKind: "env",
  name: "Lobu production Loki",
  credentials: {
    LOKI_URL: secret("LOBU_PRODUCT_OPS_LOKI_URL"),
  },
});

const productionLogs = defineConnection({
  slug: "lobu-production-logs",
  connector: "loki.activity",
  name: "Lobu production Kubernetes logs",
  authProfile: productionLogsAuth,
  config: {
    namespace: "summaries-prod",
    grafana_url:
      "https://monitoring-kube-prometheus-stack-grafana.brill-kanyu.ts.net",
  },
  feeds: [
    {
      feed: "activity",
      name: "Lobu production log activity",
      schedule: "3,23,43 * * * *",
      config: {},
    },
  ],
});

const productActivityDigest = defineBehavior({
  agent: productOps,
  slug: "product-activity-digest",
  name: "Lobu production activity digest",
  description:
    "Every 20 minutes, summarize new signups, logins, connections, MCP clients, and Kubernetes log activity; stay silent when nothing happened.",
  triggers: [
    {
      kind: "schedule",
      cron: "5,25,45 * * * *",
      skip_if_unchanged: false,
    },
  ],
  notification: { channel: "canvas", priority: "normal" },
  minCooldownSeconds: 60,
  tags: ["product-ops", "production", "slack"],
  prompt:
    'This scheduled Behavior is implemented by its deterministic reaction. Return exactly {"run":true}.',
  reactionsGuidance:
    "The reaction reads the organization-owned production activity feeds, sends one rich digest when activity exists, and sends nothing for an empty window.",
  reaction: reactionFromFile<typeof productActivityDigestReaction>(
    "./product-activity-digest.reaction.ts"
  ),
});

export default defineConfig({
  org: "lobu-team",
  orgName: "Lobu Team",
  orgDescription: "Lobu Team's organization-owned production activity digest",
  organizationId: "UdNAH1bb3csC842vhOgxAHVcfX4tYU5A",
  connectors: [
    connectorFromFile<typeof LokiActivityConnector>(
      "./loki-activity.connector.ts"
    ),
  ],
  agents: [productOps],
  authProfiles: [productActivityDbAuth, productionLogsAuth],
  connections: [
    productActivityDb,
    productionLogs,
    defineConnection({
      slug: "lobu-product-activity-slack",
      connector: "slack",
      credentialMode: "hosted",
      surfaces: ["channel"],
      codeTtlMinutes: 15,
    }),
  ],
  behaviors: [productActivityDigest],
});
