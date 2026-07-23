/**
 * The single source of truth for "does this (org, user) resolve to a live
 * `$member` via the authz gate's identity claim?".
 *
 * The channel-visibility gate resolves a signed-in user to their `$member`
 * entity through one `entity_identities` row: namespace `auth_user_id`, source
 * `auth:signup`, on a live entity of type `$member`. That exact join is needed
 * by the drift alerter (count-all), the backfill scanner (`findDrift`), and the
 * backfill's post-write verification (`hasResolvableClaim`). Hand-copying it
 * across those flows lets them silently diverge if only one copy is updated, so
 * it lives here and every caller composes this fragment instead.
 */

import type { DbClient, DbQuery } from "../db/client";

/**
 * A composable `EXISTS (...)` SQL fragment that is true when a live
 * `auth_user_id`/`auth:signup` claim resolves to a live `$member` entity for the
 * given org and user expressions.
 *
 * `orgExpr`/`userExpr` are themselves SQL fragments so a caller can correlate to
 * outer-query columns (e.g. `sql`m."organizationId"``, `sql`m."userId"``) inside
 * a `NOT EXISTS`, or to bound values (`sql`${organizationId}``, `sql`${userId}``)
 * for a standalone check — without duplicating the join.
 */
export function resolvableMemberClaimExists(
	sql: DbClient,
	orgExpr: DbQuery,
	userExpr: DbQuery
): DbQuery {
	return sql`
    EXISTS (
      SELECT 1
      FROM entity_identities ei
      JOIN entities e
        ON e.id = ei.entity_id
       AND e.organization_id = ei.organization_id
       AND e.deleted_at IS NULL
      JOIN entity_types et
        ON et.id = e.entity_type_id
       AND et.organization_id = e.organization_id
       AND et.slug = '$member'
      WHERE ei.organization_id = ${orgExpr}
        AND ei.namespace = 'auth_user_id'
        AND ei.identifier = ${userExpr}
        AND ei.source_connector = 'auth:signup'
        AND ei.deleted_at IS NULL
    )
  `;
}
