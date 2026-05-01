/**
 * $member entity lifecycle utilities.
 * Used by auth hooks to auto-manage member entities when users join/leave orgs.
 *
 * All functions use skipHooks: true to prevent circular calls
 * (auth hook → ensureMemberEntity → createEntity → beforeCreate hook → invitation insert).
 */

import { getDb } from '../db/client';
import { createEntity } from './entity-management';
import { ensureMemberEntityType, resolveMemberSchemaFieldsFromSchema } from './member-entity-type';

/**
 * Resolve annotated field names from the $member entity type's metadata_schema.
 * Uses the `x-email`/`x-image` annotations; falls back to 'email' for email.
 */
export async function resolveMemberSchemaFields(organizationId: string): Promise<{
  emailField: string;
  imageField?: string;
}> {
  const sql = getDb();
  const rows = await sql`
    SELECT metadata_schema FROM entity_types
    WHERE slug = '$member' AND deleted_at IS NULL AND organization_id = ${organizationId}
    LIMIT 1
  `;
  return resolveMemberSchemaFieldsFromSchema(
    (rows[0]?.metadata_schema as Record<string, unknown> | null | undefined) ?? null
  );
}

interface EnsureMemberEntityParams {
  organizationId: string;
  userId?: string;
  name: string;
  email: string;
  image?: string;
  role?: string;
  status?: 'active' | 'invited';
}

/**
 * Create a $member entity if one doesn't already exist for the given email in the org.
 * Ensures the built-in $member type has the expected metadata schema first.
 * Uses skipHooks to avoid circular invitation creation from auth callbacks.
 */
export async function ensureMemberEntity(params: EnsureMemberEntityParams): Promise<void> {
  const sql = getDb();

  await ensureMemberEntityType(params.organizationId);
  const { emailField, imageField } = await resolveMemberSchemaFields(params.organizationId);

  // Check if a $member entity with this email already exists
  const existing = await sql.unsafe(
    `SELECT e.id
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE et.slug = '$member'
      AND e.organization_id = $1
      AND e.metadata->>$2 = $3
      AND e.deleted_at IS NULL
    LIMIT 1`,
    [params.organizationId, emailField, params.email]
  );
  if (existing.length > 0) return;

  const metadata: Record<string, unknown> = {
    [emailField]: params.email,
    status: params.status ?? 'active',
  };
  if (params.image && imageField) metadata[imageField] = params.image;
  if (params.role) metadata.role = params.role;

  await createEntity(
    {
      entity_type: '$member',
      name: params.name.trim(),
      organization_id: params.organizationId,
      metadata,
    },
    { skipHooks: true }
  );
}

/**
 * Update a $member entity's status by email.
 */
export async function updateMemberEntityStatus(
  organizationId: string,
  email: string,
  status: string
): Promise<void> {
  await ensureMemberEntityType(organizationId);
  const { emailField } = await resolveMemberSchemaFields(organizationId);
  const sql = getDb();
  await sql`
    UPDATE entities
    SET metadata = jsonb_set(metadata, '{status}', to_jsonb(${status}::text)),
        updated_at = current_timestamp
    WHERE entity_type_id = (
        SELECT id FROM entity_types
        WHERE slug = '$member' AND organization_id = ${organizationId} AND deleted_at IS NULL
      )
      AND organization_id = ${organizationId}
      AND metadata->>${emailField} = ${email}
      AND deleted_at IS NULL
  `;
}

export async function updateMemberEntityAccess(
  organizationId: string,
  email: string,
  updates: { role?: string; status?: 'active' | 'invited' }
): Promise<void> {
  await ensureMemberEntityType(organizationId);
  const { emailField } = await resolveMemberSchemaFields(organizationId);
  const sql = getDb();
  const rows = await sql.unsafe<{ id: number; metadata: Record<string, unknown> }>(
    `SELECT e.id, e.metadata
     FROM entities e
     JOIN entity_types et ON et.id = e.entity_type_id
     WHERE et.slug = '$member'
       AND e.organization_id = $1
       AND e.metadata->>$2 = $3
       AND e.deleted_at IS NULL
     LIMIT 1`,
    [organizationId, emailField, email]
  );
  if (rows.length === 0) return;

  const metadata = { ...(rows[0].metadata ?? {}) } as Record<string, unknown>;
  if (updates.role !== undefined) metadata.role = updates.role;
  if (updates.status !== undefined) metadata.status = updates.status;

  await sql`
    UPDATE entities
    SET metadata = ${sql.json(metadata)},
        updated_at = current_timestamp
    WHERE id = ${rows[0].id}
  `;
}

/**
 * Delete a $member entity by email (soft-delete).
 */
export async function deleteMemberEntity(organizationId: string, email: string): Promise<void> {
  await ensureMemberEntityType(organizationId);
  const { emailField } = await resolveMemberSchemaFields(organizationId);
  const sql = getDb();
  await sql.unsafe(
    `UPDATE entities
    SET deleted_at = current_timestamp, updated_at = current_timestamp
    WHERE entity_type_id = (
        SELECT id FROM entity_types
        WHERE slug = '$member' AND organization_id = $1 AND deleted_at IS NULL
      )
      AND organization_id = $1
      AND metadata->>$2 = $3
      AND deleted_at IS NULL`,
    [organizationId, emailField, email]
  );
}
