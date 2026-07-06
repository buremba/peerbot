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
import { getDb, pgBigintArray, pgTextArray } from '../db/client.js';
import { resolveEventAttributionsForItems } from '../utils/entity-link-upsert.js';

const logger = createLogger('access-graph');

const MEMBER_OF_TYPE_SLUG = 'member_of';

/** A claim that identifies a member, e.g. `{namespace:'slack_user_id', primary:true}`.
 * The engine collapses a member onto any existing entity carrying ANY of their
 * identities; `primary` ones additionally govern creation. */
export interface AccessIdentitySpec {
  namespace: string;
  primary?: boolean;
}

/** One member of a resource's audience. */
export interface AccessMember {
  /** Stable dedupe key for this member across resources (the primary identity
   * value is the natural choice: `T…:U…` for Slack, the numeric id for GitHub). */
  key: string;
  /** Display name for an auto-created `person`. Falls back to `key`. */
  name?: string;
  /** This member's identity claims (namespaces declared in `memberIdentities`). */
  identities: { namespace: string; value: string }[];
}

/** One resource (channel/repo/…) and the members who may read it. */
export interface AccessResource {
  /** Stored as the resource entity's identity under `resourceType.namespace`
   * (`T…:C…` for Slack, `owner/repo` or the numeric id for GitHub). */
  key: string;
  name?: string;
  members: AccessMember[];
}

/** The resource entity type to find-or-create and key resources under. */
export interface AccessResourceType {
  /** Entity-type slug, e.g. `channel` / `repo`. */
  slug: string;
  name: string;
  description: string;
  icon: string;
  /** Identity namespace the resource key is stored/looked-up under. */
  namespace: string;
}

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

/** Find-or-create the org-scoped resource entity type (reuse, no migration). */
export async function ensureResourceEntityType(orgId: string, type: AccessResourceType): Promise<void> {
  const sql = getDb();
  await sql`
		INSERT INTO entity_types (slug, name, description, icon, organization_id, created_at, updated_at)
		VALUES (
			${type.slug}, ${type.name}, ${type.description}, ${type.icon},
			${orgId}, current_timestamp, current_timestamp
		)
		ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
		DO NOTHING
	`;
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
			(${MEMBER_OF_TYPE_SLUG}, 'Member of', 'A person is a member of an organization or channel', ${orgId},
			 false, NULL, current_timestamp, current_timestamp)
		ON CONFLICT (organization_id, slug) WHERE status = 'active'
		DO UPDATE SET updated_at = EXCLUDED.updated_at
		RETURNING id
	`;
  return Number(rows[0].id);
}

/** Stamp the connection's ACL state so the gate begins enforcing it. */
async function markAclEnforced(orgId: string, connectionId: string): Promise<void> {
  const sql = getDb();
  await sql`
		INSERT INTO authz_source_acl_state
			(organization_id, connection_id, acl_support, freshness_state, last_synced_at, created_at, updated_at)
		VALUES (${orgId}, ${connectionId}, 'full', 'fresh', current_timestamp, current_timestamp, current_timestamp)
		ON CONFLICT (organization_id, connection_id)
		DO UPDATE SET acl_support = 'full', freshness_state = 'fresh',
		              last_synced_at = current_timestamp, updated_at = current_timestamp
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
    const rows = await sql<{ identifier: string; entity_id: number }>`
			SELECT identifier, entity_id
			FROM entity_identities
			WHERE organization_id = ${orgId}
			  AND namespace = ${namespace}
			  AND identifier = ANY(${pgTextArray(list)}::text[])
			  AND deleted_at IS NULL
		`;
    for (const r of rows) {
      existing.set(`${namespace}|${String(r.identifier)}`, Number(r.entity_id));
    }
  }

  const toCreate: AccessMember[] = [];
  for (const m of members) {
    let hit: number | undefined;
    for (const id of m.identities) {
      const found = existing.get(`${id.namespace}|${id.value}`);
      if (found !== undefined) {
        hit = found;
        break;
      }
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
  resourceType: AccessResourceType;
  memberIdentities: AccessIdentitySpec[];
  resources: AccessResource[];
}): Promise<AccessGraphResult> {
  const { organizationId, connectionId, connectorKey, resourceType, memberIdentities } = params;
  const resources = params.resources.filter((r) => r.key);
  if (resources.length === 0) return EMPTY_RESULT;

  const creatorUserId = await resolveOrgCreator(organizationId);
  if (!creatorUserId) {
    logger.warn(
      { organization_id: organizationId, connector: connectorKey },
      'Access graph skipped: org has no member to attribute as entity creator',
    );
    return EMPTY_RESULT;
  }

  await ensureResourceEntityType(organizationId, resourceType);
  await ensurePersonEntityType(organizationId);

  // 1) Resolve every resource to its entity, keyed on the source identity namespace.
  const resourceItems = resources.map((r) => ({
    origin_type: 'access_resource',
    metadata: { resource_key: r.key, resource_name: r.name ?? r.key },
  }));
  const resolvedResources = await resolveEventAttributionsForItems({
    connectorKey,
    orgId: organizationId,
    items: resourceItems,
    rules: {
      access_resource: [
        {
          role: 'belongs_to',
          entityType: resourceType.slug,
          autoCreate: true,
          titlePath: 'metadata.resource_name',
          identities: [
            { namespace: resourceType.namespace, eventPath: 'metadata.resource_key', primary: true },
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
    [...distinctMembers.values()],
    memberIdentities,
  );

  // 3) Write member → resource `member_of` edges, idempotent on the live-triple
  // unique index. Accumulate the CURRENT member set per resource for reconcile.
  const typeId = await ensureMemberOfType(organizationId);
  const sql = getDb();

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

  await markAclEnforced(organizationId, connectionId);

  logger.info(
    {
      organization_id: organizationId,
      connection_id: connectionId,
      connector: connectorKey,
      resource_type: resourceType.slug,
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
