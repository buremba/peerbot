/**
 * Shared defaults and helpers for the built-in $member entity type.
 */

import { getDb } from '../db/client';

interface MemberSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  format?: string;
  readOnly?: boolean;
  'x-email'?: boolean;
  'x-image'?: boolean;
  'x-table-column'?: boolean;
}

interface MemberMetadataSchema {
  type?: string;
  properties?: Record<string, MemberSchemaProperty>;
  required?: string[];
}

const BASE_MEMBER_EVENT_METADATA_SCHEMA = {
  type: 'object',
  properties: {
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    importance: { type: 'number', minimum: 0, maximum: 1 },
    namespace: { type: 'string' },
    status: { type: 'string', enum: ['active', 'archived', 'deleted'] },
  },
} as const;

const DEFAULT_MEMBER_EVENT_KINDS = {
  identity: {
    description: 'Facts about who a person or entity is',
    metadataSchema: BASE_MEMBER_EVENT_METADATA_SCHEMA,
  },
  preference: {
    description: 'User preferences and settings',
    metadataSchema: BASE_MEMBER_EVENT_METADATA_SCHEMA,
  },
  decision: {
    description: 'Decisions made by or about the member',
    metadataSchema: BASE_MEMBER_EVENT_METADATA_SCHEMA,
  },
  fact: {
    description: 'Verified facts or knowledge',
    metadataSchema: BASE_MEMBER_EVENT_METADATA_SCHEMA,
  },
  event: {
    description: 'Notable events or occurrences',
    metadataSchema: {
      type: 'object',
      properties: {
        ...BASE_MEMBER_EVENT_METADATA_SCHEMA.properties,
        valid_from: { type: 'string', format: 'date-time' },
        valid_to: { type: 'string', format: 'date-time' },
      },
    },
  },
  observation: {
    description: 'Observations and insights',
    metadataSchema: BASE_MEMBER_EVENT_METADATA_SCHEMA,
  },
  todo: {
    description: 'Tasks and action items',
    metadataSchema: BASE_MEMBER_EVENT_METADATA_SCHEMA,
  },
  note: { description: 'General notes and content' },
  summary: { description: 'Summaries and digests' },
  content: { description: 'Generic content' },
  change: { description: 'Entity field changes and audit trail' },
} as const;

const DEFAULT_MEMBER_METADATA_SCHEMA = {
  type: 'object',
  properties: {
    email: {
      type: 'string',
      format: 'email',
      description: 'Email',
      'x-email': true,
      'x-table-column': true,
    },
    image_url: {
      type: 'string',
      format: 'uri',
      description: 'Profile image URL',
      'x-image': true,
    },
    role: {
      type: 'string',
      description: 'Role',
      'x-table-column': true,
    },
    status: {
      type: 'string',
      description: 'Status',
      enum: ['active', 'invited'],
      'x-table-column': true,
    },
    display_name: {
      type: 'string',
      description: 'Canonical display name from connectors',
      'x-table-column': true,
    },
    push_name: {
      type: 'string',
      description:
        'Self-chosen name from messaging platforms (WhatsApp push_name, Slack real_name)',
    },
    last_seen_at: {
      type: 'string',
      format: 'date-time',
      description: 'Most recent activity timestamp across connectors',
    },
    bio: {
      type: 'string',
      description: 'Free-form biography',
    },
  },
} as const satisfies MemberMetadataSchema;

function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function mergeEnumValues(existing: string[] | undefined, required: readonly string[]): string[] {
  const merged = [...(existing ?? [])];
  for (const value of required) {
    if (!merged.includes(value)) merged.push(value);
  }
  return merged;
}

function mergeMemberMetadataSchema(
  schema: Record<string, unknown> | null | undefined
): MemberMetadataSchema {
  const existing = (schema ?? null) as MemberMetadataSchema | null;
  const next: MemberMetadataSchema = {
    type: 'object',
    properties: { ...(existing?.properties ?? {}) },
    required: Array.isArray(existing?.required) ? [...existing.required] : undefined,
  };
  const properties = next.properties ?? {};

  const emailEntry =
    Object.entries(properties).find(([, prop]) => prop?.['x-email']) ??
    (properties.email ? ['email', properties.email] : undefined);
  if (emailEntry) {
    const [key, prop] = emailEntry;
    properties[key] = {
      ...prop,
      type: prop.type ?? 'string',
      format: prop.format ?? 'email',
      description: prop.description ?? 'Email',
      'x-email': true,
      'x-table-column': prop['x-table-column'] ?? true,
    };
  } else {
    properties.email = { ...DEFAULT_MEMBER_METADATA_SCHEMA.properties.email };
  }

  const imageEntry =
    Object.entries(properties).find(([, prop]) => prop?.['x-image']) ??
    (properties.image_url ? ['image_url', properties.image_url] : undefined);
  if (imageEntry) {
    const [key, prop] = imageEntry;
    properties[key] = {
      ...prop,
      type: prop.type ?? 'string',
      format: prop.format ?? 'uri',
      description: prop.description ?? 'Profile image URL',
      'x-image': true,
    };
  } else {
    properties.image_url = { ...DEFAULT_MEMBER_METADATA_SCHEMA.properties.image_url };
  }

  properties.role = properties.role
    ? {
        ...properties.role,
        type: properties.role.type ?? 'string',
        description: properties.role.description ?? 'Role',
        'x-table-column': properties.role['x-table-column'] ?? true,
      }
    : { ...DEFAULT_MEMBER_METADATA_SCHEMA.properties.role };

  const statusProp = properties.status;
  properties.status = statusProp
    ? {
        ...statusProp,
        type: statusProp.type ?? 'string',
        description: statusProp.description ?? 'Status',
        enum: mergeEnumValues(
          statusProp.enum,
          DEFAULT_MEMBER_METADATA_SCHEMA.properties.status.enum
        ),
        'x-table-column': statusProp['x-table-column'] ?? true,
      }
    : { ...DEFAULT_MEMBER_METADATA_SCHEMA.properties.status };

  for (const key of ['display_name', 'push_name', 'last_seen_at', 'bio'] as const) {
    if (!properties[key]) {
      properties[key] = { ...DEFAULT_MEMBER_METADATA_SCHEMA.properties[key] };
    }
  }

  // user_id moved to entity_identities (namespace: auth_user_id). Drop the legacy scalar
  // from existing org schemas so the UI stops showing a stale field.
  delete properties.user_id;

  next.properties = properties;
  return next;
}

export async function ensureMemberEntityType(organizationId: string): Promise<void> {
  const sql = getDb();
  const existingRows = await sql`
    SELECT id, metadata_schema, event_kinds
    FROM entity_types
    WHERE slug = '$member'
      AND deleted_at IS NULL
      AND organization_id = ${organizationId}
    LIMIT 1
  `;

  if (existingRows.length === 0) {
    await sql`
      INSERT INTO entity_types (
        slug,
        name,
        description,
        icon,
        organization_id,
        metadata_schema,
        event_kinds,
        created_at,
        updated_at
      )
      VALUES (
        '$member',
        'Member',
        'Organization member',
        'user',
        ${organizationId},
        ${sql.json(DEFAULT_MEMBER_METADATA_SCHEMA)},
        ${sql.json(DEFAULT_MEMBER_EVENT_KINDS)},
        current_timestamp,
        current_timestamp
      )
      ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL DO NOTHING
    `;
    return;
  }

  const existing = existingRows[0];
  const mergedMetadataSchema = mergeMemberMetadataSchema(
    (existing.metadata_schema as Record<string, unknown> | null | undefined) ?? null
  );
  const existingMetadataSchema = (existing.metadata_schema ?? null) as MemberMetadataSchema | null;
  const shouldUpdateMetadataSchema = !memberMetadataSchemasEqual(
    existingMetadataSchema,
    mergedMetadataSchema
  );
  const shouldUpdateEventKinds = existing.event_kinds == null;

  if (!shouldUpdateMetadataSchema && !shouldUpdateEventKinds) {
    return;
  }

  await sql`
    UPDATE entity_types
    SET metadata_schema = ${shouldUpdateMetadataSchema ? sql.json(mergedMetadataSchema) : existing.metadata_schema},
        event_kinds = ${shouldUpdateEventKinds ? sql.json(DEFAULT_MEMBER_EVENT_KINDS) : existing.event_kinds},
        updated_at = current_timestamp
    WHERE id = ${existing.id}
  `;
}

export function resolveMemberSchemaFieldsFromSchema(
  schema: Record<string, unknown> | null | undefined
): {
  emailField: string;
  imageField?: string;
} {
  const props = (schema as MemberMetadataSchema | null | undefined)?.properties;
  if (!props) return { emailField: 'email' };

  return {
    emailField: Object.entries(props).find(([, prop]) => prop?.['x-email'])?.[0] ?? 'email',
    imageField: Object.entries(props).find(([, prop]) => prop?.['x-image'])?.[0],
  };
}

function memberMetadataSchemasEqual(
  a: Record<string, unknown> | MemberMetadataSchema | null | undefined,
  b: Record<string, unknown> | MemberMetadataSchema | null | undefined
): boolean {
  const left = (a ?? null) as MemberMetadataSchema | null;
  const right = (b ?? null) as MemberMetadataSchema | null;
  if (left?.type !== right?.type) return false;
  if (!arraysEqual(left?.required, right?.required)) return false;

  const leftProps = left?.properties ?? {};
  const rightProps = right?.properties ?? {};
  const keys = new Set([...Object.keys(leftProps), ...Object.keys(rightProps)]);
  for (const key of keys) {
    if (JSON.stringify(leftProps[key] ?? null) !== JSON.stringify(rightProps[key] ?? null)) {
      return false;
    }
  }
  return true;
}
