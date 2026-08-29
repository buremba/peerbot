/**
 * THE generic resource-visibility compiler — gates connector-sourced `events`
 * (GitHub issues/PRs, Linear issues, …) by RESOURCE membership, the same way
 * `./channel-visibility` gates Slack chat by channel membership, but at the
 * `events` read seam and for ANY resource type at once.
 *
 * Rule, composed AFTER the per-connection visibility gate (they AND together),
 * mirroring the three-state enforcement split `getConnectionEnforcement` /
 * `./channel-visibility` apply so the two gates can never drift:
 *   - an event on a connection that was NEVER graphed (no `authz_source_acl_state`
 *     row) is unconstrained here — the per-connection gate already decided it and
 *     an absent graph must never silently hide data;
 *   - an event on an ENFORCED connection (`acl_support='full'`,
 *     `freshness_state='fresh'`, synced within the freshness window) is visible
 *     ONLY when the requester is `member_of` one of the RESOURCE entities the
 *     event is linked to (`events.entity_ids`), where "resource" = an entity whose
 *     type is `$resource`. Scoped so the coarse person→`company` (org)
 *     `member_of` edge never satisfies it — org membership must NOT grant
 *     repo-level read;
 *   - an event on an onboarded-but-STALE connection (a row exists but is
 *     partial/failed/stale/aged-out — i.e. NOT in the enforced set) FAILS CLOSED:
 *     neither the not-graphed passthrough nor the enforced membership branch
 *     matches, so its resource-linked events are dropped rather than served on
 *     stale membership. Once a connection is graphed, it never falls back to the
 *     legacy per-connection fence — a stalled sync hides data, it does not leak it.
 *
 * Fail-closed: a headless/null principal on an enforced connection, a
 * non-interaction event linked to no resource the requester belongs to, or any
 * event on a stale connection is dropped.
 *
 * Interaction events (`interaction_type <> 'none'`: approvals, suggestions)
 * are instead readable by any ORGANIZATION member, in every graph state.
 * They are server-authored workflow state, not synced resource content: an
 * operation's approval card is stamped with the connection it acts THROUGH but
 * may have no resource entity link, so the membership branch could never match
 * and the gate hid pending approvals from everyone, org admins included (prod
 * run 757649). The arm is deliberately freshness-independent — hiding an
 * approval because the ACL sync stalled would silently wedge the operation it
 * gates, and the `member`-row check it relies on is live data, not the synced
 * graph. It still requires an organization membership row, so headless and
 * public non-member reads gain nothing, and connector sync never writes
 * `interaction_type`, so no synced resource content can ride the exemption.
 * The per-connection visibility gate always still applies in front. Generic
 * across sources — GitHub repos and Linear teams gate identically; a new
 * source needs only a registry entry (`./sources`) plus its connector stamping
 * the resource identity on its events so they link to the resource entity.
 */

import { ACL_RESOURCE_TYPE_SLUG } from '@lobu/connector-sdk';
import { aclStateExistsSelectSql, enforcedConnectionsSelectSql } from './acl-state.js';
import type { AuthzScope } from './scope.js';

/** Sole ACL resource type slug, inlined as a SQL string literal (constant). */
const RESOURCE_TYPE_SQL = `'${ACL_RESOURCE_TYPE_SLUG}'`;

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

  // `events.connection_id` is the bigint `connections.id`, but
  // `authz_source_acl_state.connection_id` is text — the ACL sync stamps it as
  // `String(connections.id)` (see `github-acl-sync` → `buildAccessGraph`). Cast
  // `events.connection_id::text` so BOTH the "is this connection graphed?" check
  // and the "is it enforced?" check compare on the SAME key.
  //
  // Three-state split (mirrors `getConnectionEnforcement`), NOT a bare
  // `NOT IN (enforced)`:
  //   1. no ACL row for the connection → passthrough (never graphed → legacy fence);
  //   2. row is enforced (in the fresh-enforced set) → require resource membership;
  //   3. row exists but is NOT enforced (stale/partial/failed/aged-out) → neither
  //      branch matches → FAIL CLOSED. A bare `NOT IN (enforced)` would make (3)
  //      true and leak stale-connection events to non-members — the hole this fix
  //      closes, matching the channel gate.
  // Server-authored interaction events sit OUTSIDE the split: any organization
  // member may read them in every graph state (see module doc).
  const sql = `AND (
      ${tableAlias}.connection_id IS NULL
      OR ${tableAlias}.connection_id::text NOT IN (${aclStateExistsSelectSql(orgParam)})
      OR (${tableAlias}.interaction_type <> 'none'
      AND EXISTS (
        SELECT 1
        FROM public."member" om
        WHERE om."organizationId" = ${orgParam}
          AND om."userId" = ${userParam}
      ))
      OR (${tableAlias}.connection_id::text IN (${enforcedConnectionsSelectSql(orgParam)})
      AND EXISTS (
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
         AND ret.slug = ${RESOURCE_TYPE_SQL}
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
              AND mei.scope_key IS NULL
              AND mei.source_connector = 'auth:signup'
              AND mei.deleted_at IS NULL
            LIMIT 1
          )
      ))
    )`;
  return { sql, params: [scope.organizationId, scope.principal] };
}
