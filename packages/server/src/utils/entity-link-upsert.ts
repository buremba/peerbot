/**
 * Declarative entity-link resolver at event ingestion.
 *
 * A connector declares `eventKinds[kind].entityLinks[]` rules. Each rule maps
 * event identifier fields (phone, email, wa_jid, ...) to a target entity type.
 * The ingestion pipeline:
 *   1) Extracts + normalizes identifiers from each event.
 *   2) Looks them up in the normalized `entity_identities` table
 *      (UNIQUE per (org, namespace, identifier)).
 *   3) Links to the matched entity, creates on miss (when autoCreate=true),
 *      logs a merge candidate when one event's identifiers resolve to
 *      multiple distinct entities.
 *   4) Merges declared `traits` onto entities.metadata per behavior.
 *
 * Never mutates `events.entity_ids` — events stay immutable, JOIN-at-read
 * recovers the relationship via entity_identities.
 */

import { randomBytes } from 'node:crypto';
import type { EntityLinkOverrides, EntityLinkRule } from '@lobu/connector-sdk';
import { normalizeIdentifier } from '@lobu/connector-sdk';
import { getDb, pgTextArray } from '../db/client';
import { resolveEntityLinkRules } from './entity-link-validation';
import logger from './logger';

interface BatchItem {
  origin_type?: string;
  metadata?: Record<string, unknown>;
  title?: string | null;
}

interface RuleMap {
  [kind: string]: EntityLinkRule[];
}

const RULES_CACHE_TTL_MS = 60_000;
const rulesCache = new Map<string, { value: RuleMap; expiresAt: number }>();
const creatorCache = new Map<string, { value: string | null; expiresAt: number }>();

async function resolveOrgCreator(orgId: string): Promise<string | null> {
  const now = Date.now();
  const cached = creatorCache.get(orgId);
  if (cached && cached.expiresAt > now) return cached.value;

  const sql = getDb();
  const rows = await sql<{ userId: string }>`
    SELECT "userId"
    FROM "member"
    WHERE "organizationId" = ${orgId}
    ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
             "createdAt" ASC
    LIMIT 1
  `;
  const value = rows.length > 0 ? rows[0].userId : null;
  creatorCache.set(orgId, { value, expiresAt: now + RULES_CACHE_TTL_MS });
  return value;
}

function readPath(source: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = source;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function randomSlug(entityType: string): string {
  const prefix =
    entityType
      .replace(/^\$/, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .toLowerCase() || 'entity';
  return `${prefix}-${randomBytes(5).toString('hex')}`;
}

async function loadEntityLinkRules(params: {
  connectorKey: string;
  feedKey: string;
  orgId: string;
}): Promise<RuleMap> {
  const cacheKey = `${params.orgId}:${params.connectorKey}:${params.feedKey}`;
  const now = Date.now();
  const cached = rulesCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const sql = getDb();
  const rows = await sql`
    SELECT feeds_schema, entity_link_overrides
    FROM connector_definitions
    WHERE key = ${params.connectorKey}
      AND organization_id = ${params.orgId}
    LIMIT 1
  `;

  const result: RuleMap = {};
  const feedsSchema = rows[0]?.feeds_schema as Record<string, any> | null | undefined;
  const overrides = rows[0]?.entity_link_overrides as EntityLinkOverrides | null | undefined;
  const feedDef = feedsSchema?.[params.feedKey];
  const eventKinds = feedDef?.eventKinds as
    | Record<string, { entityLinks?: EntityLinkRule[] }>
    | undefined;
  if (eventKinds) {
    for (const [kind, def] of Object.entries(eventKinds)) {
      if (Array.isArray(def?.entityLinks) && def.entityLinks.length > 0) {
        const resolved = resolveEntityLinkRules(def.entityLinks, overrides);
        if (resolved.length > 0) result[kind] = resolved;
      }
    }
  }

  rulesCache.set(cacheKey, { value: result, expiresAt: now + RULES_CACHE_TTL_MS });
  return result;
}

export function clearEntityLinkRulesCache(): void {
  rulesCache.clear();
  creatorCache.clear();
}

type ExtractedLink = {
  identities: Array<{ namespace: string; identifier: string; matchOnly: boolean }>;
  traits: Map<string, unknown>;
  title: string;
};

function extractLink(item: BatchItem, rule: EntityLinkRule): ExtractedLink | null {
  const identities: ExtractedLink['identities'] = [];
  for (const spec of rule.identities) {
    const raw = readPath(item, spec.eventPath);
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const normalized = normalizeIdentifier(spec.namespace, raw);
    if (!normalized) continue;
    identities.push({
      namespace: spec.namespace,
      identifier: normalized,
      matchOnly: spec.matchOnly === true,
    });
  }
  if (identities.length === 0) return null;

  const traits = new Map<string, unknown>();
  if (rule.traits) {
    for (const [key, spec] of Object.entries(rule.traits)) {
      const value = readPath(item, spec.eventPath);
      if (value !== undefined) traits.set(key, value);
    }
  }

  const rawTitle = rule.titlePath ? readPath(item, rule.titlePath) : undefined;
  const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : '';

  return { identities, traits, title };
}

async function lookupMatches(params: {
  orgId: string;
  entityType: string;
  identities: ExtractedLink['identities'][];
}): Promise<Map<string, number>> {
  const keys = new Set<string>();
  for (const arr of params.identities) {
    for (const id of arr) keys.add(`${id.namespace}\u0000${id.identifier}`);
  }
  if (keys.size === 0) return new Map();

  const namespaces: string[] = [];
  const identifiers: string[] = [];
  for (const key of keys) {
    const [ns, ident] = key.split('\u0000');
    namespaces.push(ns);
    identifiers.push(ident);
  }

  const sql = getDb();
  const rows = await sql<{ entity_id: number | string; namespace: string; identifier: string }>`
    SELECT ei.entity_id, ei.namespace, ei.identifier
    FROM entity_identities ei
    JOIN entities e ON e.id = ei.entity_id
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE ei.organization_id = ${params.orgId}
      AND ei.deleted_at IS NULL
      AND e.deleted_at IS NULL
      AND et.slug = ${params.entityType}
      AND (ei.namespace, ei.identifier) IN (
        SELECT ns, ident FROM unnest(${pgTextArray(namespaces)}::text[], ${pgTextArray(identifiers)}::text[]) AS u(ns, ident)
      )
  `;

  const out = new Map<string, number>();
  for (const row of rows) {
    out.set(`${row.namespace}\u0000${row.identifier}`, Number(row.entity_id));
  }
  return out;
}

async function createEntityWithIdentities(params: {
  orgId: string;
  connectorKey: string;
  entityType: string;
  title: string;
  identities: ExtractedLink['identities'];
  traits: Map<string, unknown>;
  creatorUserId: string;
}): Promise<number | null> {
  const sql = getDb();
  const persisted = params.identities.filter((i) => !i.matchOnly);
  if (persisted.length === 0) return null;

  const name = params.title || persisted[0].identifier;
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of params.traits) metadata[key] = value;

  // Resolve entity_type slug → entity_types(id). Same schema search path as
  // createEntity: try the entity's own org first, then any visibility='public'
  // catalog. First match wins. See createEntity for the slug-poisoning caveat.
  const typeRow = await sql<{ id: number }>`
    SELECT et.id
    FROM entity_types et
    LEFT JOIN organization o ON o.id = et.organization_id
    WHERE et.slug = ${params.entityType}
      AND et.deleted_at IS NULL
      AND (
        et.organization_id = ${params.orgId}
        OR o.visibility = 'public'
      )
    ORDER BY (et.organization_id = ${params.orgId}) DESC, et.id ASC
    LIMIT 1
  `;
  if (typeRow.length === 0) {
    logger.warn(
      { entityType: params.entityType, orgId: params.orgId },
      'entity create failed: unknown entity type'
    );
    return null;
  }
  const entityTypeId = typeRow[0].id;

  // Try a few slug variants to defuse improbable random collisions.
  let entityId: number | null = null;
  for (let attempt = 0; attempt < 3 && entityId === null; attempt++) {
    const slug = randomSlug(params.entityType);
    try {
      const rows = await sql<{ id: number | string }>`
        INSERT INTO entities (
          organization_id, entity_type_id, name, slug, metadata,
          created_by, created_at, updated_at
        )
        VALUES (
          ${params.orgId}, ${entityTypeId}, ${name}, ${slug},
          ${sql.json(metadata)},
          ${params.creatorUserId}, current_timestamp, current_timestamp
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (rows.length > 0) entityId = Number(rows[0].id);
    } catch (err) {
      logger.warn({ err, entityType: params.entityType }, 'entity create failed');
    }
  }
  if (entityId === null) return null;

  await insertIdentities({
    orgId: params.orgId,
    entityId,
    connectorKey: params.connectorKey,
    identities: persisted,
  });
  return entityId;
}

async function insertIdentities(params: {
  orgId: string;
  entityId: number;
  connectorKey: string;
  identities: ExtractedLink['identities'];
}): Promise<void> {
  if (params.identities.length === 0) return;
  const sql = getDb();
  const namespaces = params.identities.map((i) => i.namespace);
  const identifiers = params.identities.map((i) => i.identifier);
  try {
    await sql`
      INSERT INTO entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector
      )
      SELECT ${params.orgId}, ${params.entityId}, v.ns, v.ident, ${`connector:${params.connectorKey}`}
      FROM unnest(${pgTextArray(namespaces)}::text[], ${pgTextArray(identifiers)}::text[]) AS v(ns, ident)
      ON CONFLICT (organization_id, namespace, identifier) WHERE deleted_at IS NULL
      DO NOTHING
    `;
  } catch (err) {
    logger.warn({ err, entityId: params.entityId }, 'entity_identities insert failed');
  }
}

async function applyTraits(params: {
  orgId: string;
  entityId: number;
  rule: EntityLinkRule;
  traits: Map<string, unknown>;
  isCreate: boolean;
}): Promise<void> {
  if (!params.rule.traits || params.traits.size === 0) return;
  const sql = getDb();

  // init_only traits were written to metadata at create time; nothing to do now.
  const overwrite: Record<string, unknown> = {};
  const preferNonEmpty: Record<string, unknown> = {};
  for (const [key, value] of params.traits) {
    const spec = params.rule.traits[key];
    if (!spec || spec.behavior === 'init_only') continue;
    if (value === undefined) continue;
    if (spec.behavior === 'overwrite') {
      overwrite[key] = value;
    } else if (spec.behavior === 'prefer_non_empty') {
      const empty = value === null || value === '';
      if (!empty) preferNonEmpty[key] = value;
    }
  }
  if (Object.keys(overwrite).length === 0 && Object.keys(preferNonEmpty).length === 0) return;

  // Read-modify-write the metadata jsonb. A single worker processes a given
  // (connector, run) batch sequentially, so intra-batch races are impossible;
  // cross-batch races touching the same entity are rare enough to accept
  // last-writer-wins.
  const rows = await sql<{ metadata: Record<string, unknown> | null }>`
    SELECT metadata
    FROM entities
    WHERE id = ${params.entityId}
      AND organization_id = ${params.orgId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (rows.length === 0) return;
  const current = rows[0].metadata ?? {};

  const next: Record<string, unknown> = { ...current, ...overwrite };
  for (const [key, value] of Object.entries(preferNonEmpty)) {
    const existing = current[key];
    if (existing === undefined || existing === null || existing === '') {
      next[key] = value;
    }
  }

  await sql`
    UPDATE entities
    SET metadata = ${sql.json(next)},
        updated_at = current_timestamp
    WHERE id = ${params.entityId}
      AND organization_id = ${params.orgId}
      AND deleted_at IS NULL
  `;
}

/**
 * Per-batch ingestion hook. Looks up or creates target entities for each
 * item using the normalized entity_identities index, then merges declared
 * traits onto the resolved entity.
 */
export async function applyEntityLinks(params: {
  connectorKey: string;
  feedKey: string | null;
  orgId: string;
  items: BatchItem[];
}): Promise<void> {
  if (!params.feedKey || params.items.length === 0) return;

  const rulesByKind = await loadEntityLinkRules({
    connectorKey: params.connectorKey,
    feedKey: params.feedKey,
    orgId: params.orgId,
  });
  if (Object.keys(rulesByKind).length === 0) return;

  // entities.created_by is NOT NULL; resolve an org owner/admin once per batch
  // so auto-created entities attribute to a real member rather than a seed user.
  const creatorUserId = await resolveOrgCreator(params.orgId);

  // rule -> per-item extracted link
  const byRule = new Map<EntityLinkRule, ExtractedLink[]>();
  for (const item of params.items) {
    const kind = item.origin_type;
    if (!kind) continue;
    const rules = rulesByKind[kind];
    if (!rules) continue;
    for (const rule of rules) {
      const link = extractLink(item, rule);
      if (!link) continue;
      // Stamp the normalized identifier into a canonical metadata slot keyed by
      // namespace. This is what read-time JOINs (entity_identities.namespace +
      // identifier) match against, shielding queries from connector-specific
      // metadata key naming (metadata.from_email, metadata.sender_phone, …).
      const md = (item.metadata ??= {});
      for (const id of link.identities) {
        md[id.namespace] = id.identifier;
      }
      let bucket = byRule.get(rule);
      if (!bucket) {
        bucket = [];
        byRule.set(rule, bucket);
      }
      bucket.push(link);
    }
  }
  if (byRule.size === 0) return;

  for (const [rule, links] of byRule) {
    const matches = await lookupMatches({
      orgId: params.orgId,
      entityType: rule.entityType,
      identities: links.map((l) => l.identities),
    });

    for (const link of links) {
      const resolved = new Set<number>();
      for (const id of link.identities) {
        const hit = matches.get(`${id.namespace}\u0000${id.identifier}`);
        if (hit !== undefined) resolved.add(hit);
      }

      if (resolved.size > 1) {
        logger.warn(
          {
            orgId: params.orgId,
            connectorKey: params.connectorKey,
            entityType: rule.entityType,
            candidates: Array.from(resolved),
            identifiers: link.identities.map((i) => `${i.namespace}:${i.identifier}`),
          },
          'entityLink merge candidate — multiple entities matched'
        );
        continue;
      }

      let entityId: number | null = null;
      let isCreate = false;

      if (resolved.size === 1) {
        entityId = Array.from(resolved)[0];
        await insertIdentities({
          orgId: params.orgId,
          entityId,
          connectorKey: params.connectorKey,
          identities: link.identities.filter((i) => !i.matchOnly),
        });
      } else if (rule.autoCreate) {
        if (!creatorUserId) {
          logger.warn(
            { orgId: params.orgId, entityType: rule.entityType },
            'autoCreate skipped: org has no member to attribute as creator'
          );
          continue;
        }
        entityId = await createEntityWithIdentities({
          orgId: params.orgId,
          connectorKey: params.connectorKey,
          entityType: rule.entityType,
          title: link.title,
          identities: link.identities,
          traits: link.traits,
          creatorUserId,
        });
        isCreate = entityId !== null;
      }

      if (entityId === null) continue;

      await applyTraits({
        orgId: params.orgId,
        entityId,
        rule,
        traits: link.traits,
        isCreate,
      });

      // Cache the new mapping so later items in the same rule-batch that share
      // identifiers resolve to the entity we just created/matched.
      for (const id of link.identities) {
        matches.set(`${id.namespace}\u0000${id.identifier}`, entityId);
      }
    }
  }
}
