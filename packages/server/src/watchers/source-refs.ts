import type { DbClient } from '../db/client';
import type { WatcherSource } from '../types/watchers';

export type WatcherSourceKind = 'event' | 'entity' | 'metric';

export type WatcherSourceRef =
  | { type: 'feed'; value: string }
  | { type: 'connection'; value: string }
  | { type: 'connector'; value: string }
  | { type: 'channel'; value: string }
  | { type: 'entity'; value: string }
  | { type: 'metric'; entityType: string; measure: string };

export interface NormalizedWatcherSource extends WatcherSource {
  kind: WatcherSourceKind;
  ref?: WatcherSourceRef;
}

const REF_RE = /^@([a-z_][a-z0-9_-]*):(.+)$/i;
const SAFE_REF_VALUE_RE = /^[#@a-zA-Z0-9._:/-]+$/;
const SAFE_SLUG_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const SAFE_CONNECTOR_RE = /^[a-zA-Z0-9._-]+$/;

function assertSafeRefValue(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} reference is empty`);
  if (!SAFE_REF_VALUE_RE.test(trimmed)) {
    throw new Error(`${label} reference contains unsupported characters`);
  }
  return trimmed;
}

function assertSafeSlug(label: string, value: string): string {
  const trimmed = assertSafeRefValue(label, value);
  if (!SAFE_SLUG_RE.test(trimmed)) {
    throw new Error(`${label} reference must be a plain slug`);
  }
  return trimmed;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function eventSelect(where: string): string {
  return (
    'SELECT id, organization_id, entity_ids, origin_id, title, payload_type, payload_text, ' +
    'payload_data, payload_template, attachments, author_name, source_url, occurred_at, score, ' +
    'metadata, created_at, origin_parent_id, origin_type, connector_key, connection_id, feed_key, ' +
    'feed_id, semantic_type ' +
    `FROM events WHERE ${where} ORDER BY occurred_at DESC`
  );
}

export function parseWatcherSourceRef(query: string): WatcherSourceRef | null {
  const trimmed = query.trim();
  if (!trimmed.startsWith('@')) return null;

  const match = REF_RE.exec(trimmed);
  if (!match) {
    throw new Error(
      'source refs must use @feed:, @connection:, @connector:, @channel:, @entity:, or @metric:'
    );
  }

  const type = match[1].toLowerCase();
  const rawValue = match[2].trim();
  switch (type) {
    case 'feed':
      return { type: 'feed', value: assertSafeRefValue('@feed', rawValue) };
    case 'connection':
      return { type: 'connection', value: assertSafeRefValue('@connection', rawValue) };
    case 'connector':
      return { type: 'connector', value: assertSafeRefValue('@connector', rawValue) };
    case 'channel':
      return { type: 'channel', value: assertSafeRefValue('@channel', rawValue) };
    case 'entity':
      return { type: 'entity', value: assertSafeSlug('@entity', rawValue) };
    case 'metric': {
      const value = assertSafeRefValue('@metric', rawValue);
      const dot = value.indexOf('.');
      if (dot <= 0 || dot === value.length - 1) {
        throw new Error('@metric refs must be shaped like @metric:<entity_type>.<measure>');
      }
      const entityType = value.slice(0, dot);
      const measure = value.slice(dot + 1);
      if (!SAFE_SLUG_RE.test(entityType) || !SAFE_SLUG_RE.test(measure)) {
        throw new Error('@metric entity type and measure must be plain identifiers');
      }
      return { type: 'metric', entityType, measure };
    }
    default:
      throw new Error(`unsupported source ref @${type}:`);
  }
}

export function watcherSourceKindForRef(ref: WatcherSourceRef | null): WatcherSourceKind {
  if (!ref) return 'event';
  if (ref.type === 'entity') return 'entity';
  if (ref.type === 'metric') return 'metric';
  return 'event';
}

export function validateWatcherSourceRef(name: string, query: string): WatcherSourceKind | null {
  try {
    const ref = parseWatcherSourceRef(query);
    return ref ? watcherSourceKindForRef(ref) : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`source "${name}": ${message}`);
  }
}

function numericRef(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function resolveFeedIds(sql: DbClient, organizationId: string, value: string): Promise<number[]> {
  const id = numericRef(value);
  const rows = await sql<{ id: number | string; kind: string | null }>`
    SELECT id, kind
    FROM feeds
    WHERE organization_id = ${organizationId}
      AND deleted_at IS NULL
      AND (
        ${id}::bigint IS NOT NULL AND id = ${id}::bigint
        OR feed_key = ${value}
        OR display_name = ${value}
      )
    ORDER BY id
    LIMIT 100
  `;
  // `@feed` sources compile to a SELECT over `events`, so only events-backed
  // (`collected`) feeds can back one. A `streaming` feed's rows live in
  // `channel_messages` and a `virtual` feed is an external live query — either
  // would validate here and then read empty. Reject them with a clear error
  // (loud, not silent) rather than compiling to a query that returns nothing.
  const collected = rows.filter((r) => (r.kind ?? 'collected') === 'collected');
  const ids = collected
    .map((r) => Number(r.id))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  if (ids.length === 0) {
    const other = rows.find((r) => (r.kind ?? 'collected') !== 'collected');
    if (other) {
      throw new Error(
        `@feed:${value} is a ${other.kind} feed; only collected (events-backed) feeds can be an @feed source`
      );
    }
    throw new Error(`@feed:${value} did not match any feed`);
  }
  return ids;
}

async function resolveConnectionId(
  sql: DbClient,
  organizationId: string,
  value: string
): Promise<number> {
  const id = numericRef(value);
  const rows = await sql<{ id: number | string }>`
    SELECT id
    FROM connections
    WHERE organization_id = ${organizationId}
      AND deleted_at IS NULL
      AND (
        ${id}::bigint IS NOT NULL AND id = ${id}::bigint
        OR slug = ${value}
        OR display_name = ${value}
      )
    ORDER BY id
    LIMIT 2
  `;
  if (rows.length === 0) throw new Error(`@connection:${value} did not match any connection`);
  if (rows.length > 1) throw new Error(`@connection:${value} matched more than one connection`);
  return Number(rows[0].id);
}

async function compileRefToQuery(
  sql: DbClient,
  organizationId: string,
  ref: WatcherSourceRef
): Promise<string | null> {
  switch (ref.type) {
    case 'feed': {
      const ids = await resolveFeedIds(sql, organizationId, ref.value);
      return eventSelect(`feed_id IN (${ids.join(',')})`);
    }
    case 'connection': {
      const id = await resolveConnectionId(sql, organizationId, ref.value);
      return eventSelect(`connection_id = ${id}`);
    }
    case 'connector': {
      if (!SAFE_CONNECTOR_RE.test(ref.value)) {
        throw new Error('@connector refs must be plain connector keys');
      }
      return eventSelect(`connector_key = ${sqlString(ref.value)}`);
    }
    case 'channel': {
      const raw = ref.value.startsWith('#') ? ref.value.slice(1) : ref.value;
      const channel = sqlString(raw);
      const hashChannel = sqlString(`#${raw}`);
      return eventSelect(
        [
          `metadata->>'channel' IN (${channel}, ${hashChannel})`,
          `metadata->>'channel_name' IN (${channel}, ${hashChannel})`,
          `metadata->>'channel_id' = ${raw ? channel : "''"}`,
          `payload_data->>'channel' IN (${channel}, ${hashChannel})`,
          `payload_data->>'channel_name' IN (${channel}, ${hashChannel})`,
          `payload_data->>'channel_id' = ${raw ? channel : "''"}`,
        ].join(' OR ')
      );
    }
    case 'entity':
      return (
        'SELECT id, entity_type, entity_type_id, parent_id, name, slug, metadata, created_at, updated_at ' +
        `FROM entities WHERE entity_type = ${sqlString(ref.value)} AND deleted_at IS NULL ` +
        'ORDER BY updated_at DESC'
      );
    case 'metric':
      return null;
  }
}

/**
 * Save-time resolution: every @ref must resolve in the org NOW, so a typo fails
 * at create/create_version/update (loud, 422) instead of at read_knowledge
 * (silent empty rows, or a swallowed metric error). This is the operational-
 * confidence counterpart to the syntax-only {@link validateWatcherSourceRef}:
 * it walks the same compile path the reader uses, plus existence checks for
 * @entity (type) and @metric (type + declared measure) that the reader otherwise
 * discovers by returning empty. @feed / @connection misses throw via
 * {@link normalizeWatcherSources}; @connector checks a connection uses that key;
 * @channel is free-form (no static registry) and left unchecked.
 */
export async function resolveWatcherSourcesForSave(
  sql: DbClient,
  organizationId: string,
  sources: WatcherSource[]
): Promise<void> {
  for (const source of sources) {
    const ref = parseWatcherSourceRef(source.query);
    if (!ref) continue; // custom SQL — id projection is enforced by the caller's config validation

    if (ref.type === 'entity') {
      const exists = await sql<{ id: number }>`
        SELECT id FROM entity_types
        WHERE slug = ${ref.value}
          AND organization_id = ${organizationId}
          AND deleted_at IS NULL
        LIMIT 1
      `;
      if (exists.length === 0) {
        throw new Error(
          `source "${source.name}": @entity:${ref.value} is not an entity type in this organization`
        );
      }
      continue;
    }

    if (ref.type === 'metric') {
      const rows = await sql<{ id: number; metrics_config: unknown }>`
        SELECT id, metrics_config FROM entity_types
        WHERE slug = ${ref.entityType}
          AND organization_id = ${organizationId}
          AND deleted_at IS NULL
        LIMIT 1
      `;
      if (rows.length === 0) {
        throw new Error(
          `source "${source.name}": @metric:${ref.entityType}.${ref.measure} — entity type "${ref.entityType}" not found in this organization`
        );
      }
      const measures = (
        (rows[0].metrics_config as { measures?: Record<string, unknown> } | null) ?? {}
      ).measures ?? {};
      if (!(ref.measure in measures)) {
        throw new Error(
          `source "${source.name}": @metric:${ref.entityType}.${ref.measure} — measure "${ref.measure}" is not declared on entity type "${ref.entityType}"`
        );
      }
      continue;
    }

    if (ref.type === 'connector') {
      const exists = await sql<{ id: number }>`
        SELECT id FROM connections
        WHERE organization_id = ${organizationId}
          AND deleted_at IS NULL
          AND connector_key = ${ref.value}
        LIMIT 1
      `;
      if (exists.length === 0) {
        throw new Error(
          `source "${source.name}": @connector:${ref.value} — no connection in this organization uses connector key "${ref.value}"`
        );
      }
    }
  }

  // Resolve feed/connection refs (throws on miss with the same message the
  // reader produces) so the full set is validated, not just the structured ones.
  await normalizeWatcherSources(sql, organizationId, sources);
}

export async function normalizeWatcherSources(
  sql: DbClient,
  organizationId: string,
  sources: WatcherSource[]
): Promise<NormalizedWatcherSource[]> {
  const normalized: NormalizedWatcherSource[] = [];
  for (const source of sources) {
    const ref = parseWatcherSourceRef(source.query);
    if (!ref) {
      normalized.push({ ...source, kind: 'event' });
      continue;
    }
    const kind = watcherSourceKindForRef(ref);
    const query = await compileRefToQuery(sql, organizationId, ref);
    normalized.push({
      name: source.name,
      query: query ?? source.query,
      kind,
      ref,
    });
  }
  return normalized;
}
