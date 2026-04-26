/**
 * Helpers for writing the user's $member entity + entity_identities rows.
 *
 * Used by the signup hook to populate the identity graph so the gateway can
 * later route inbound messages back to the right user's personal org via a
 * single entity_identities lookup.
 */

import { getDb } from '../db/client';
import { ensureMemberEntity, resolveMemberSchemaFields } from '../utils/member-entity';

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
  rows: IdentityRow[]
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
  email: string
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
    [organizationId, emailField, email]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].id);
}

/**
 * Create a $member entity for the user in the given org and write the core
 * personal identifiers (auth_user_id, email). Idempotent — safe to call again.
 */
export async function provisionMemberAndCoreIdentities(
  organizationId: string,
  subject: PersonalSubject
): Promise<{ memberEntityId: number }> {
  await ensureMemberEntity({
    organizationId,
    userId: subject.userId,
    name: subject.name?.trim() || subject.email.split('@')[0],
    email: subject.email,
    image: subject.image ?? undefined,
    role: 'owner',
    status: 'active',
  });

  const sql = getDb();
  const memberEntityId = await findMemberEntityIdByEmail(sql, organizationId, subject.email);
  if (memberEntityId === null) {
    throw new Error(
      `Failed to locate $member entity for user ${subject.userId} in org ${organizationId} after ensureMemberEntity`
    );
  }

  await writeIdentities(sql, organizationId, memberEntityId, 'auth:signup', [
    { namespace: 'auth_user_id', identifier: subject.userId },
    { namespace: 'email', identifier: subject.email.toLowerCase() },
  ]);

  return { memberEntityId };
}
