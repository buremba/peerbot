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
import { type DbClient, getDb, pgTextArray } from '../db/client';
import { resolveEntityLinkRules } from './entity-link-validation';
import logger from './logger';
import { getValueAtPath } from './object-path';
import { TtlCache } from './ttl-cache';

interface BatchItem {
  origin_type?: string;
  metadata?: Record<string, unknown>;
  title?: string | null;
}

interface RuleMap {
  [kind: string]: EntityLinkRule[];
}

const RULES_CACHE_TTL_MS = 60_000;
// Per-pod caches — no cross-replica sharing.
const rulesCache = new TtlCache<RuleMap>(RULES_CACHE_TTL_MS);
const creatorCache = new TtlCache<string | null>(RULES_CACHE_TTL_MS);

async function resolveOrgCreator(orgId: string): Promise<string | null> {
  return creatorCache.getOrSet(orgId, async () => {
    const sql = getDb();
    const rows = await sql<{ userId: string }>`
      SELECT "userId"
      FROM "member"
      WHERE "organizationId" = ${orgId}
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               "createdAt" ASC
      LIMIT 1
    `;
    return rows.length > 0 ? rows[0].userId : null;
  });
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
  return rulesCache.getOrSet(cacheKey, async () => {
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
    return result;
  });
}

export function clearEntityLinkRulesCache(): void {
  rulesCache.clear();
  creatorCache.clear();
}

type ExtractedLink = {
  identities: Array<{
    namespace: string;
    identifier: string;
    matchOnly: boolean;
    primary: boolean;
  }>;
  traits: Map<string, unknown>;
  title: string;
};

function extractLink(item: BatchItem, rule: EntityLinkRule): ExtractedLink | null {
  const identities: ExtractedLink['identities'] = [];
  for (const spec of rule.identities) {
    const raw = getValueAtPath(item, spec.eventPath);
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const normalized = normalizeIdentifier(spec.namespace, raw);
    if (!normalized) continue;
    identities.push({
      namespace: spec.namespace,
      identifier: normalized,
      matchOnly: spec.matchOnly === true,
      primary: spec.primary === true,
    });
  }
  if (identities.length === 0) return null;

  const traits = new Map<string, unknown>();
  if (rule.traits) {
    for (const [key, spec] of Object.entries(rule.traits)) {
      const value = getValueAtPath(item, spec.eventPath);
      if (value !== undefined) traits.set(key, value);
    }
  }

  const rawTitle = rule.titlePath ? getValueAtPath(item, rule.titlePath) : undefined;
  const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : '';

  return { identities, traits, title };
}

async function lookupMatches(
  sql: DbClient,
  params: {
    orgId: string;
    entityType: string;
    identities: ExtractedLink['identities'][];
  }
): Promise<Map<string, number>> {
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

async function createEntityWithIdentities(
  sql: DbClient,
  params: {
    orgId: string;
    connectorKey: string;
    entityType: string;
    title: string;
    identities: ExtractedLink['identities'];
    traits: Map<string, unknown>;
    creatorUserId: string;
  }
): Promise<{ entityId: number; attached: Array<{ namespace: string; identifier: string }> } | null> {
  const persisted = params.identities.filter((i) => !i.matchOnly);
  if (persisted.length === 0) return null;

  const name = params.title || persisted[0].identifier;
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of params.traits) metadata[key] = value;

  // Resolve entity_type slug → entity_types(id). Same schema search path as
  // createEntity: try the entity's own org first, then any visibility='public'
  // catalog. First match wins. See createEntity for the slug-poisoning caveat.
  const typeRow = await sql<{ id: number; backing_sql: string | null }>`
    SELECT et.id, et.backing_sql
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
  // Derived (view-backed) types have no stored rows — skip auto-create (the
  // view ignores any row this would insert). Mirrors createEntity's guard for
  // this separate connector/link insert path.
  if (typeRow[0].backing_sql) {
    logger.warn(
      { entityType: params.entityType, orgId: params.orgId },
      'entity auto-create skipped: entity type is derived (a SQL view)'
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

  const attached = await insertIdentities(sql, {
    orgId: params.orgId,
    entityId,
    connectorKey: params.connectorKey,
    identities: persisted,
  });
  return { entityId, attached };
}

/**
 * Insert identities for `entityId`, RETURNING the `(namespace, identifier)` rows
 * that actually attached. A row skipped by ON CONFLICT (identifier already owned
 * by another entity) is NOT returned, so the caller won't mis-claim it.
 */
async function insertIdentities(
  sql: DbClient,
  params: {
    orgId: string;
    entityId: number;
    connectorKey: string;
    identities: ExtractedLink['identities'];
  }
): Promise<Array<{ namespace: string; identifier: string }>> {
  if (params.identities.length === 0) return [];
  const namespaces = params.identities.map((i) => i.namespace);
  const identifiers = params.identities.map((i) => i.identifier);
  try {
    const attached = await sql<{ namespace: string; identifier: string }>`
      INSERT INTO entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector
      )
      SELECT ${params.orgId}, ${params.entityId}, v.ns, v.ident, ${`connector:${params.connectorKey}`}
      FROM unnest(${pgTextArray(namespaces)}::text[], ${pgTextArray(identifiers)}::text[]) AS v(ns, ident)
      ON CONFLICT (organization_id, namespace, identifier) WHERE deleted_at IS NULL
      DO NOTHING
      RETURNING namespace, identifier
    `;
    return attached.map((r) => ({ namespace: r.namespace, identifier: r.identifier }));
  } catch (err) {
    logger.warn({ err, entityId: params.entityId }, 'entity_identities insert failed');
    return [];
  }
}

async function applyTraits(
  sql: DbClient,
  params: {
    orgId: string;
    entityId: number;
    rule: EntityLinkRule;
    traits: Map<string, unknown>;
    isCreate: boolean;
  }
): Promise<void> {
  if (!params.rule.traits || params.traits.size === 0) return;

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
 * traits onto the resolved entity. Rules are loaded from the connector
 * definition (poll/sync path).
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

  await resolveLinksByKind({
    connectorKey: params.connectorKey,
    orgId: params.orgId,
    items: params.items,
    rulesByKind,
  });
}

/**
 * Resolve entity links for items using caller-supplied rules instead of the
 * connector-definition store. The live webhook path (handleWebhookIngest /
 * app-webhooks router) lands under `connector_key='webhook:%'` with no feed, so
 * it can't load rules from `connector_definitions` — it passes the rule set
 * directly here. Same machinery as the poll path (normalize → match-or-create →
 * stamp metadata → merge traits), but it ALSO returns the resolved entity ids
 * per item (keyed by `items` array index) so the caller can write
 * `events.entity_ids` (a webhook row is read by id, not via a feed-time JOIN).
 * `rules` is keyed by event kind (origin_type). Tenant-scoped on `orgId`;
 * entity_identities are UNIQUE per (org, namespace, identifier), so resolution
 * never crosses organizations.
 */
export async function resolveEntityLinksForItems(
  params: {
    connectorKey: string;
    orgId: string;
    items: BatchItem[];
    rules: RuleMap;
  },
  // Optional transaction handle — the webhook winner passes its tx so the actor
  // graph writes commit atomically with the event insert. Omitted → getDb().
  sql?: DbClient
): Promise<Map<number, number[]>> {
  if (params.items.length === 0) return new Map();
  return resolveLinksByKind(
    {
      connectorKey: params.connectorKey,
      orgId: params.orgId,
      items: params.items,
      rulesByKind: params.rules,
    },
    sql ?? getDb()
  );
}

/**
 * Core resolver shared by the poll path ({@link applyEntityLinks}) and the
 * webhook path ({@link resolveEntityLinksForItems}). Given rules grouped by
 * event kind, resolve or auto-create the target entity for each item, stamp the
 * canonical identifier metadata slots (for read-time JOINs), and merge declared
 * traits. Returns a per-item map (by array index) of resolved entity ids.
 */
async function resolveLinksByKind(
  params: {
    connectorKey: string;
    orgId: string;
    items: BatchItem[];
    rulesByKind: RuleMap;
  },
  // The DB handle for ALL match/insert/update writes. The webhook winner threads
  // its transaction here so the event insert + actor graph writes + entity_ids
  // update are one atomic tx; the poll path passes nothing → getDb() singleton.
  sql: DbClient = getDb()
): Promise<Map<number, number[]>> {
  const resolvedByItem = new Map<number, number[]>();
  if (Object.keys(params.rulesByKind).length === 0 || params.items.length === 0) {
    return resolvedByItem;
  }

  // entities.created_by is NOT NULL; resolve an org owner/admin once per batch
  // so auto-created entities attribute to a real member rather than a seed user.
  const creatorUserId = await resolveOrgCreator(params.orgId);

  // rule -> per-item extracted link, carrying the source item + index (the
  // caller recovers the resolved entity per item; metadata is stamped onto the
  // item post-resolution).
  const byRule = new Map<
    EntityLinkRule,
    Array<{ index: number; item: BatchItem; link: ExtractedLink }>
  >();
  params.items.forEach((item, index) => {
    const kind = item.origin_type;
    if (!kind) return;
    const rules = params.rulesByKind[kind];
    if (!rules) return;
    for (const rule of rules) {
      const link = extractLink(item, rule);
      if (!link) continue;
      // Metadata stamping is deferred to post-resolution (below) — only
      // attached identifiers are stamped, so a stale one (e.g. a vacated
      // github_login) can't make read-time JOINs attribute to the wrong person.
      let bucket = byRule.get(rule);
      if (!bucket) {
        bucket = [];
        byRule.set(rule, bucket);
      }
      bucket.push({ index, item, link });
    }
  });
  if (byRule.size === 0) return resolvedByItem;

  const recordResolved = (index: number, entityId: number): void => {
    const existing = resolvedByItem.get(index);
    if (existing) {
      if (!existing.includes(entityId)) existing.push(entityId);
    } else {
      resolvedByItem.set(index, [entityId]);
    }
  };

  for (const [rule, entries] of byRule) {
    const matches = await lookupMatches(sql, {
      orgId: params.orgId,
      entityType: rule.entityType,
      identities: entries.map((e) => e.link.identities),
    });

    for (const { index, item, link } of entries) {
      // A present `primary` identity (immutable, e.g. github_user_id) is
      // authoritative: it governs even when it matches nothing (a new account),
      // so a stale non-primary like a reused github_login can't merge it into the
      // old person. Without a primary, identities match equal-weight (the
      // cross-channel behavior whatsapp/email rely on).
      let entityId: number | null = null;
      let isCreate = false;
      let ambiguous = false;
      const hitFor = (id: { namespace: string; identifier: string }) =>
        matches.get(`${id.namespace}\u0000${id.identifier}`);
      const primaries = link.identities.filter((i) => i.primary);
      if (primaries.length > 0) {
        const primaryHits = new Set<number>();
        for (const id of primaries) {
          const h = hitFor(id);
          if (h !== undefined) primaryHits.add(h);
        }
        if (primaryHits.size > 1) {
          ambiguous = true;
        } else if (primaryHits.size === 1) {
          entityId = [...primaryHits][0];
        }
        // size 0 = present-but-unmatched → leave null so a new entity is created.
      } else {
        // No primary present → union all identity hits equal-weight.
        const resolved = new Set<number>();
        for (const id of link.identities) {
          const h = hitFor(id);
          if (h !== undefined) resolved.add(h);
        }
        if (resolved.size > 1) {
          ambiguous = true;
        } else if (resolved.size === 1) {
          entityId = [...resolved][0];
        }
      }

      if (ambiguous) {
        logger.warn(
          {
            orgId: params.orgId,
            connectorKey: params.connectorKey,
            entityType: rule.entityType,
            identifiers: link.identities.map((i) => `${i.namespace}:${i.identifier}`),
          },
          'entityLink merge candidate — multiple entities matched at the same identity tier'
        );
        continue;
      }

      // Identities that ACTUALLY attached to the resolved/created entity. We
      // only ever claim THESE in the in-memory matches map below — an identifier
      // that ON CONFLICT-skipped because another entity already owns it stays
      // with that entity, so the map must not mis-claim it for this one.
      let attached: Array<{ namespace: string; identifier: string }> = [];
      if (entityId !== null) {
        // Matched an existing entity: accrete the non-matchOnly identities; the
        // identifier(s) we matched on already belong to this entity.
        attached = await insertIdentities(sql, {
          orgId: params.orgId,
          entityId,
          connectorKey: params.connectorKey,
          identities: link.identities.filter((i) => !i.matchOnly),
        });
        // The matched identifiers themselves are this entity's even if a
        // re-insert was a no-op (they were how we found it), so claim them too.
        for (const id of link.identities) {
          if (matches.get(`${id.namespace}\u0000${id.identifier}`) === entityId) {
            attached.push({ namespace: id.namespace, identifier: id.identifier });
          }
        }
      } else if (rule.autoCreate) {
        if (!creatorUserId) {
          logger.warn(
            { orgId: params.orgId, entityType: rule.entityType },
            'autoCreate skipped: org has no member to attribute as creator'
          );
          continue;
        }
        const created = await createEntityWithIdentities(sql, {
          orgId: params.orgId,
          connectorKey: params.connectorKey,
          entityType: rule.entityType,
          title: link.title,
          identities: link.identities,
          traits: link.traits,
          creatorUserId,
        });
        if (created !== null && created.attached.length > 0) {
          entityId = created.entityId;
          attached = created.attached;
          isCreate = true;
        } else if (created !== null) {
          // Concurrent auto-create lost the identity race: every identifier went
          // to the winner via ON CONFLICT, so the row we just inserted is an
          // identity-less orphan. Hard-delete it (no events reference a row born
          // this turn) and re-resolve to the winning entity.
          await sql`
            DELETE FROM entities
            WHERE id = ${created.entityId} AND organization_id = ${params.orgId}
          `;
          const winner = await lookupMatches(sql, {
            orgId: params.orgId,
            entityType: rule.entityType,
            identities: [link.identities],
          });
          const winnerIds = new Set<number>();
          for (const id of link.identities) {
            const h = winner.get(`${id.namespace}\u0000${id.identifier}`);
            if (h !== undefined) winnerIds.add(h);
          }
          if (winnerIds.size === 1) {
            entityId = [...winnerIds][0];
            for (const id of link.identities) {
              if (winner.get(`${id.namespace}\u0000${id.identifier}`) === entityId) {
                attached.push({ namespace: id.namespace, identifier: id.identifier });
              }
            }
          }
          // size !== 1 (gone/ambiguous) → leave entityId null; skip.
        }
      }

      if (entityId === null) continue;

      await applyTraits(sql, {
        orgId: params.orgId,
        entityId,
        rule,
        traits: link.traits,
        isCreate,
      });

      recordResolved(index, entityId);

      // Cache the mapping for later items in the same batch — only for attached
      // identifiers, so an identifier that stayed on another entity (ON CONFLICT
      // no-op) keeps its existing owner and isn't mis-claimed.
      for (const id of attached) {
        matches.set(`${id.namespace}\u0000${id.identifier}`, entityId);
      }

      // Stamp metadata slots for attached identifiers only — read-time JOINs key
      // on events.metadata->>namespace, so a stale slot would mis-attribute.
      const md = (item.metadata ??= {});
      for (const id of attached) {
        md[id.namespace] = id.identifier;
      }
    }
  }

  return resolvedByItem;
}
