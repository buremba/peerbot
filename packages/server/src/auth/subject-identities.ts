/**
 * Helpers for writing the user's $member entity + entity_identities rows.
 *
 * Used by the signup hook to populate the identity graph so the gateway can
 * later route inbound messages back to the right user's personal org via a
 * single entity_identities lookup.
 */

import { getDb } from "../db/client";
import {
	ensureMemberEntity,
	resolveMemberSchemaFields,
} from "../utils/member-entity";

export interface PersonalSubject {
	userId: string;
	email: string;
	name?: string | null;
	image?: string | null;
}

interface IdentityRow {
	namespace: string;
	identifier: string;
}

type Sql = ReturnType<typeof getDb>;

/**
 * Insert (or no-op on conflict) entity_identities rows pointing at the given
 * member entity. The unique index on (organization_id, namespace, identifier)
 * WHERE deleted_at IS NULL guards against duplicates.
 */
async function writeIdentities(
	sql: Sql,
	organizationId: string,
	memberEntityId: number,
	source: string,
	rows: IdentityRow[],
): Promise<void> {
	for (const row of rows) {
		await sql`
      INSERT INTO entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector
      ) VALUES (
        ${organizationId}, ${memberEntityId}, ${row.namespace}, ${row.identifier}, ${source}
      )
      ON CONFLICT (organization_id, namespace, identifier) WHERE deleted_at IS NULL
      DO NOTHING
    `;
	}
}

async function findMemberEntityIdByEmail(
	sql: Sql,
	organizationId: string,
	email: string,
): Promise<number | null> {
	const { emailField } = await resolveMemberSchemaFields(organizationId);
	const rows = await sql.unsafe(
		`SELECT e.id
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE et.slug = '$member'
      AND e.organization_id = $1
      AND e.metadata->>$2 = $3
      AND e.deleted_at IS NULL
    LIMIT 1`,
		[organizationId, emailField, email],
	);
	if (rows.length === 0) return null;
	return Number(rows[0].id);
}

/**
 * `entity_identities.source_connector` values trusted for `$member` adoption.
 * User-supplied identity rows MUST NOT appear here — only auth-server writes,
 * vetted migrations, and connector-emitted facts may bind a signing-in user
 * to a curated row, otherwise a malicious row could hijack adoption.
 */
const TRUSTED_ADOPTION_SOURCES = [
	"auth:signup",
	"identity-engine:fact",
	"migration:founder_to_member",
];

/**
 * Multi-namespace `$member` lookup against `entity_identities`.
 *
 * Used by the identity engine + auth hook to adopt a pre-curated `$member`
 * row when a signing-in user matches one of several verified identifiers.
 * Returns the first matching entity id; returns null if no namespace pair
 * matches.
 *
 * Lookup order matches caller-provided order — the caller decides which
 * provider's signal is most authoritative. Within entity_identities we
 * already have a unique index on (organization_id, namespace, identifier),
 * so each (ns, id) pair returns at most one row.
 *
 * Joins on `e.organization_id = ei.organization_id` to keep cross-org rows
 * from hijacking adoption, and filters by trusted `source_connector` so
 * user-supplied identity rows can't bind users.
 */
export async function findMemberEntityIdByIdentities(
	organizationId: string,
	candidates: Array<{ namespace: string; identifier: string }>,
): Promise<number | null> {
	if (candidates.length === 0) return null;
	const sql = getDb();
	for (const cand of candidates) {
		if (!cand.namespace || !cand.identifier) continue;
		const rows = await sql<{ entity_id: number }>`
      SELECT ei.entity_id
      FROM entity_identities ei
      JOIN entities e
        ON e.id = ei.entity_id
       AND e.organization_id = ei.organization_id
      JOIN entity_types et
        ON et.id = e.entity_type_id
       AND et.organization_id = e.organization_id
      WHERE ei.organization_id = ${organizationId}
        AND ei.namespace = ${cand.namespace}
        AND ei.identifier = ${cand.identifier}
        AND ei.deleted_at IS NULL
        AND ei.source_connector = ANY(${TRUSTED_ADOPTION_SOURCES})
        AND et.slug = '$member'
        AND e.deleted_at IS NULL
      LIMIT 1
    `;
		if (rows.length > 0) {
			return Number(rows[0].entity_id);
		}
	}
	return null;
}

/**
 * Create a $member entity for the user in the given org and write the core
 * personal identifiers (auth_user_id, email). Idempotent — safe to call again.
 */
export async function provisionMemberAndCoreIdentities(
	organizationId: string,
	subject: PersonalSubject,
): Promise<{ memberEntityId: number }> {
	await ensureMemberEntity({
		organizationId,
		userId: subject.userId,
		name: subject.name?.trim() || subject.email.split("@")[0],
		email: subject.email,
		image: subject.image ?? undefined,
		role: "owner",
		status: "active",
	});

	const sql = getDb();
	const memberEntityId = await findMemberEntityIdByEmail(
		sql,
		organizationId,
		subject.email,
	);
	if (memberEntityId === null) {
		throw new Error(
			`Failed to locate $member entity for user ${subject.userId} in org ${organizationId} after ensureMemberEntity`,
		);
	}

	await writeIdentities(sql, organizationId, memberEntityId, "auth:signup", [
		{ namespace: "auth_user_id", identifier: subject.userId },
		{ namespace: "email", identifier: subject.email.toLowerCase() },
	]);

	return { memberEntityId };
}
