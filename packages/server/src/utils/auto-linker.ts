/**
 * NER-Lite Auto-Linker
 *
 * Scans event content for entity name mentions and creates
 * `mentions` relationships automatically. Fire-and-forget pattern.
 */

import { getDb } from '../db/client';
import logger from './logger';

interface AutoLinkParams {
  eventId: number;
  entityIds: number[];
  content: string;
  title?: string | null;
  organizationId: string;
}

interface EntityCandidate {
  id: number;
  name: string;
  entity_type: string;
}

// Per-org entity name cache (60s TTL)
const entityCache = new Map<string, { entities: EntityCandidate[]; ts: number }>();
const CACHE_TTL_MS = 60_000;
const MAX_CONTENT_LENGTH = 5_000;
const MAX_AUTO_LINKS = 20;
const MIN_NAME_LENGTH = 3;

async function getOrgEntities(organizationId: string): Promise<EntityCandidate[]> {
  const cached = entityCache.get(organizationId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.entities;

  const sql = getDb();
  const rows = await sql`
    SELECT e.id, e.name, et.slug AS entity_type
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.organization_id = ${organizationId}
      AND e.deleted_at IS NULL
      AND length(e.name) >= ${MIN_NAME_LENGTH}
    ORDER BY length(e.name) DESC
  `;

  const entities = rows.map((r) => ({
    id: Number(r.id),
    name: r.name as string,
    entity_type: r.entity_type as string,
  }));

  entityCache.set(organizationId, { entities, ts: Date.now() });
  return entities;
}

async function ensureMentionsType(organizationId: string): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    INSERT INTO entity_relationship_types
      (slug, name, description, organization_id, is_symmetric, created_by, created_at, updated_at)
    VALUES
      ('mentions', 'Mentions', 'Auto-discovered content reference', ${organizationId},
       false, NULL, current_timestamp, current_timestamp)
    ON CONFLICT (organization_id, slug) WHERE status = 'active'
    DO UPDATE SET updated_at = EXCLUDED.updated_at
    RETURNING id
  `;
  return Number(rows[0].id);
}

/**
 * Scan content for entity name mentions and create relationships.
 */
export async function autoLinkEvent(params: AutoLinkParams): Promise<void> {
  const { entityIds, content, title, organizationId } = params;
  if (!content && !title) return;

  const allEntities = await getOrgEntities(organizationId);
  const sourceSet = new Set(entityIds);

  // Combine title + content, cap length
  const searchText = [title, content].filter(Boolean).join(' ').slice(0, MAX_CONTENT_LENGTH);

  const matched = new Set<number>();
  const candidates: { fromId: number; toId: number }[] = [];

  for (const entity of allEntities) {
    if (sourceSet.has(entity.id) || matched.has(entity.id)) continue;

    const escaped = entity.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');

    if (regex.test(searchText)) {
      matched.add(entity.id);
      for (const sourceId of entityIds) {
        if (sourceId === entity.id) continue;
        candidates.push({ fromId: sourceId, toId: entity.id });
        if (candidates.length >= MAX_AUTO_LINKS) break;
      }
      if (candidates.length >= MAX_AUTO_LINKS) break;
    }
  }

  if (candidates.length === 0) return;

  const sql = getDb();
  const typeId = await ensureMentionsType(organizationId);
  let created = 0;

  for (const { fromId, toId } of candidates) {
    const { from, to } = { from: fromId, to: toId };

    // `mentions` is directional. Only skip when the same directional type already exists.
    const existing = await sql`
      SELECT id FROM entity_relationships
      WHERE from_entity_id = ${from} AND to_entity_id = ${to}
        AND relationship_type_id = ${typeId}
        AND organization_id = ${organizationId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (existing.length > 0) continue;

    await sql`
      INSERT INTO entity_relationships (
        organization_id, from_entity_id, to_entity_id, relationship_type_id,
        confidence, source, created_by, updated_by, created_at, updated_at
      ) VALUES (
        ${organizationId}, ${from}, ${to}, ${typeId},
        0.4, 'feed', NULL, NULL,
        current_timestamp, current_timestamp
      )
    `;
    created++;
  }

  if (created > 0) {
    logger.debug(
      { created, eventId: params.eventId, matched: matched.size },
      '[auto-linker] Links created'
    );
  }
}
