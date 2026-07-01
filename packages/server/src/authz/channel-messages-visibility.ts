/**
 * Channel-membership gate for the `channel_messages` read seam — the SQL analog
 * of `./channel-visibility`'s `filterChannelsForRequester`, expressed as a WHERE
 * fragment so raw-SQL callers (watcher @feed sources, query_sql) read chat
 * transcripts with the same fail-closed membership contract.
 *
 * Rule (mirrors `compileResourceVisibility`, but keyed on the channel identity
 * rather than `events.entity_ids`, because `channel_messages` carries no
 * entity_ids):
 *   - a row on a connection that is NOT ACL-enforced is unconstrained (legacy
 *     fence / org-open — the same passthrough the whole authz program uses for
 *     not-graphed connections);
 *   - a row on an ACL-enforced connection is visible ONLY when the requester is
 *     `member_of` the `channel` entity keyed `slack_channel_id = UPPER(team:chan)`,
 *     where the team is resolved from the row's connection.
 *
 * Fail-closed: a headless/null principal, or an enforced channel the requester
 * doesn't belong to, sees nothing. This is what makes a (headless) watcher run
 * safe to read a streaming @feed — it reads only non-enforced channels; enforced
 * ones return zero rows, so their content never reaches the shared recap.
 *
 * Requester resolution is the auth-signup `$member` claim only (same as
 * `compileResourceVisibility`) — the recap/query_sql reader is a web/app user, not
 * an in-Slack author, so the `slack_user_id` fallback isn't needed on this seam.
 */

import { enforcedConnectionsSelectSql } from './acl-state.js';
import type { AuthzScope } from './scope.js';

/**
 * Predicate for a `channel_messages` table (alias has `connection_id` [text
 * runtime id], `channel_id` [bare], `organization_id`). Binds two params from
 * `baseParamIndex`: the org id and the principal. Returns an `AND (...)` fragment
 * (no leading space).
 *
 * `channel_messages.connection_id` and `authz_source_acl_state.connection_id` are
 * BOTH the runtime connection id (see `slack-acl-sync`/`persistChannelMessage`),
 * so the enforced-set membership check compares like-for-like. The channel entity
 * is team-scoped (`T:C`), so the team is resolved from the row's connection
 * (`external_tenant_id` / `config.chatMetadata.teamId`), matched by slug via both
 * the BYO (`agentconn-<id>`) and slack-install (`<id>`) namespaces.
 */
export function compileChannelMessagesVisibility(
  scope: AuthzScope,
  baseParamIndex: number,
  tableAlias: string,
): { sql: string; params: Array<string | null> } {
  const orgParam = `$${baseParamIndex}::text`;
  const userParam = `$${baseParamIndex + 1}::text`;

  const sql = `AND (
      ${tableAlias}.connection_id NOT IN (${enforcedConnectionsSelectSql(orgParam)})
      OR EXISTS (
        SELECT 1
        FROM public.connections conn
        JOIN public.entity_identities cei
          ON cei.organization_id = ${orgParam}
         AND cei.namespace = 'slack_channel_id'
         AND cei.deleted_at IS NULL
         AND cei.identifier = UPPER(
           COALESCE(
             ${tableAlias}.team_id,
             conn.external_tenant_id,
             conn.config->'chatMetadata'->>'teamId'
           ) || ':' || ${tableAlias}.channel_id
         )
        JOIN public.entity_relationships rr
          ON rr.organization_id = ${orgParam}
         AND rr.to_entity_id = cei.entity_id
         AND rr.deleted_at IS NULL
        JOIN public.entity_relationship_types rt
          ON rt.id = rr.relationship_type_id
         AND rt.organization_id = rr.organization_id
         AND rt.slug = 'member_of'
        WHERE conn.organization_id = ${orgParam}
          AND conn.slug IN (${tableAlias}.connection_id, 'agentconn-' || ${tableAlias}.connection_id)
          AND rr.from_entity_id = (
            SELECT mei.entity_id
            FROM public.entity_identities mei
            JOIN public.entities me
              ON me.id = mei.entity_id
             AND me.organization_id = mei.organization_id
             AND me.deleted_at IS NULL
            JOIN public.entity_types met
              ON met.id = me.entity_type_id
             AND met.organization_id = me.organization_id
             AND met.slug = '$member'
            WHERE mei.organization_id = ${orgParam}
              AND mei.namespace = 'auth_user_id'
              AND mei.identifier = ${userParam}
              AND mei.source_connector = 'auth:signup'
              AND mei.deleted_at IS NULL
            LIMIT 1
          )
      )
    )`;
  return { sql, params: [scope.organizationId, scope.principal] };
}
