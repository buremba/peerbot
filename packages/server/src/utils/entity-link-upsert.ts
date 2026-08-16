/**
 * Declarative entity-link resolver at event ingestion.
 *
 * A connector declares `eventKinds[kind].attributions[]` rules. Each attribution
 * maps event identifier fields (phone, email, wa_jid, ...) to a target entity.
 * The ingestion pipeline:
 *   1) Extracts + normalizes identifiers from each event.
 *   2) Looks them up in the normalized `entity_identities` table
 *      (UNIQUE per (org, namespace, identifier)).
 *   3) Links to the matched entity, creates on miss (when autoCreate=true),
 *      logs a merge candidate when one event's identifiers resolve to
 *      multiple distinct entities.
 *   4) Merges declared `traits` onto entities.metadata per merge strategy.
 *
 * Never mutates `events.entity_ids` — events stay immutable, JOIN-at-read
 * recovers the relationship via entity_identities.
 */

import { randomBytes } from 'node:crypto';
import {
  ACL_RESOURCE_TYPE_SLUG,
  type EntityIdentitySpec,
  type EntityLinkPredicate,
  type EntityTraitSpec,
  type EventAttributionRule,
} from '@lobu/connector-sdk';
import { normalizeIdentifier } from '@lobu/connector-sdk/identity-normalize';
import { ensureResourceEntityType } from '../authz/acl-resource-type';
import { type DbClient, getDb, pgBigintArray, pgTextArray } from '../db/client';
import { normalizeConnectorIdentityValue } from '../identity/connector-identity-modules';
import {
  hardDeleteEntityRows,
  patchEntityRows,
  tryInsertEntityRow,
  withEntityWriteTransaction,
} from './entity-management';
import logger from './logger';
import { getValueAtPath } from './object-path';
import { TtlCache } from './ttl-cache';

interface BatchItem {
  origin_type?: string;
  metadata?: Record<string, unknown>;
  title?: string | null;
}

type ResolvedEventAttributionRule = {
  role: EventAttributionRule['role'];
  entityType: string;
  autoCreate?: boolean;
  createWhen?: EntityLinkPredicate;
  titlePath?: string;
  identities: EntityIdentitySpec[];
  traits?: Record<string, EntityTraitSpec>;
};

interface RuleMap {
  [kind: string]: ResolvedEventAttributionRule[];
}

type EventKindAttributionDefinition = {
  attributions?: EventAttributionRule[];
};

function resolveEventAttributions(
  def: EventKindAttributionDefinition | undefined
): ResolvedEventAttributionRule[] {
  return (def?.attributions ?? []).flatMap((rule) => {
    const identities = rule.target.identities;
    if (!rule.target.entityType || !Array.isArray(identities) || identities.length === 0) {
      return [];
    }
    return [
      {
        role: rule.role,
        entityType: rule.target.entityType,
        autoCreate: rule.autoCreate,
        createWhen: rule.target.createWhen,
        titlePath: rule.target.titlePath,
        identities,
        traits: rule.traits,
      },
    ];
  });
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

async function loadEventAttributionRules(params: {
  connectorKey: string;
  feedKey: string;
  orgId: string;
}): Promise<RuleMap> {
  const cacheKey = `${params.orgId}:${params.connectorKey}:${params.feedKey}`;
  return rulesCache.getOrSet(cacheKey, async () => {
    const sql = getDb();
    const rows = await sql`
      SELECT feeds_schema
      FROM connector_definitions
      WHERE key = ${params.connectorKey}
        AND organization_id = ${params.orgId}
      LIMIT 1
    `;

    const result: RuleMap = {};
    const feedsSchema = rows[0]?.feeds_schema as Record<string, any> | null | undefined;
    const feedDef = feedsSchema?.[params.feedKey];
    const eventKinds = feedDef?.eventKinds as Record<string, EventKindAttributionDefinition> | undefined;
    if (eventKinds) {
      for (const [kind, def] of Object.entries(eventKinds)) {
        const resolved = resolveEventAttributions(def);
        if (resolved.length > 0) result[kind] = resolved;
      }
    }
    return result;
  });
}

/**
 * Load the FIRST attribution rule matching `entityType` (and `role`, when given)
 * declared anywhere in the connector's feeds_schema. The live app-webhook path
 * resolves an actor without a feed context (a delivery names an event, not a
 * feed), and a connector's person attribution is identical across its feeds — so
 * any feed's rule serves.
 *
 * `role` disambiguates when one entity type is targeted by several roles on the
 * same kind (e.g. an X DM attributes `person` both `authored_by` and `about`):
 * pass the role the caller actually wants ('authored_by' for a webhook actor)
 * rather than relying on declaration order.
 */
export async function loadAttributionRuleByType(params: {
  connectorKey: string;
  orgId: string;
  entityType: string;
  role?: EventAttributionRule['role'];
}): Promise<ResolvedEventAttributionRule | null> {
  const roleKey = params.role ?? '__any__';
  const cacheKey = `${params.orgId}:${params.connectorKey}:__bytype__:${params.entityType}:${roleKey}`;
  const map = await rulesCache.getOrSet(cacheKey, async () => {
    const sql = getDb();
    const rows = await sql`
      SELECT feeds_schema
      FROM connector_definitions
      WHERE key = ${params.connectorKey}
        AND organization_id = ${params.orgId}
      LIMIT 1
    `;
    const result: RuleMap = {};
    const feedsSchema = rows[0]?.feeds_schema as Record<string, any> | null | undefined;
    if (feedsSchema) {
      for (const feed of Object.values(feedsSchema)) {
        const eventKinds = (feed as { eventKinds?: Record<string, EventKindAttributionDefinition> })
          ?.eventKinds;
        if (!eventKinds) continue;
        for (const def of Object.values(eventKinds)) {
          const match = resolveEventAttributions(def).find(
            (r) =>
              r.entityType === params.entityType &&
              (params.role === undefined || r.role === params.role),
          );
          if (match) {
            result[params.entityType] = [match];
            return result;
          }
        }
      }
    }
    return result;
  });
  return map[params.entityType]?.[0] ?? null;
}

export function clearEntityLinkRulesCache(): void {
  rulesCache.clear();
  creatorCache.clear();
}

/**
 * A single already-normalized identity ready for lookup/create — the resolved
 * counterpart of the declarative {@link EntityIdentitySpec} (which carries an
 * `eventPath` to extract FROM an event). The store-only sender path hands these
 * in directly, having normalized upstream.
 */
export type ResolvedIdentity = {
  namespace: string;
  identifier: string;
  matchOnly: boolean;
  primary: boolean;
};

type ExtractedLink = {
  identities: ResolvedIdentity[];
  traits: Map<string, unknown>;
  title: string;
};

/**
 * Evaluate a rule's `createWhen` gate against the event item. Returns true (mint
 * allowed) when the predicate is absent or every declared condition holds; all
 * conditions AND together. Only gates the CREATE-on-miss branch — matching an
 * existing entity is never affected.
 */
function passesCreateWhen(predicate: EntityLinkPredicate | undefined, item: BatchItem): boolean {
  if (!predicate) return true;
  const value = getValueAtPath(item, predicate.path);
  if (predicate.equals !== undefined && value !== predicate.equals) return false;
  if (predicate.notEquals !== undefined && value === predicate.notEquals) return false;
  if (predicate.exists !== undefined) {
    const present = value !== undefined && value !== null && value !== '';
    if (present !== predicate.exists) return false;
  }
  return true;
}

/**
 * Ensure each identifier value is present in `entities.metadata.aliases` — the
 * flat alias array the metric compiler resolves event fields against
 * (`metadata->'aliases'`). entity_identities serves recall/authz; aliases serve
 * metrics; both must carry a contact's identifiers or its per-entity metrics
 * silently drop.
 *
 * Lock before merging so concurrent connector transactions cannot clobber one
 * another's aliases or traits. Passing the entity's full identifier set (not
 * just freshly-inserted ones) also repairs a legacy entity whose
 * `entity_identities` predate aliases-on-create.
 */
async function ensureAliases(
  sql: DbClient,
  params: { orgId: string; entityId: number; identifiers: string[] }
): Promise<void> {
  if (params.identifiers.length === 0) return;
  const rows = await sql<{ metadata: Record<string, unknown> | null }>`
    SELECT metadata
    FROM entities
    WHERE id = ${params.entityId}
      AND organization_id = ${params.orgId}
      AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (rows.length === 0) return;

  const current = rows[0].metadata ?? {};
  const aliases = Array.isArray(current.aliases)
    ? current.aliases.filter((value): value is string => typeof value === 'string')
    : [];
  if (params.identifiers.every((identifier) => aliases.includes(identifier))) return;

  await patchEntityRows({
    tx: sql,
    ids: [params.entityId],
    patch: {
      metadata: {
        ...current,
        aliases: [...new Set([...aliases, ...params.identifiers])].sort(),
      },
    },
  });
}

/**
 * Connector-owned namespaces are normalized by their own connector module
 * (assembled in identity/connector-identity-modules.ts); generic namespaces
 * fall back to the SDK's normalizer.
 */
function normalizeIdentityValue(namespace: string, raw: string): string | null {
  const connector = normalizeConnectorIdentityValue(namespace, raw);
  if (connector !== undefined) return connector;
  return normalizeIdentifier(namespace, raw);
}

function extractLink(item: BatchItem, rule: ResolvedEventAttributionRule): ExtractedLink | null {
  const identities: ExtractedLink['identities'] = [];
  for (const spec of rule.identities) {
    const raw = getValueAtPath(item, spec.eventPath);
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const normalized = normalizeIdentityValue(spec.namespace, raw);
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

/**
 * Resolve identity keys to their owning entity — TYPE-AGNOSTIC.
 *
 * An identity value belongs to at most ONE entity org-wide (the
 * `idx_entity_identities_live_unique` index on `(org, namespace, identifier)`),
 * so a key resolves to a single entity of ANY type. We deliberately do NOT
 * filter by the rule's target `entityType`: a `slack_user_id` owned by a
 * signed-in `$member` must resolve to that `$member` even when a `person`-typed
 * rule looks it up, so attribution and ACL converge on one entity instead of
 * minting a duplicate `person` (the #1646 cross-source collapse, now automatic).
 * Mirrors `access-graph.resolveMembers`, which is already identity-first +
 * type-agnostic. The target `entityType` still governs CREATE-on-miss.
 */
async function lookupMatches(
  sql: DbClient,
  params: {
    orgId: string;
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
    WHERE ei.organization_id = ${params.orgId}
      AND ei.deleted_at IS NULL
      AND e.deleted_at IS NULL
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

/**
 * Resolve a link's identities onto at most one entity, honouring identity tiers.
 *
 * A present `primary` identity (immutable, e.g. `github_user_id`) is
 * authoritative: it governs even when it matches nothing (a new account), so a
 * stale non-primary like a reused `github_login` can't merge a fresh account
 * into the old person. Without a primary, identities match equal-weight (the
 * cross-channel WhatsApp/email matching relies on this).
 *
 * This is the single definition of that rule. It is deliberately shared by both
 * resolution sites: the ordinary lookup AND the orphan-recovery re-resolution
 * after a lost auto-create race. Those two used to carry separate copies and the
 * recovery copy was tier-blind, which mis-resolved whenever a primary's owner
 * was soft-deleted while a live entity held a recycled secondary claim — the
 * link landed on the recycled-claim holder. `member_of` is a read ACL, so that
 * handed one person another person's channel access.
 *
 * Returns the entity id when exactly one candidate survives, `null` when
 * nothing matched at the governing tier, and `'ambiguous'` when several
 * entities tied there — callers must fail closed on `'ambiguous'` and never
 * pick one.
 */
function resolveIdentityTier(
  identities: ResolvedIdentity[],
  matches: Map<string, number>
): number | null | 'ambiguous' {
  const primaries = identities.filter((i) => i.primary);
  // A present primary governs alone; otherwise every identity votes equally.
  const governing = primaries.length > 0 ? primaries : identities;
  const hits = new Set<number>();
  for (const id of governing) {
    const h = matches.get(`${id.namespace}\u0000${id.identifier}`);
    if (h !== undefined) hits.add(h);
  }
  if (hits.size > 1) return 'ambiguous';
  if (hits.size === 1) return [...hits][0];
  return null;
}

function firstIdentityHit(
  identities: ResolvedIdentity[],
  matches: Map<string, number>
): number | null {
  for (const id of identities) {
    const hit = matches.get(`${id.namespace}\u0000${id.identifier}`);
    if (hit !== undefined) return hit;
  }
  return null;
}

async function createEntityWithIdentities(
  sql: DbClient,
  params: {
    orgId: string;
    connectorKey: string;
    connectionId?: number | null;
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
  let typeRow = await sql<{ id: number; backing_sql: string | null }>`
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
    // Platform ACL type is ensured on the fly so event attribution can race
    // ahead of the first ACL sync without failing closed on a missing type.
    if (params.entityType === ACL_RESOURCE_TYPE_SLUG) {
      await ensureResourceEntityType(params.orgId);
      typeRow = await sql<{ id: number; backing_sql: string | null }>`
        SELECT et.id, et.backing_sql
        FROM entity_types et
        WHERE et.slug = ${params.entityType}
          AND et.deleted_at IS NULL
          AND et.organization_id = ${params.orgId}
        LIMIT 1
      `;
      if (typeRow.length === 0) {
        logger.warn(
          { entityType: params.entityType, orgId: params.orgId },
          'entity create failed: $resource type ensure did not materialize'
        );
        return null;
      }
    } else {
      logger.warn(
        { entityType: params.entityType, orgId: params.orgId },
        'entity create failed: unknown entity type'
      );
      return null;
    }
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
    const inserted = await tryInsertEntityRow({
      tx: sql,
      row: {
        organizationId: params.orgId,
        entityTypeId,
        name,
        slug,
        metadata,
        createdBy: params.creatorUserId,
      },
    });
    if (inserted) entityId = Number(inserted.id);
  }
  if (entityId === null) return null;

  const attached = await insertIdentities(sql, {
    orgId: params.orgId,
    entityId,
    connectorKey: params.connectorKey,
    connectionId: params.connectionId,
    identities: persisted,
  });
  // Seed metadata.aliases from the identifiers that actually attached, so the
  // metric compiler (which resolves event fields against metadata->'aliases')
  // can attribute this contact's events from the moment it's created.
  await ensureAliases(sql, {
    orgId: params.orgId,
    entityId,
    identifiers: attached.map((a) => a.identifier),
  });
  return { entityId, attached };
}

/**
 * Insert identities for `entityId`, RETURNING the `(namespace, identifier)` rows
 * attached to that entity. Re-observing a legacy row fills missing connection
 * provenance; a row owned by another entity is not returned, so the caller will
 * not mis-claim it.
 */
async function insertIdentities(
  sql: DbClient,
  params: {
    orgId: string;
    entityId: number;
    connectorKey: string;
    connectionId?: number | null;
    identities: ExtractedLink['identities'];
  }
): Promise<Array<{ namespace: string; identifier: string }>> {
  if (params.identities.length === 0) return [];
  const namespaces = params.identities.map((i) => i.namespace);
  const identifiers = params.identities.map((i) => i.identifier);
  const attached = await sql<{ namespace: string; identifier: string }>`
    INSERT INTO entity_identities (
      organization_id, entity_id, namespace, identifier, source_connector, connection_id
    )
    SELECT ${params.orgId}, ${params.entityId}, v.ns, v.ident,
           ${`connector:${params.connectorKey}`}, ${params.connectionId ?? null}
    FROM unnest(${pgTextArray(namespaces)}::text[], ${pgTextArray(identifiers)}::text[]) AS v(ns, ident)
    ON CONFLICT (organization_id, namespace, identifier) WHERE deleted_at IS NULL
    DO UPDATE SET connection_id = EXCLUDED.connection_id
    WHERE entity_identities.entity_id = EXCLUDED.entity_id
      AND entity_identities.connection_id IS NULL
      AND EXCLUDED.connection_id IS NOT NULL
    RETURNING namespace, identifier
  `;
  return attached.map((r) => ({ namespace: r.namespace, identifier: r.identifier }));
}

async function applyTraits(
  sql: DbClient,
  params: {
    orgId: string;
    entityId: number;
    rule: ResolvedEventAttributionRule;
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
    if (!spec || spec.mergeStrategy === 'init_only') continue;
    if (value === undefined) continue;
    if (spec.mergeStrategy === 'overwrite') {
      overwrite[key] = value;
    } else if (spec.mergeStrategy === 'prefer_non_empty') {
      const empty = value === null || value === '';
      if (!empty) preferNonEmpty[key] = value;
    }
  }
  if (Object.keys(overwrite).length === 0 && Object.keys(preferNonEmpty).length === 0) return;

  // Serialize the metadata read-modify-write with alias and trait projections
  // from concurrent connector transactions.
  const rows = await sql<{ metadata: Record<string, unknown> | null }>`
    SELECT metadata
    FROM entities
    WHERE id = ${params.entityId}
      AND organization_id = ${params.orgId}
      AND deleted_at IS NULL
    FOR UPDATE
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

  await patchEntityRows({
    tx: sql,
    ids: [params.entityId],
    patch: { metadata: next },
  });
}

/**
 * Per-batch ingestion hook. Looks up or creates target entities for each
 * item using the normalized entity_identities index, then merges declared
 * traits onto the resolved entity. Rules are loaded from the connector
 * definition (poll/sync path).
 *
 * Connector attribution is one logical entity write: match/create, identity
 * claim, aliases, traits, and provisional cleanup commit together. A rejected
 * entity or identity write therefore rolls the batch back and propagates; the
 * sync aborts instead of persisting events whose attribution half-landed.
 */
export async function applyEventAttributions(
  params: {
    connectorKey: string;
    connectionId?: number | null;
    feedKey: string | null;
    orgId: string;
    items: BatchItem[];
  },
  // Optional transaction handle, same contract the webhook path already uses via
  // resolveEventAttributionsForItems. A supplied tx is joined; a pool or omitted
  // handle opens a transaction here. The sync dry-run path threads its rolled-
  // back tx so auto-created entities disappear with their events.
  sql?: DbClient
): Promise<void> {
  if (!params.feedKey || params.items.length === 0) return;

  const rulesByKind = await loadEventAttributionRules({
    connectorKey: params.connectorKey,
    feedKey: params.feedKey,
    orgId: params.orgId,
  });
  if (Object.keys(rulesByKind).length === 0) return;

  const db = sql ?? getDb();
  await withEntityWriteTransaction(db, (tx) =>
    resolveLinksByKind(
      {
        connectorKey: params.connectorKey,
        connectionId: params.connectionId,
        orgId: params.orgId,
        items: params.items,
        rulesByKind,
      },
      tx
    )
  );
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
export async function resolveEventAttributionsForItems(
  params: {
    connectorKey: string;
    connectionId?: number | null;
    orgId: string;
    items: BatchItem[];
    rules: RuleMap;
  },
  // Optional transaction handle — the webhook winner passes its tx so the actor
  // graph writes commit atomically with the event insert. A pool or omitted
  // handle opens a transaction here.
  sql?: DbClient
): Promise<Map<number, number[]>> {
  if (params.items.length === 0) return new Map();
  const db = sql ?? getDb();
  return withEntityWriteTransaction(db, (tx) =>
    resolveLinksByKind(
      {
        connectorKey: params.connectorKey,
        connectionId: params.connectionId,
        orgId: params.orgId,
        items: params.items,
        rulesByKind: params.rules,
      },
      tx
    )
  );
}

/**
 * Core resolver shared by the poll path ({@link applyEventAttributions}) and the
 * webhook path ({@link resolveEventAttributionsForItems}). Given rules grouped by
 * event kind, resolve or auto-create the target entity for each item, stamp the
 * canonical identifier metadata slots (for read-time JOINs), and merge declared
 * traits. Returns a per-item map (by array index) of resolved entity ids.
 */
async function resolveLinksByKind(
  params: {
    connectorKey: string;
    connectionId?: number | null;
    orgId: string;
    items: BatchItem[];
    rulesByKind: RuleMap;
  },
  // A real transaction handle for ALL match/insert/update writes. Public entry
  // points either join the caller's tx or open one before reaching this core.
  sql: DbClient
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
    ResolvedEventAttributionRule,
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

  // Resolve first, then lock every existing entity in one ascending-id pass.
  // Without a global lock order, two connector batches containing the same
  // entities in opposite item order could deadlock after each locked its first
  // row. Rows that disappeared between lookup and lock are removed from the
  // match maps so they cannot be returned as live resolutions.
  const matchesByRule = new Map<ResolvedEventAttributionRule, Map<string, number>>();
  const matchedEntityIds = new Set<number>();
  for (const [rule, entries] of byRule) {
    const matches = await lookupMatches(sql, {
      orgId: params.orgId,
      identities: entries.map((entry) => entry.link.identities),
    });
    matchesByRule.set(rule, matches);
    for (const entityId of matches.values()) matchedEntityIds.add(entityId);
  }
  if (matchedEntityIds.size > 0) {
    const ids = [...matchedEntityIds].sort((a, b) => a - b);
    const lockedRows = await sql<{ id: number | string }>`
      SELECT id
      FROM entities
      WHERE organization_id = ${params.orgId}
        AND id = ANY(${pgBigintArray(ids)}::bigint[])
        AND deleted_at IS NULL
      ORDER BY id
      FOR UPDATE
    `;
    const lockedIds = new Set(lockedRows.map((row) => Number(row.id)));
    for (const matches of matchesByRule.values()) {
      for (const [key, entityId] of matches) {
        if (!lockedIds.has(entityId)) matches.delete(key);
      }
    }
  }

  const recordResolved = (index: number, entityId: number): void => {
    const existing = resolvedByItem.get(index);
    if (existing) {
      if (!existing.includes(entityId)) existing.push(entityId);
    } else {
      resolvedByItem.set(index, [entityId]);
    }
  };

  for (const [rule, entries] of byRule) {
    const matches = matchesByRule.get(rule)!;

    for (const { index, item, link } of entries) {
      // Tier semantics are defined once in `resolveIdentityTier` and shared
      // with the orphan-recovery re-resolution below. A present primary that
      // matched nothing resolves to null here on purpose: the create path then
      // mints a new entity keyed on it instead of absorbing a stale
      // secondary's owner.
      const tier = resolveIdentityTier(link.identities, matches);
      const ambiguous = tier === 'ambiguous';
      let entityId: number | null = ambiguous ? null : tier;
      let isCreate = false;

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
        const fresh = await insertIdentities(sql, {
          orgId: params.orgId,
          entityId,
          connectorKey: params.connectorKey,
          connectionId: params.connectionId,
          identities: link.identities.filter((i) => !i.matchOnly),
        });
        attached = [...fresh];
        // Mirror this link's non-matchOnly identifiers into metadata.aliases for
        // metric resolution. Passing the full set (not just `fresh`) repairs a
        // legacy entity whose identities predate aliases-on-create; ensureAliases
        // skips the write once the aliases are complete, so a repeat message from
        // a known sender stays cheap.
        await ensureAliases(sql, {
          orgId: params.orgId,
          entityId,
          identifiers: link.identities.filter((i) => !i.matchOnly).map((i) => i.identifier),
        });
        // The matched identifiers themselves are this entity's even if a
        // re-insert was a no-op (they were how we found it), so claim them too.
        for (const id of link.identities) {
          if (matches.get(`${id.namespace}\u0000${id.identifier}`) === entityId) {
            attached.push({ namespace: id.namespace, identifier: id.identifier });
          }
        }
      } else if (rule.autoCreate && passesCreateWhen(rule.createWhen, item)) {
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
          connectionId: params.connectionId,
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
          await hardDeleteEntityRows({ tx: sql, ids: [created.entityId] });
          const winner = await lookupMatches(sql, {
            orgId: params.orgId,
            identities: [link.identities],
          });
          // Re-resolve through the SAME tier rule as the ordinary lookup. A
          // tier-blind union here mis-resolved when the primary's owner was
          // soft-deleted (so the primary matched nothing) while a live entity
          // still held a recycled secondary claim: the union saw exactly one
          // hit and adopted the recycled-claim holder. `member_of` is a read
          // ACL, so that granted one person another person's channel access.
          // Unmatched-primary and ambiguous both leave entityId null → skip,
          // which fails closed (no edge) rather than guessing an owner.
          const winnerTier = resolveIdentityTier(link.identities, winner);
          if (typeof winnerTier === 'number') {
            entityId = winnerTier;
            for (const id of link.identities) {
              if (winner.get(`${id.namespace}\u0000${id.identifier}`) === entityId) {
                attached.push({ namespace: id.namespace, identifier: id.identifier });
              }
            }
          }
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

      // Cache the mapping for the rest of the batch — only for attached
      // identifiers, so an identifier that stayed on another entity (ON CONFLICT
      // no-op) keeps its existing owner and isn't mis-claimed. EVERY rule's map
      // is updated, not just this one: all maps are resolved up front for the
      // prelock, so a later rule can no longer re-read this create from the DB
      // and would otherwise miss an entity the batch just minted. Sharing the
      // claim is exactly what that re-read returned — `lookupMatches` is
      // type-agnostic and an identity belongs to at most one entity org-wide.
      for (const id of attached) {
        const key = `${id.namespace}\u0000${id.identifier}`;
        for (const ruleMatches of matchesByRule.values()) ruleMatches.set(key, entityId);
      }

      // Stamp metadata slots for attached identifiers only — read-time JOINs key
      // on events.metadata->>namespace, so a stale slot would mis-attribute.
      //
      // A namespace slot holds ONE value, but an event can carry multiple
      // attribution rules that resolve the SAME namespace to DIFFERENT entities
      // (e.g. an X DM stamps x_user_id for both the `authored_by` sender and the
      // `about` counterparty). Read-time recall can only match one of them via
      // this slot, so first-writer-wins: the earliest-declared rule (the primary
      // author) keeps the slot, and we log the collision so the case that needs a
      // richer, role-aware read model is observable rather than silently dropped.
      // Making role queryable at read time is deliberately a separate change (it
      // touches the shared recall SQL + every call site) — until then this is the
      // honest boundary, not a workaround.
      const md = (item.metadata ??= {});
      for (const id of attached) {
        const existing = md[id.namespace];
        if (existing !== undefined && existing !== id.identifier) {
          logger.warn(
            {
              orgId: params.orgId,
              connectorKey: params.connectorKey,
              namespace: id.namespace,
              kept: existing,
              dropped: id.identifier,
              role: rule.role,
            },
            'attribution metadata slot collision — a later rule resolved the same namespace to a different identifier; keeping the first-stamped value (read-time recall matches only one)'
          );
          continue;
        }
        md[id.namespace] = id.identifier;
      }
    }
  }

  return resolvedByItem;
}

interface SenderIdentityParams {
  orgId: string;
  connectorKey: string;
  mintEntityType: string;
  identities: ResolvedIdentity[];
  title?: string | null;
}

/**
 * Resolve the SENDER of a captured chat message to an entity id — STORE-ONLY
 * attribution for `channel_messages.author_entity_id`. Connector-AGNOSTIC: the
 * caller hands over an already-normalized identity spec (it owns the platform's
 * namespace + normalizer) and the entity type to mint on a miss; this function
 * names no connector.
 *
 * Unlike {@link applyEventAttributions}, this writes NO event row, stamps no
 * `events.metadata`, and never enters the embed pipeline: it only reads the
 * normalized identity index and, on a miss, mints the given type (gated).
 * Transcript is high-volume operational data, so the caller fire-and-forgets
 * this — a resolution failure must never block capture or a webhook ack.
 *
 * Resolution (type-agnostic, driven by the #1646 cross-source collapse — a
 * signed-in human is a `$member` carrying the same team-scoped chat identity):
 *   1. the existing entity of ANY type owning this identity (a signed-in
 *      `$member`, an already-attributed `person`, …) — return it. A single
 *      {@link lookupMatches} covers all types because an identity value is
 *      globally unique to one entity; no `$member`-before-`person` ordering.
 *      Never mint a `$member` here (membership provisioning owns that, so
 *      attribution and ACL converge on the SAME entity).
 *   2. else mint `mintEntityType`, gated on a well-formed identity + a real org
 *      member to attribute the create to. Callers drop bots and malformed ids
 *      BEFORE calling (an empty `identities` list → null).
 */
export async function resolveSenderIdentity(
  sql: DbClient,
  params: SenderIdentityParams
): Promise<number | null> {
  if (params.identities.length === 0) return null;
  // Every captured message calls this, and the overwhelming majority resolve a
  // sender that already exists — answer those from a plain read rather than
  // opening a write transaction per message. Only a miss (which may mint) needs
  // one, and the in-transaction path re-runs this lookup because a concurrent
  // mint can land between the two.
  const existing = firstIdentityHit(
    params.identities,
    await lookupMatches(sql, { orgId: params.orgId, identities: [params.identities] })
  );
  if (existing !== null) return existing;
  return withEntityWriteTransaction(sql, (tx) => resolveSenderIdentityInTransaction(tx, params));
}

async function resolveSenderIdentityInTransaction(
  sql: DbClient,
  params: SenderIdentityParams
): Promise<number | null> {
  // 1) Any existing entity owning this identity — $member (signed-in human,
  // #1646) or person, resolved by one type-agnostic lookup. No create.
  const hit = firstIdentityHit(
    params.identities,
    await lookupMatches(sql, { orgId: params.orgId, identities: [params.identities] })
  );
  if (hit !== null) return hit;

  // 2) Mint. The only remaining gate is a real org member to attribute to.
  const creatorUserId = await resolveOrgCreator(params.orgId);
  if (!creatorUserId) return null;

  const created = await createEntityWithIdentities(sql, {
    orgId: params.orgId,
    connectorKey: params.connectorKey,
    entityType: params.mintEntityType,
    title: params.title?.trim() || '',
    identities: params.identities,
    traits: new Map(),
    creatorUserId,
  });
  if (created !== null && created.attached.length > 0) {
    return created.entityId;
  }
  // Lost the identity create-race (a concurrent ingest minted it first): drop
  // the identity-less orphan and resolve to the winner instead.
  if (created !== null) {
    await hardDeleteEntityRows({ tx: sql, ids: [created.entityId] });
    return firstIdentityHit(
      params.identities,
      await lookupMatches(sql, { orgId: params.orgId, identities: [params.identities] })
    );
  }
  return null;
}
