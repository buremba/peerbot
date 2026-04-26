/**
 * Helpers for writing the user's $member entity + entity_identities rows.
 *
 * These let the signup hook + install endpoint populate the identity graph so
 * the gateway can later route inbound WhatsApp / Slack / etc. messages back
 * to the right user's personal org via a single entity_identities lookup.
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

/**
 * Normalize a user-supplied phone string to E.164 (`+447123456789` form).
 * - Strips spaces, dashes, parentheses, dots.
 * - Accepts leading `+`, `00` (international prefix), or a UK national `0`.
 * - Returns null if the result doesn't look like a 7-15 digit E.164 number.
 */
export function normalizePhoneE164(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-().]/g, '');
  let digits: string;
  if (cleaned.startsWith('+')) {
    digits = cleaned.slice(1);
  } else if (cleaned.startsWith('00')) {
    digits = cleaned.slice(2);
  } else if (cleaned.startsWith('0')) {
    // UK national format — assume +44 for this product (UK Self Assessment).
    digits = `44${cleaned.slice(1)}`;
  } else {
    digits = cleaned;
  }
  // Drop the UK trunk-prefix "0" that often appears as `+44 (0) 71234...`
  // after we've stripped parens. UK numbers in E.164 are 12 digits (44 + 10).
  if (digits.startsWith('440') && digits.length === 13) {
    digits = `44${digits.slice(3)}`;
  }
  if (!/^\d{7,15}$/.test(digits)) return null;
  return `+${digits}`;
}

/**
 * Convert an E.164 phone (e.g. `+447123456789`) to a WhatsApp JID
 * (`447123456789@s.whatsapp.net`). Group chats (`@g.us`) are out of scope —
 * we only link individual users.
 */
export function phoneToWhatsAppJid(e164: string): string {
  return `${e164.slice(1)}@s.whatsapp.net`;
}

/**
 * Attach a WhatsApp identity to the user's $member entity in their personal
 * org. Idempotent. Returns the canonical phone + jid that were written so the
 * caller can echo them back for confirmation.
 */
export async function linkWhatsAppToMember(params: {
  organizationId: string;
  email: string;
  rawPhone: string;
}): Promise<{ phone: string; waJid: string } | { error: 'invalid_phone' | 'no_member' }> {
  const phone = normalizePhoneE164(params.rawPhone);
  if (!phone) return { error: 'invalid_phone' };
  const waJid = phoneToWhatsAppJid(phone);

  const sql = getDb();
  const memberEntityId = await findMemberEntityIdByEmail(sql, params.organizationId, params.email);
  if (memberEntityId === null) return { error: 'no_member' };

  await writeIdentities(sql, params.organizationId, memberEntityId, 'install:whatsapp', [
    { namespace: 'phone', identifier: phone },
    { namespace: 'wa_jid', identifier: waJid },
  ]);

  return { phone, waJid };
}
