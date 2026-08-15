/**
 * The generic access-graph engine — ONE materializer behind every ACL source.
 *
 * A "source" (a Slack workspace, a GitHub org, later Jira/Drive/…) reduces to the
 * same shape: a set of RESOURCES (channels, repos, projects), each with an
 * AUDIENCE of MEMBERS who may read it. This engine takes that normalized shape
 * and writes it into the existing entity graph — exactly the way the original
 * `buildSlackChannelGraph` did, but with the resource/member specifics lifted
 * into parameters so a second source reuses the whole body instead of copying it.
 *
 * It owns everything that was identical (or should have been) between the Slack
 * channel graph and the GitHub team graph:
 *   - resolve an org owner/admin to attribute entities/edges to (`created_by`);
 *   - find-or-create the resource entity TYPE and the `member_of` relationship
 *     type (reuse, no migration);
 *   - resolve each resource to its entity, keyed on a source-specific identity
 *     namespace (`slack_channel_id`, `github_repo_id`, …);
 *   - resolve each member IDENTITY-FIRST and TYPE-AGNOSTICALLY — a member who has
 *     already signed in owns their identity claim on a `$member` entity, so we
 *     collapse onto THAT entity rather than forking a duplicate `person` (the
 *     correctness fix the Slack builder had and the original GitHub builder did
 *     NOT — folding GitHub onto this engine fixes it for free);
 *   - write `member_of` (member → resource) edges idempotently;
 *   - RECONCILE departures (soft-delete edges to a synced resource whose member is
 *     no longer present) so leavers lose access on the next sync;
 *   - stamp `authz_source_acl_state` ('full','fresh') so the gate begins enforcing
 *     the connection.
 *
 * Tenant-scoped, idempotent, best-effort: everything filters on `organizationId`;
 * edges dedupe on the live-triple unique index; nothing here throws on a
 * data-shaped problem (the CALLER's fetch layer owns fail-closed-on-error).
 */

import { createLogger } from '@lobu/core';
import {
  ACL_RESOURCE_TYPE_SLUG,
  type AccessIdentitySpec,
  type AccessMember,
  type AccessResource,
} from '@lobu/connector-sdk';
import { type DbClient, getDb, pgBigintArray, pgTextArray } from '../db/client.js';
import { runtimeConnectionIdToSlug } from '../lobu/stores/connections-projection.js';
import { resolveEventAttributionsForItems } from '../utils/entity-link-upsert.js';
import { ensureResourceEntityType } from './acl-resource-type.js';

const logger = createLogger('access-graph');

const MEMBER_OF_TYPE_SLUG = 'member_of';

export type { AccessIdentitySpec, AccessMember, AccessResource };
export { ensureResourceEntityType } from './acl-resource-type.js';

export interface AccessGraphResult {
  /** Resource key → the entity id that now represents it. */
  resourceEntityIds: Record<string, number>;
  /** Distinct member entity ids that gained a `member_of` edge. */
  memberEntityIds: number[];
  createdEdges: number;
  removedEdges: number;
}

const EMPTY_RESULT: AccessGraphResult = {
  resourceEntityIds: {},
  memberEntityIds: [],
  createdEdges: 0,
  removedEdges: 0,
};

/** Resolve an org owner/admin as `entities.created_by` / edge `created_by`
 * (NOT NULL). Same query both source builders used. */
async function resolveOrgCreator(orgId: string): Promise<string | null> {
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
}

/** Ensure the org has a `person` entity type — the type new (genuinely-unknown)
 * members are auto-created as. Prod seeds default types at org creation, but a
 * brand-new/default org may not have it yet; without it those members would
 * silently fail to resolve while the connection is still stamped enforced (their
 * recall would then fail closed). */
async function ensurePersonEntityType(orgId: string): Promise<void> {
  const sql = getDb();
  await sql`
		INSERT INTO entity_types (slug, name, organization_id, created_at, updated_at)
		VALUES ('person', 'Person', ${orgId}, current_timestamp, current_timestamp)
		ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
		DO NOTHING
	`;
}

/** Find-or-create the org-scoped `member_of` relationship type. */
async function ensureMemberOfType(orgId: string): Promise<number> {
  const sql = getDb();
  const rows = await sql`
		INSERT INTO entity_relationship_types
			(slug, name, description, organization_id, is_symmetric, created_by, created_at, updated_at)
		VALUES
			(${MEMBER_OF_TYPE_SLUG}, 'Member of', 'A member belongs to an ACL resource (channel, repo, …)', ${orgId},
			 false, NULL, current_timestamp, current_timestamp)
		ON CONFLICT (organization_id, slug) WHERE status = 'active'
		DO UPDATE SET updated_at = EXCLUDED.updated_at
		RETURNING id
	`;
  return Number(rows[0].id);
}

/**
 * Advisory-lock namespace for per-connection access-graph builds ('aclg').
 * The second key is `hashtext(org:connection)`, so distinct connections never
 * contend with each other.
 */
const ACL_GRAPH_LOCK_NAMESPACE = 0x61636c67;

/**
 * Stamp the connection fresh only if its ACL state did not change mid-snapshot.
 *
 * The caller already holds the per-connection advisory lock and has checked the
 * generation, so this guards a narrower case the lock cannot: the revocation
 * webhook (`invalidateSlackConnectionAcl`) writes WITHOUT taking that lock, so
 * a departure landing between the check and this stamp must still lose. When it
 * does, the row keeps its `stale` state and the gate fails closed — the edges
 * this transaction wrote are then simply not trusted until the next sync.
 */
async function markAclEnforced(
  sql: DbClient,
  orgId: string,
  connectionId: string,
  syncStartedAt: string,
): Promise<void> {
  await sql`
		INSERT INTO authz_source_acl_state
			(organization_id, connection_id, acl_support, freshness_state, last_synced_at, created_at, updated_at)
		VALUES (${orgId}, ${connectionId}, 'full', 'fresh', current_timestamp, current_timestamp, current_timestamp)
		ON CONFLICT (organization_id, connection_id)
		DO UPDATE SET acl_support = 'full', freshness_state = 'fresh',
		              last_synced_at = clock_timestamp(), updated_at = clock_timestamp()
		WHERE authz_source_acl_state.updated_at < ${syncStartedAt}::timestamptz
	`;
}

/**
 * Resolve every distinct member to an entity id, IDENTITY-FIRST and
 * TYPE-AGNOSTIC: a member collapses onto any existing entity (`$member`,
 * `person`, …) carrying ANY of their identities; only genuinely-new members get
 * a freshly-created `person`. Returns a map member.key → entity id.
 */
async function resolveMembers(
  orgId: string,
  connectorKey: string,
  connectionId: number | null,
  members: AccessMember[],
  memberIdentities: AccessIdentitySpec[],
): Promise<Map<string, number>> {
  const byKey = new Map<string, number>();
  if (members.length === 0) return byKey;

  // Gather identity values per namespace and look up existing owners (any type).
  const valuesByNamespace = new Map<string, Set<string>>();
  for (const m of members) {
    for (const id of m.identities) {
      if (!id.value) continue;
      const set = valuesByNamespace.get(id.namespace) ?? new Set<string>();
      set.add(id.value);
      valuesByNamespace.set(id.namespace, set);
    }
  }
  const existing = new Map<string, number>(); // `${namespace}|${value}` → entity id
  const sql = getDb();
  for (const [namespace, values] of valuesByNamespace) {
    const list = [...values];
    if (list.length === 0) continue;
    // The JOIN is load-bearing: an ordinary entity delete soft-deletes the
    // ENTITY but leaves its `entity_identities` rows live, still pointing at
    // it (only a merge or sign-in adoption repoints them). Matching on the
    // identity alone therefore resolves onto a dead entity, writes `member_of`
    // to it, and never mints a replacement — so the member silently vanishes
    // from the audience of every channel they are in. `lookupMatches` in
    // entity-link-upsert already joins for this reason; this matcher did not.
    const rows = await sql<{ identifier: string; entity_id: number }>`
			SELECT ei.identifier, ei.entity_id
			FROM entity_identities ei
			JOIN entities e ON e.id = ei.entity_id
			WHERE ei.organization_id = ${orgId}
			  AND ei.namespace = ${namespace}
			  AND ei.identifier = ANY(${pgTextArray(list)}::text[])
			  AND ei.deleted_at IS NULL
			  AND e.deleted_at IS NULL
		`;
    for (const r of rows) {
      existing.set(`${namespace}|${String(r.identifier)}`, Number(r.entity_id));
    }
  }

  // Which entity a member's claims resolve to follows the tier semantics the
  // create path below (`resolveEventAttributionsForItems`) already implements —
  // see `primary` in connector-types.ts. Stopping at the first array hit made
  // the answer depend on the order a connector pushed its identities, and
  // `member_of` is a read ACL, so that was a mis-grant waiting to happen: a
  // stale or recycled secondary claim (an old email, a reused login) would hand
  // one person another person's channel access. A PRESENT primary identity —
  // the source's stable per-account key — therefore governs alone and never
  // falls through to a secondary match: a fresh primary means a distinct
  // account even when a recycled secondary still points at the old person.
  // This fast path only claims a member when its answer matches what the
  // create-path engine would decide; every other case (primary present but
  // unmatched, a same-tier conflict) falls through to `toCreate`, where that
  // engine mints a new entity keyed on the primary or refuses the ambiguous
  // match outright (no edge — fail closed) with its 'merge candidate' warning.
  const primaryNamespaces = new Set(
    memberIdentities.filter((s) => s.primary).map((s) => s.namespace)
  );
  const toCreate: AccessMember[] = [];
  for (const m of members) {
    const primaryHits = new Set<number>();
    const secondaryHits = new Set<number>();
    let primaryPresent = false;
    for (const id of m.identities) {
      if (!id.value) continue;
      const isPrimary = primaryNamespaces.has(id.namespace);
      if (isPrimary) primaryPresent = true;
      const found = existing.get(`${id.namespace}|${id.value}`);
      if (found === undefined) continue;
      (isPrimary ? primaryHits : secondaryHits).add(found);
    }
    let hit: number | undefined;
    if (primaryPresent) {
      if (primaryHits.size === 1) {
        hit = [...primaryHits][0];
        const overridden = [...secondaryHits].filter((id) => id !== hit);
        if (overridden.length > 0) {
          logger.warn(
            {
              organization_id: orgId,
              connector_key: connectorKey,
              member_key: m.key,
              resolved_to: hit,
              overridden_entity_ids: overridden,
            },
            'access-graph: member matched multiple entities — resolved via the primary identity'
          );
        }
      }
    } else if (secondaryHits.size === 1) {
      hit = [...secondaryHits][0];
    }
    if (hit !== undefined) byKey.set(m.key, hit);
    else toCreate.push(m);
  }

  if (toCreate.length === 0) return byKey;

  // Auto-create a `person` for each genuinely-new member, carrying ALL their
  // declared identities so a later source (or login) collapses onto them.
  const items = toCreate.map((m) => {
    const metadata: Record<string, unknown> = { display_name: m.name ?? m.key };
    for (const id of m.identities) metadata[id.namespace] = id.value;
    return { origin_type: 'access_member', metadata };
  });
  const resolved = await resolveEventAttributionsForItems({
    connectorKey,
    connectionId,
    orgId,
    items,
    rules: {
      access_member: [
        {
          role: 'authored_by',
          entityType: 'person',
          autoCreate: true,
          titlePath: 'metadata.display_name',
          identities: memberIdentities.map((spec) => ({
            namespace: spec.namespace,
            eventPath: `metadata.${spec.namespace}`,
            primary: spec.primary,
          })),
        },
      ],
    },
  });
  for (let i = 0; i < toCreate.length; i++) {
    const ids = resolved.get(i);
    if (ids && ids.length > 0) byKey.set(toCreate[i].key, ids[0]);
  }
  return byKey;
}

/**
 * Materialize a source's resource→audience graph and mark the connection
 * ACL-enforced. The CALLER normalizes its raw API shape into `resources`
 * (Slack channels with `T:C`/`T:U` keys, GitHub repos with collaborators, …);
 * this body is source-agnostic.
 */
export async function buildAccessGraph(params: {
  organizationId: string;
  connectionId: string;
  connectorKey: string;
  /** Identity namespace for resource keys (e.g. `slack_channel_id`). */
  resourceNamespace: string;
  memberIdentities: AccessIdentitySpec[];
  resources: AccessResource[];
  /**
   * Database time captured before the source snapshot began. A newer ACL-state
   * write means that snapshot lost a revocation race and must not mark the
   * connection fresh.
   */
  syncStartedAt?: string;
}): Promise<AccessGraphResult> {
  const { organizationId, connectionId, connectorKey, resourceNamespace, memberIdentities } =
    params;
  const resources = params.resources.filter((r) => r.key);
  if (resources.length === 0) return EMPTY_RESULT;

  const syncStartedAt =
    params.syncStartedAt ??
    (
      await getDb()<{ sync_started_at: string }>`
        SELECT clock_timestamp()::text AS sync_started_at
      `
    )[0].sync_started_at;

  const creatorUserId = await resolveOrgCreator(organizationId);
  if (!creatorUserId) {
    logger.warn(
      { organization_id: organizationId, connector: connectorKey },
      'Access graph skipped: org has no member to attribute as entity creator',
    );
    return EMPTY_RESULT;
  }

  await ensureResourceEntityType(organizationId);
  await ensurePersonEntityType(organizationId);

  // ACL state uses a runtime connection id, while identity provenance references
  // the stored numeric row. Resolve by slug (chat connections) or id text (data
  // connectors) without assuming the runtime id itself is numeric.
  const [storedConnection] = await getDb()<{ id: number }>`
    SELECT id
    FROM connections
    WHERE organization_id = ${organizationId}
      AND connector_key = ${connectorKey}
      AND deleted_at IS NULL
      AND (
        slug = ${runtimeConnectionIdToSlug(connectionId)}
        OR id::text = ${connectionId}
      )
    LIMIT 1
  `;
  const identityConnectionId = storedConnection
    ? Number(storedConnection.id)
    : null;

  // 1) Resolve every resource to its entity, keyed on the source identity namespace.
  const resourceItems = resources.map((r) => ({
    origin_type: 'access_resource',
    metadata: { resource_key: r.key, resource_name: r.name ?? r.key },
  }));
  const resolvedResources = await resolveEventAttributionsForItems({
    connectorKey,
    connectionId: identityConnectionId,
    orgId: organizationId,
    items: resourceItems,
    rules: {
      access_resource: [
        {
          role: 'belongs_to',
          entityType: ACL_RESOURCE_TYPE_SLUG,
          autoCreate: true,
          titlePath: 'metadata.resource_name',
          identities: [
            {
              namespace: resourceNamespace,
              eventPath: 'metadata.resource_key',
              primary: true,
            },
          ],
        },
      ],
    },
  });
  const resourceEntityIds: Record<string, number> = {};
  const resourceEntityIdByIndex = new Map<number, number>();
  for (let i = 0; i < resources.length; i++) {
    const ids = resolvedResources.get(i);
    if (ids && ids.length > 0) {
      resourceEntityIds[resources[i].key] = ids[0];
      resourceEntityIdByIndex.set(i, ids[0]);
    }
  }

  // 2) Resolve every DISTINCT member (identity-first, type-agnostic).
  const distinctMembers = new Map<string, AccessMember>();
  for (const r of resources) {
    for (const m of r.members) {
      if (m.key && !distinctMembers.has(m.key)) distinctMembers.set(m.key, m);
    }
  }
  const memberEntityByKey = await resolveMembers(
    organizationId,
    connectorKey,
    identityConnectionId,
    [...distinctMembers.values()],
    memberIdentities,
  );

  // 3) Write member → resource `member_of` edges, idempotent on the live-triple
  // unique index. Accumulate the CURRENT member set per resource for reconcile.
  const typeId = await ensureMemberOfType(organizationId);

  /*
   * Everything that MUTATES the graph runs inside one transaction, serialized
   * per connection by an advisory lock, and re-checks the generation after
   * taking that lock.
   *
   * Fencing only the final stamp is not enough. Two syncs can overlap (the tick
   * is a 15-minute cron and a slow workspace outruns its own cadence): the
   * newer one finishes first and correctly drops a departed member, then the
   * older one — still holding a pre-departure snapshot — reinserts that
   * member's edge and skips its own stamp. The connection is left `fresh` from
   * the newer sync while carrying an edge the newer sync deliberately removed,
   * so a revoked member keeps recall. Aborting BEFORE any edge write is the
   * only thing that prevents it; a guard on the stamp alone is too late.
   */
  const committed = await getDb().begin(async (sql) => {
    // Transaction-scoped: released on commit or rollback, so a crashed sync
    // cannot wedge the connection. Keyed on (org, connection) so syncs of
    // different connections still run concurrently.
    await sql`
			SELECT pg_advisory_xact_lock(
				${ACL_GRAPH_LOCK_NAMESPACE},
				hashtext(${`${organizationId}:${connectionId}`})
			)
		`;

    const superseded = await sql<{ one: number }[]>`
			SELECT 1 AS one
			FROM authz_source_acl_state
			WHERE organization_id = ${organizationId}
			  AND connection_id = ${connectionId}
			  AND updated_at >= ${syncStartedAt}::timestamptz
			LIMIT 1
		`;
    if (superseded.length > 0) return null;

  // Keep each resource entity's display name fresh. `titlePath` only sets the
  // name on auto-CREATE, so a name that wasn't available at first graph (or a
  // later channel/repo RENAME) would otherwise stick to the stale value / the
  // raw id. Refresh from the source-provided name here. Scoped to the resources
  // in this build; idempotent (the `name <>` guard no-ops when unchanged).
  for (let i = 0; i < resources.length; i++) {
    const id = resourceEntityIdByIndex.get(i);
    const name = resources[i].name;
    if (id && name) {
      await sql`
        UPDATE entities
        SET name = ${name}, updated_at = current_timestamp
        WHERE id = ${id}
          AND organization_id = ${organizationId}
          AND name <> ${name}
          AND deleted_at IS NULL
      `;
    }
  }

  const memberEntityIds = new Set<number>();
  const currentMembersByResource = new Map<number, Set<number>>();
  let createdEdges = 0;
  for (let i = 0; i < resources.length; i++) {
    const resourceEntityId = resourceEntityIdByIndex.get(i);
    if (resourceEntityId === undefined) continue;
    const resourceMembers = currentMembersByResource.get(resourceEntityId) ?? new Set<number>();
    currentMembersByResource.set(resourceEntityId, resourceMembers);
    for (const m of resources[i].members) {
      const memberEntityId = memberEntityByKey.get(m.key);
      if (memberEntityId === undefined) continue;
      memberEntityIds.add(memberEntityId);
      resourceMembers.add(memberEntityId);
      const inserted = await sql<{ id: number }[]>`
				INSERT INTO entity_relationships (
					organization_id, from_entity_id, to_entity_id, relationship_type_id,
					confidence, source, created_by, updated_by, created_at, updated_at
				) VALUES (
					${organizationId}, ${memberEntityId}, ${resourceEntityId}, ${typeId},
					1.0, 'feed', ${creatorUserId}, ${creatorUserId},
					current_timestamp, current_timestamp
				)
				ON CONFLICT (from_entity_id, to_entity_id, relationship_type_id)
					WHERE deleted_at IS NULL
				DO NOTHING
				RETURNING id
			`;
      if (inserted.length > 0) createdEdges += 1;
    }
  }

  // 4) Reconcile DEPARTURES — the build is a full re-sync of each resource's
  // membership, so a `member_of` edge to a synced resource whose member is NOT
  // in the current set means that person left: soft-delete it so they lose
  // access immediately. Scoped to `to_entity_id` = a resource we just synced, so
  // edges to OTHER resource types (a different source's graph) are never touched.
  // An empty member set deletes all of that resource's edges — the caller must
  // not pass empty-on-fetch-error.
  let removedEdges = 0;
  for (const [resourceEntityId, resourceMembers] of currentMembersByResource) {
    const keep = [...resourceMembers];
    const removed = await sql<{ id: number }[]>`
			UPDATE entity_relationships
			SET deleted_at = current_timestamp, updated_at = current_timestamp
			WHERE organization_id = ${organizationId}
			  AND relationship_type_id = ${typeId}
			  AND to_entity_id = ${resourceEntityId}
			  AND deleted_at IS NULL
			  AND from_entity_id <> ALL(${pgBigintArray(keep)}::bigint[])
			RETURNING id
		`;
    removedEdges += removed.length;
  }

    await markAclEnforced(sql, organizationId, connectionId, syncStartedAt);

    return { memberEntityIds, createdEdges, removedEdges };
  });

  if (committed === null) {
    logger.warn(
      {
        organization_id: organizationId,
        connection_id: connectionId,
        connector: connectorKey,
        sync_started_at: syncStartedAt,
      },
      'Access graph discarded: ACL state changed after this snapshot began',
    );
    return EMPTY_RESULT;
  }

  const { memberEntityIds, createdEdges, removedEdges } = committed;

  logger.info(
    {
      organization_id: organizationId,
      connection_id: connectionId,
      connector: connectorKey,
      resource_type: ACL_RESOURCE_TYPE_SLUG,
      resource_namespace: resourceNamespace,
      resources: Object.keys(resourceEntityIds).length,
      members: memberEntityIds.size,
      created_edges: createdEdges,
      removed_edges: removedEdges,
    },
    'Built access graph',
  );

  return {
    resourceEntityIds,
    memberEntityIds: [...memberEntityIds],
    createdEdges,
    removedEdges,
  };
}
