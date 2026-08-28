import type { DbClient } from "../db/client";

export interface OrganizationIdentityClaim {
	id: number;
	entityId: number;
}

/**
 * Claim one identity in a permanently organization-scoped namespace.
 *
 * Re-key retains old scope keys so append-only events keep resolving. A plain
 * INSERT can recreate the organization-scope sentinel retained by another live
 * row and make that historical tuple ambiguous. The INSERT's table lock
 * serializes with re-key, while the history predicate refuses that reuse.
 *
 * A null result means either the exact current claim already exists or another
 * live row retains the organization scope in history. Callers that need to
 * distinguish those cases must re-read the exact `scope_key IS NULL` claim on
 * the same transaction handle and fail closed when it is absent.
 */
export async function insertOrganizationScopedIdentity(
	sql: DbClient,
	params: {
		organizationId: string;
		entityId: number;
		namespace: string;
		identifier: string;
		sourceConnector?: string | null;
	},
): Promise<OrganizationIdentityClaim | null> {
	const rows = await sql<{ id: number | string; entity_id: number | string }>`
    INSERT INTO entity_identities (
      organization_id, entity_id, namespace, identifier, source_connector, scope_key
    )
    SELECT
      ${params.organizationId}, ${params.entityId}, ${params.namespace},
      ${params.identifier}, ${params.sourceConnector ?? null}, NULL
    WHERE NOT EXISTS (
      SELECT 1
      FROM entity_identities retained
      WHERE retained.organization_id = ${params.organizationId}
        AND retained.namespace = ${params.namespace}
        AND retained.identifier = ${params.identifier}
        AND retained.deleted_at IS NULL
        AND '' = ANY(retained.scope_key_history)
    )
    ON CONFLICT (organization_id, namespace, identifier, COALESCE(scope_key, '')) WHERE deleted_at IS NULL
    DO NOTHING
    RETURNING id, entity_id
  `;
	const row = rows[0];
	return row ? { id: Number(row.id), entityId: Number(row.entity_id) } : null;
}
