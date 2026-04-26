/**
 * Event Semantic Type Validation
 *
 * Validates event semantic types and metadata against the producer's event_kinds schema.
 * Two entry points:
 *  - validateSaveContentSemanticType: for user/watcher content (resolves $member.event_kinds)
 *  - validateConnectorEventSemanticType: for connector content (resolves feeds_schema eventKinds)
 *
 * Returns human-readable errors with valid kinds, expected schema, and fuzzy suggestions.
 */

import { getDb } from '../db/client';
import { formatAjvError, getAjv } from './ajv-singleton';

// ============================================
// Types
// ============================================

interface KindValidationResult {
  valid: boolean;
  errors: string[];
  validKinds: string[];
  expectedSchema: Record<string, unknown> | null;
  suggestion: string | null;
}

interface EventKindDefinition {
  description?: string;
  metadataSchema?: Record<string, unknown>;
}

// ============================================
// Fuzzy Match
// ============================================

/** Levenshtein distance for fuzzy kind matching. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Find the closest kind from a list, returns null if none are close enough. */
function findClosestKind(kind: string, validKinds: string[]): string | null {
  if (validKinds.length === 0) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const vk of validKinds) {
    const dist = levenshtein(kind.toLowerCase(), vk.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = vk;
    }
  }
  // Only suggest if within ~40% of the shorter string's length
  const threshold = Math.max(2, Math.ceil(Math.min(kind.length, (best ?? '').length) * 0.4));
  return bestDist <= threshold ? best : null;
}

// ============================================
// Event Kinds Cache (TTL-based)
// ============================================

const CACHE_TTL_MS = 60_000; // 60 seconds

interface EventKindsCacheEntry {
  value: Record<string, EventKindDefinition> | null;
  expiresAt: number;
}

const eventKindsCache = new Map<string, EventKindsCacheEntry>();

// ============================================
// Event Kinds Resolution
// ============================================

/**
 * Fetch event_kinds for the $member entity type in a given org.
 * Returns null if no $member type or no event_kinds defined (accept any kind).
 */
async function getMemberEventKinds(
  orgId: string
): Promise<Record<string, EventKindDefinition> | null> {
  const cacheKey = `${orgId}:$member`;
  const now = Date.now();
  const cached = eventKindsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const sql = getDb();
  const rows = await sql`
    SELECT event_kinds
    FROM entity_types
    WHERE slug = '$member'
      AND organization_id = ${orgId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  let result: Record<string, EventKindDefinition> | null = null;
  if (rows.length > 0) {
    const eventKinds = rows[0].event_kinds;
    if (eventKinds && typeof eventKinds === 'object') {
      result = eventKinds as Record<string, EventKindDefinition>;
    }
  }
  eventKindsCache.set(cacheKey, { value: result, expiresAt: now + CACHE_TTL_MS });
  return result;
}

/**
 * Fetch event_kinds for the entity type of a given entity.
 * Returns null if entity not found or entity type has no custom event_kinds.
 */
async function getEntityTypeEventKinds(
  orgId: string,
  entityId: number
): Promise<Record<string, EventKindDefinition> | null> {
  const cacheKey = `${orgId}:entity:${entityId}`;
  const now = Date.now();
  const cached = eventKindsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const sql = getDb();
  const rows = await sql`
    SELECT et.event_kinds
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ${entityId}
      AND e.organization_id = ${orgId}
      AND e.deleted_at IS NULL
      AND et.deleted_at IS NULL
    LIMIT 1
  `;
  let result: Record<string, EventKindDefinition> | null = null;
  if (rows.length > 0) {
    const eventKinds = rows[0].event_kinds;
    if (eventKinds && typeof eventKinds === 'object') {
      result = eventKinds as Record<string, EventKindDefinition>;
    }
  }
  eventKindsCache.set(cacheKey, { value: result, expiresAt: now + CACHE_TTL_MS });
  return result;
}

/**
 * Fetch event_kinds from connector_definitions for a specific feed.
 * Returns null if connector or feed not found, or eventKinds not defined.
 */
async function getConnectorEventKinds(
  connectorKey: string,
  feedKey: string,
  orgId: string
): Promise<Record<string, EventKindDefinition> | null> {
  const cacheKey = `${orgId}:${connectorKey}:${feedKey}`;
  const now = Date.now();
  const cached = eventKindsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const sql = getDb();
  const rows = await sql`
    SELECT feeds_schema
    FROM connector_definitions
    WHERE key = ${connectorKey}
      AND organization_id = ${orgId}
    LIMIT 1
  `;
  let result: Record<string, EventKindDefinition> | null = null;
  if (rows.length > 0) {
    const feedsSchema = rows[0].feeds_schema as Record<string, any> | null;
    if (feedsSchema) {
      const feedDef = feedsSchema[feedKey];
      if (feedDef?.eventKinds) {
        result = feedDef.eventKinds as Record<string, EventKindDefinition>;
      }
    }
  }
  eventKindsCache.set(cacheKey, { value: result, expiresAt: now + CACHE_TTL_MS });
  return result;
}

// ============================================
// Validation Functions
// ============================================

function validateKindAgainstDefinitions(
  kind: string,
  metadata: Record<string, unknown> | undefined | null,
  eventKinds: Record<string, EventKindDefinition> | null
): KindValidationResult {
  // If no event_kinds defined, accept any kind (permissive mode)
  if (!eventKinds) {
    return { valid: true, errors: [], validKinds: [], expectedSchema: null, suggestion: null };
  }

  const validKinds = Object.keys(eventKinds);
  const kindDef = eventKinds[kind];

  // Kind not found
  if (!kindDef) {
    const suggestion = findClosestKind(kind, validKinds);
    const errors = [
      `Invalid kind '${kind}'. Valid kinds: ${validKinds.join(', ')}.`,
      ...(suggestion ? [`Did you mean '${suggestion}'?`] : []),
    ];
    return { valid: false, errors, validKinds, expectedSchema: null, suggestion };
  }

  // Kind found — validate metadata against its schema if defined
  const metadataSchema = kindDef.metadataSchema;
  if (!metadataSchema || !metadata || Object.keys(metadata).length === 0) {
    return {
      valid: true,
      errors: [],
      validKinds,
      expectedSchema: metadataSchema ?? null,
      suggestion: null,
    };
  }

  const ajv = getAjv();
  const validate = ajv.compile(metadataSchema);
  const isValid = validate(metadata);

  if (isValid) {
    return {
      valid: true,
      errors: [],
      validKinds,
      expectedSchema: metadataSchema,
      suggestion: null,
    };
  }

  const errors = [
    `Metadata validation failed for kind '${kind}':`,
    ...(validate.errors ?? []).map((e) => `  - ${formatAjvError(e)}`),
    `Expected: ${JSON.stringify(metadataSchema)}`,
  ];
  return { valid: false, errors, validKinds, expectedSchema: metadataSchema, suggestion: null };
}

/**
 * Validate kind + metadata for user/watcher content.
 * Resolves against the org's $member.event_kinds, merged with entity type
 * event_kinds when entityIds are provided.
 */
export async function validateSaveContentSemanticType(
  semanticType: string,
  metadata: Record<string, unknown> | undefined | null,
  orgId: string,
  entityIds?: number[]
): Promise<KindValidationResult> {
  const memberKinds = await getMemberEventKinds(orgId);

  // If entity IDs provided, also check entity type custom event_kinds
  if (entityIds && entityIds.length > 0) {
    const entityTypeKinds = await getEntityTypeEventKinds(orgId, entityIds[0]);
    if (entityTypeKinds) {
      // Try entity type kinds first (more specific)
      const entityResult = validateKindAgainstDefinitions(semanticType, metadata, entityTypeKinds);
      if (entityResult.valid) return entityResult;
    }
  }

  return validateKindAgainstDefinitions(semanticType, metadata, memberKinds);
}

/**
 * Validate kind + metadata for connector-sourced content.
 * Resolves against connector_definitions.feeds_schema[feedKey].eventKinds.
 */
export async function validateConnectorEventSemanticType(
  semanticType: string,
  metadata: Record<string, unknown> | undefined | null,
  connectorKey: string,
  feedKey: string,
  orgId: string
): Promise<KindValidationResult> {
  const eventKinds = await getConnectorEventKinds(connectorKey, feedKey, orgId);
  return validateKindAgainstDefinitions(semanticType, metadata, eventKinds);
}
