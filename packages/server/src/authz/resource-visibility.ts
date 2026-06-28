/**
 * THE generic resource-visibility compiler — gates connector-sourced `events`
 * (GitHub issues/PRs, Linear issues, …) by RESOURCE membership, the same way
 * `./channel-visibility` gates Slack chat by channel membership, but at the
 * `events` read seam and for ANY resource type at once.
 *
 * Rule, composed AFTER the per-connection visibility gate (they AND together):
 *   - an event on a connection that is NOT ACL-enforced is unconstrained here
 *     (the per-connection gate already decided it);
 *   - an event on an ACL-enforced connection is visible ONLY when the requester
 *     is `member_of` one of the RESOURCE entities the event is linked to
 *     (`events.entity_ids`), where "resource" = an entity whose type is a
 *     registered ACL resource (`RESOURCE_TYPE_SLUGS`: repo, channel, …). This is
 *     deliberately scoped to resource types so the coarse person→`company` (org)
 *     `member_of` edge never satisfies it — org membership must NOT grant
 *     repo-level read.
 *
 * Fail-closed: a headless/null principal, or an enforced-connection event linked
 * to no resource the requester belongs to, is dropped. Generic across sources —
 * GitHub repos and Linear teams gate identically; a new source needs only a
 * registry entry (`./sources`) plus its connector stamping the resource identity
 * on its events so they link to the resource entity.
 */

import { enforcedConnectionsSelectSql } from './acl-state.js';
import type { AuthzScope } from './scope.js';
import { RESOURCE_TYPE_SLUGS } from './sources.js';

/** Resource type slugs as a safe SQL `IN (...)` list. Slugs are validated to
 * simple identifiers in `./sources`, so inlining as literals is injection-safe
 * (and avoids binding a text[] param, which the fetch_types:false driver rejects). */
const RESOURCE_TYPE_IN_LIST = RESOURCE_TYPE_SLUGS.map((s) => `'${s}'`).join(', ');

/**
 * Predicate for a table holding events (alias has `connection_id` + `entity_ids`).
 * Binds two params from `baseParamIndex`: the org id and the principal. Returns an
 * `AND (...)` fragment (no leading space). Compose alongside
 * `compileConnectionFkVisibility` at the same seam.
 */
export function compileResourceVisibility(
  scope: AuthzScope,
  baseParamIndex: number,
  tableAlias: string,
): { sql: string; params: Array<string | null> } {
  const orgParam = `$${baseParamIndex}::text`;
  const userParam = `$${baseParamIndex + 1}::text`;

  // No registered resource types → nothing to enforce (defensive; the registry
  // is non-empty today).
  if (RESOURCE_TYPE_SLUGS.length === 0) {
    return { sql: '', params: [] };
  }

  // `events.connection_id` is bigint, but `authz_source_acl_state.connection_id`
  // is text (it also keys text `agent_connections.id` for Slack). Cast to text so
  // the comparison is well-typed across both connection-id spaces.
  const sql = `AND (
      ${tableAlias}.connection_id IS NULL
      OR ${tableAlias}.connection_id::text NOT IN (${enforcedConnectionsSelectSql(orgParam)})
      OR EXISTS (
        SELECT 1
        FROM public.entity_relationships rr
        JOIN public.entity_relationship_types rt
          ON rt.id = rr.relationship_type_id
         AND rt.organization_id = rr.organization_id
         AND rt.slug = 'member_of'
        JOIN public.entities re
          ON re.id = rr.to_entity_id
         AND re.organization_id = rr.organization_id
         AND re.deleted_at IS NULL
        JOIN public.entity_types ret
          ON ret.id = re.entity_type_id
         AND ret.organization_id = re.organization_id
         AND ret.slug IN (${RESOURCE_TYPE_IN_LIST})
        WHERE rr.organization_id = ${orgParam}
          AND rr.deleted_at IS NULL
          AND rr.to_entity_id = ANY(${tableAlias}.entity_ids)
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
