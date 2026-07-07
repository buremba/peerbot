/**
 * Business-context links for chat channels: typed `about` edges from a channel
 * resource entity to org business entities (customer, project, company, …).
 *
 * ACL membership (`member_of`) and business context (`about`) share the same
 * `entity_relationships` graph but use different relationship types — ACL
 * reconcile never touches `about` edges.
 */

import { createLogger } from "@lobu/core";
import {
	type DbClient,
	getDb,
	pgBigintArray,
	pgTextArray,
} from "../db/client.js";
import { resolveEventAttributionsForItems } from "../utils/entity-link-upsert.js";
import { ensureResourceEntityType } from "./access-graph.js";
import { aclSourceFor, channelReadIdentityFor } from "./sources.js";

const logger = createLogger("channel-about");

export const ABOUT_RELATIONSHIP_SLUG = "about";
export const ABOUT_EDGE_SOURCE_CONFIG = "config";
export const ABOUT_EDGE_SOURCE_MANUAL = "manual";

export interface ChannelAboutTarget {
	/** Bare or platform-prefixed channel id as stored on the binding. */
	channelId: string;
	/** Resolved business-entity ids to link (channel --about--> each). */
	aboutEntityIds: number[];
}

export interface ChannelAboutMetadata {
	connection_id: string;
	channel_key: string;
}

/** Find-or-create the org-scoped `about` relationship type. */
export async function ensureAboutRelationshipType(
	organizationId: string,
	sql: DbClient = getDb(),
): Promise<number> {
	const existing = await findAboutRelationshipTypeId(organizationId, sql);
	if (existing !== null) return existing;

	const inserted = await sql<{ id: number }>`
	    INSERT INTO entity_relationship_types
	      (slug, name, description, organization_id, is_symmetric, created_by, created_at, updated_at)
	    VALUES
	      (${ABOUT_RELATIONSHIP_SLUG}, 'About', 'A chat channel is about a business entity',
	       ${organizationId}, false, NULL, current_timestamp, current_timestamp)
	    ON CONFLICT (organization_id, slug) WHERE status = 'active'
	    DO NOTHING
	    RETURNING id
	  `;
	if (inserted[0]) return Number(inserted[0].id);

	const raced = await findAboutRelationshipTypeId(organizationId, sql);
	if (raced !== null) return raced;
	throw new Error("Failed to initialize about relationship type");
}

async function findAboutRelationshipTypeId(
	organizationId: string,
	sql: DbClient,
): Promise<number | null> {
	const rows = await sql<{ id: number }>`
    SELECT id
    FROM entity_relationship_types
    WHERE organization_id = ${organizationId}
      AND slug = ${ABOUT_RELATIONSHIP_SLUG}
      AND status = 'active'
      AND deleted_at IS NULL
    LIMIT 1
  `;
	return rows[0] ? Number(rows[0].id) : null;
}

/** Team-scoped resource key + identity namespace for a chat channel.
 *
 * Connector-agnostic: a connector that registers a `ChannelReadIdentity`
 * contributes both its channel identity namespace and the exact team-scoped key
 * construction the ACL sync writes, so this names no platform. Connectors with
 * no registered chat gate fall back to the generic `chat_channel_id` form. */
export function channelResourceIdentity(
	connectorKey: string,
	teamId: string | null | undefined,
	channelId: string,
): { namespace: string; key: string } {
	const bare = channelId.includes(":")
		? channelId.slice(channelId.indexOf(":") + 1)
		: channelId;
	const readIdentity = channelReadIdentityFor(connectorKey);
	const key = readIdentity?.buildChannelKey(teamId, bare);
	if (readIdentity && key) {
		return { namespace: readIdentity.channelNamespace, key };
	}
	const team = teamId?.trim() || "";
	return {
		namespace: "chat_channel_id",
		key: `${connectorKey}:${team}:${bare}`.toUpperCase(),
	};
}

/**
 * Ensure a channel resource entity exists (eager, before ACL sync). Returns the
 * entity id, or null when the key cannot be formed (e.g. a chat connector whose
 * team-scoped key needs a team id that wasn't supplied).
 */
export async function ensureChannelResourceEntity(opts: {
	organizationId: string;
	connectorKey: string;
	teamId: string | null | undefined;
	channelId: string;
	displayName?: string | null;
	sql?: DbClient;
}): Promise<number | null> {
	const sql = opts.sql ?? getDb();
	const bare = opts.channelId.includes(":")
		? opts.channelId.slice(opts.channelId.indexOf(":") + 1)
		: opts.channelId;
	// A registered chat connector's key construction can refuse (return null) when
	// its team-scoped key can't be formed — bail rather than materialize a bad
	// resource under the generic fallback namespace.
	const readIdentity = channelReadIdentityFor(opts.connectorKey);
	if (readIdentity && readIdentity.buildChannelKey(opts.teamId, bare) === null) {
		return null;
	}
	// The resource entity type comes from the connector's ACL source. A connector
	// that declares none produces no access-controlled channel resource, so there
	// is nothing to materialize — skip rather than fabricate a type.
	const resourceType = aclSourceFor(opts.connectorKey)?.resourceType;
	if (!resourceType) return null;

	const { namespace, key } = channelResourceIdentity(
		opts.connectorKey,
		opts.teamId,
		opts.channelId,
	);
	await ensureResourceEntityType(opts.organizationId, resourceType);

	const resolved = await resolveEventAttributionsForItems(
		{
			connectorKey: opts.connectorKey,
			orgId: opts.organizationId,
			items: [
				{
					origin_type: "channel_about",
					metadata: {
						resource_key: key,
						resource_name: opts.displayName ?? key,
					},
				},
			],
			rules: {
				channel_about: [
					{
						role: "about",
						entityType: resourceType.slug,
						autoCreate: true,
						titlePath: "metadata.resource_name",
						identities: [
							{
								namespace,
								eventPath: "metadata.resource_key",
								primary: true,
							},
						],
					},
				],
			},
		},
		sql,
	);
	const ids = resolved.get(0);
	return ids?.[0] ?? null;
}

async function findChannelResourceEntityId(opts: {
	organizationId: string;
	connectorKey: string;
	teamId: string | null | undefined;
	channelId: string;
	sql: DbClient;
}): Promise<number | null> {
	if (opts.connectorKey === "slack" && !opts.teamId) return null;
	const { namespace, key } = channelResourceIdentity(
		opts.connectorKey,
		opts.teamId,
		opts.channelId,
	);
	const rows = await opts.sql<{ id: number }>`
    SELECT e.id
    FROM entity_identities ei
    JOIN entities e
      ON e.id = ei.entity_id
     AND e.organization_id = ei.organization_id
     AND e.deleted_at IS NULL
    WHERE ei.organization_id = ${opts.organizationId}
      AND ei.namespace = ${namespace}
      AND ei.identifier = ${key}
      AND ei.deleted_at IS NULL
    LIMIT 1
  `;
	return rows[0] ? Number(rows[0].id) : null;
}

/** Resolve entity slugs to ids; throws when any slug is missing in the org. */
export async function resolveEntitySlugsToIds(
	organizationId: string,
	slugs: string[],
	sql: DbClient = getDb(),
): Promise<number[]> {
	const requested = [...new Set(slugs.map((s) => s.trim()).filter(Boolean))];
	if (requested.length === 0) return [];
	const rows = await sql<{ id: number; slug: string }>`
    SELECT id, slug
    FROM entities
    WHERE organization_id = ${organizationId}
      AND slug = ANY(${pgTextArray(requested)}::text[])
      AND deleted_at IS NULL
  `;
	const bySlug = new Map(rows.map((r) => [r.slug, Number(r.id)]));
	const missing = requested.filter((slug) => !bySlug.has(slug));
	if (missing.length > 0) {
		throw new Error(
			`entity slug(s) do not exist in this organization: ${missing.join(", ")}`,
		);
	}
	return requested.map((slug) => bySlug.get(slug)!);
}

/** Normalize about targets: numbers pass through, strings resolve as slugs. */
export async function resolveAboutEntityRefs(
	organizationId: string,
	refs: Array<number | string>,
	sql: DbClient = getDb(),
): Promise<number[]> {
	const ids: number[] = [];
	const slugs: string[] = [];
	for (const ref of refs) {
		if (typeof ref === "number" && Number.isFinite(ref)) ids.push(ref);
		else if (typeof ref === "string" && ref.trim()) slugs.push(ref.trim());
	}
	const fromSlugs = await resolveEntitySlugsToIds(organizationId, slugs, sql);
	return [...new Set([...ids, ...fromSlugs])];
}

async function upsertAboutEdge(opts: {
	organizationId: string;
	fromChannelEntityId: number;
	toBusinessEntityId: number;
	source: string;
	metadata: ChannelAboutMetadata;
	userId: string | null | undefined;
	typeId: number;
	sql: DbClient;
}): Promise<void> {
	await opts.sql`
    INSERT INTO entity_relationships (
      organization_id, from_entity_id, to_entity_id, relationship_type_id,
      metadata, confidence, source, created_by, updated_by, created_at, updated_at
    ) VALUES (
      ${opts.organizationId}, ${opts.fromChannelEntityId}, ${opts.toBusinessEntityId},
      ${opts.typeId}, ${opts.sql.json(opts.metadata)}, 1.0, ${opts.source},
      ${opts.userId ?? null}, ${opts.userId ?? null},
      current_timestamp, current_timestamp
    )
    ON CONFLICT (from_entity_id, to_entity_id, relationship_type_id)
      WHERE deleted_at IS NULL
    DO UPDATE SET
      metadata = EXCLUDED.metadata,
      source = EXCLUDED.source,
      updated_by = EXCLUDED.updated_by,
      updated_at = current_timestamp,
      deleted_at = NULL
  `;
}

/**
 * Upsert config-sourced `about` edges for one connection and reconcile away
 * stale config edges (manual edges are never touched).
 */
export async function syncConnectionChannelAboutEdges(opts: {
	organizationId: string;
	connectionId: string | number;
	connectorKey: string;
	teamId: string | null | undefined;
	channels: ChannelAboutTarget[];
	userId?: string | null;
	sql?: DbClient;
}): Promise<{ linked: number; removed: number }> {
	const sql = opts.sql ?? getDb();
	const typeId = await ensureAboutRelationshipType(opts.organizationId, sql);
	const connectionId = String(opts.connectionId);

	const desiredPairs = new Set<string>();
	let linked = 0;

	for (const channel of opts.channels) {
		const { key } = channelResourceIdentity(
			opts.connectorKey,
			opts.teamId,
			channel.channelId,
		);
		const channelEntityId = await ensureChannelResourceEntity({
			organizationId: opts.organizationId,
			connectorKey: opts.connectorKey,
			teamId: opts.teamId,
			channelId: channel.channelId,
			sql,
		});
		if (channelEntityId === null) {
			logger.warn(
				{
					organization_id: opts.organizationId,
					connection_id: connectionId,
					channel_id: channel.channelId,
				},
				"Skipped channel about sync — channel entity could not be resolved",
			);
			continue;
		}

		const metadata: ChannelAboutMetadata = {
			connection_id: connectionId,
			channel_key: key,
		};

		for (const businessEntityId of channel.aboutEntityIds) {
			const pairKey = `${channelEntityId}:${businessEntityId}`;
			desiredPairs.add(pairKey);
			await upsertAboutEdge({
				organizationId: opts.organizationId,
				fromChannelEntityId: channelEntityId,
				toBusinessEntityId: businessEntityId,
				source: ABOUT_EDGE_SOURCE_CONFIG,
				metadata,
				userId: opts.userId,
				typeId,
				sql,
			});
			linked += 1;
		}
	}

	const existing = await sql<{
		id: number;
		from_entity_id: number;
		to_entity_id: number;
	}>`
    SELECT r.id, r.from_entity_id, r.to_entity_id
    FROM entity_relationships r
    WHERE r.organization_id = ${opts.organizationId}
      AND r.relationship_type_id = ${typeId}
      AND r.source = ${ABOUT_EDGE_SOURCE_CONFIG}
      AND r.deleted_at IS NULL
      AND r.metadata->>'connection_id' = ${connectionId}
  `;

	let removed = 0;
	for (const row of existing) {
		const pairKey = `${Number(row.from_entity_id)}:${Number(row.to_entity_id)}`;
		if (desiredPairs.has(pairKey)) continue;
		await sql`
      UPDATE entity_relationships
      SET deleted_at = current_timestamp, updated_at = current_timestamp
      WHERE id = ${row.id}
    `;
		removed += 1;
	}

	return { linked, removed };
}

/** Replace manual `about` edges for one channel (UI picker). */
export async function setManualChannelAboutEdges(opts: {
	organizationId: string;
	connectionId: string | number;
	connectorKey: string;
	teamId: string | null | undefined;
	channelId: string;
	aboutEntityIds: number[];
	userId?: string | null;
	sql?: DbClient;
}): Promise<void> {
	const sql = opts.sql ?? getDb();
	const typeId = await ensureAboutRelationshipType(opts.organizationId, sql);
	const connectionId = String(opts.connectionId);
	const { key } = channelResourceIdentity(
		opts.connectorKey,
		opts.teamId,
		opts.channelId,
	);

	const channelEntityId = await ensureChannelResourceEntity({
		organizationId: opts.organizationId,
		connectorKey: opts.connectorKey,
		teamId: opts.teamId,
		channelId: opts.channelId,
		sql,
	});
	if (channelEntityId === null) {
		throw new Error("Channel entity could not be resolved for this channel");
	}

	const metadata: ChannelAboutMetadata = {
		connection_id: connectionId,
		channel_key: key,
	};

	const desired = new Set(opts.aboutEntityIds.map(Number));

	const existing = await sql<{ id: number; to_entity_id: number }>`
    SELECT r.id, r.to_entity_id
    FROM entity_relationships r
    WHERE r.organization_id = ${opts.organizationId}
      AND r.from_entity_id = ${channelEntityId}
      AND r.relationship_type_id = ${typeId}
      AND r.source = ${ABOUT_EDGE_SOURCE_MANUAL}
      AND r.deleted_at IS NULL
      AND r.metadata->>'connection_id' = ${connectionId}
  `;

	for (const row of existing) {
		const toId = Number(row.to_entity_id);
		if (desired.has(toId)) {
			desired.delete(toId);
			continue;
		}
		await sql`
      UPDATE entity_relationships
      SET deleted_at = current_timestamp, updated_at = current_timestamp
      WHERE id = ${row.id}
    `;
	}

	for (const businessEntityId of desired) {
		await upsertAboutEdge({
			organizationId: opts.organizationId,
			fromChannelEntityId: channelEntityId,
			toBusinessEntityId: businessEntityId,
			source: ABOUT_EDGE_SOURCE_MANUAL,
			metadata,
			userId: opts.userId,
			typeId,
			sql,
		});
	}
}

export interface ChannelAboutEntity {
	id: number;
	name: string;
	slug: string | null;
}

/** Business entities linked to a channel via `about` (any source). */
export async function listChannelAboutEntities(opts: {
	organizationId: string;
	connectionId: string | number;
	connectorKey: string;
	teamId: string | null | undefined;
	channelId: string;
	sql?: DbClient;
}): Promise<ChannelAboutEntity[]> {
	const sql = opts.sql ?? getDb();
	const bareChannelId = opts.channelId.includes(":")
		? opts.channelId.slice(opts.channelId.indexOf(":") + 1)
		: opts.channelId;
	const channelEntityId = await findChannelResourceEntityId({
		organizationId: opts.organizationId,
		connectorKey: opts.connectorKey,
		teamId: opts.teamId,
		channelId: bareChannelId,
		sql,
	});
	if (channelEntityId === null) return [];
	const ids = await listChannelAboutEntityIds({
		organizationId: opts.organizationId,
		channelEntityId,
		sql,
	});
	if (ids.length === 0) return [];
	const rows = await sql<{ id: number; name: string; slug: string | null }>`
    SELECT id, name, slug
    FROM entities
    WHERE organization_id = ${opts.organizationId}
      AND id = ANY(${pgBigintArray(ids)}::bigint[])
      AND deleted_at IS NULL
    ORDER BY name NULLS LAST, id
  `;
	return rows.map((r) => ({
		id: Number(r.id),
		name: r.name,
		slug: r.slug,
	}));
}

/** Business entity ids linked to a channel via `about` (any source). */
export async function listChannelAboutEntityIds(opts: {
	organizationId: string;
	channelEntityId: number;
	sql?: DbClient;
}): Promise<number[]> {
	const sql = opts.sql ?? getDb();
	const typeId = await findAboutRelationshipTypeId(opts.organizationId, sql);
	if (typeId === null) return [];
	const rows = await sql<{ to_entity_id: number }>`
    SELECT r.to_entity_id
    FROM entity_relationships r
    WHERE r.organization_id = ${opts.organizationId}
      AND r.from_entity_id = ${opts.channelEntityId}
      AND r.relationship_type_id = ${typeId}
      AND r.deleted_at IS NULL
    ORDER BY r.to_entity_id
  `;
	return rows.map((r) => Number(r.to_entity_id));
}

/** Reverse lookup: channel resource entities with an `about` edge to a business entity. */
export async function listChannelEntitiesAboutBusinessEntity(opts: {
	organizationId: string;
	businessEntityId: number;
	sql?: DbClient;
}): Promise<
	Array<{
		channelEntityId: number;
		channelName: string | null;
		connectionId: string | null;
		channelKey: string | null;
	}>
> {
	const sql = opts.sql ?? getDb();
	const typeId = await findAboutRelationshipTypeId(opts.organizationId, sql);
	if (typeId === null) return [];
	const rows = await sql<{
		channel_entity_id: number;
		channel_name: string | null;
		connection_id: string | null;
		channel_key: string | null;
	}>`
    SELECT
      r.from_entity_id AS channel_entity_id,
      e.name AS channel_name,
      r.metadata->>'connection_id' AS connection_id,
      r.metadata->>'channel_key' AS channel_key
    FROM entity_relationships r
    JOIN entities e
      ON e.id = r.from_entity_id
     AND e.organization_id = r.organization_id
     AND e.deleted_at IS NULL
    WHERE r.organization_id = ${opts.organizationId}
      AND r.to_entity_id = ${opts.businessEntityId}
      AND r.relationship_type_id = ${typeId}
      AND r.deleted_at IS NULL
    ORDER BY e.name NULLS LAST, r.from_entity_id
  `;
	return rows.map((r) => ({
		channelEntityId: Number(r.channel_entity_id),
		channelName: r.channel_name,
		connectionId: r.connection_id,
		channelKey: r.channel_key,
	}));
}

/** Channel key stored on `about` edge metadata for a streaming feed row. */
export function streamingFeedChannelKeyExpr(
	feedAlias = "f",
	connectionAlias = "c",
): string {
	return `UPPER(
    COALESCE(${connectionAlias}.external_tenant_id, '') || ':' ||
    CASE
      WHEN ${feedAlias}.feed_key LIKE '%:%'
        THEN split_part(${feedAlias}.feed_key, ':', 2)
      ELSE ${feedAlias}.feed_key
    END
  )`;
}

/**
 * True when a feed row is business-linked to `entityIdExpr` via `entity_ids`
 * tag or a streaming channel's `about` edge.
 */
export function feedLinkedToBusinessEntitySql(
	entityIdExpr: string,
	feedAlias = "f",
	connectionAlias = "c",
	orgIdExpr?: string,
): string {
	const org = orgIdExpr ?? `${feedAlias}.organization_id`;
	const tagMatch = `${entityIdExpr} = ANY(${feedAlias}.entity_ids)`;
	const aboutMatch = `(
    ${feedAlias}.kind = 'streaming'
    AND EXISTS (
      SELECT 1
      FROM entity_relationships r
      JOIN entity_relationship_types rt
        ON rt.id = r.relationship_type_id
       AND rt.organization_id = r.organization_id
       AND rt.slug = '${ABOUT_RELATIONSHIP_SLUG}'
       AND rt.status = 'active'
      WHERE r.organization_id = ${org}
        AND r.to_entity_id = ${entityIdExpr}
        AND r.deleted_at IS NULL
        AND r.metadata->>'connection_id' = ${feedAlias}.connection_id::text
        AND r.metadata->>'channel_key' = ${streamingFeedChannelKeyExpr(feedAlias, connectionAlias)}
    )
  )`;
	return `(${tagMatch} OR ${aboutMatch})`;
}

/** Business-entity ids linked to any channel on a connection via `about`. */
export function connectionAboutBusinessEntityIdsSubquery(
	connectionAlias = "c",
	orgIdExpr?: string,
): string {
	const org = orgIdExpr ?? `${connectionAlias}.organization_id`;
	return `(
    SELECT r.to_entity_id
    FROM entity_relationships r
    JOIN entity_relationship_types rt
      ON rt.id = r.relationship_type_id
     AND rt.organization_id = r.organization_id
     AND rt.slug = '${ABOUT_RELATIONSHIP_SLUG}'
     AND rt.status = 'active'
    WHERE r.organization_id = ${org}
      AND r.deleted_at IS NULL
      AND r.metadata->>'connection_id' = ${connectionAlias}.id::text
  )`;
}

/** Entity ids whose names should appear in a connection's `entity_names`. */
export function connectionLinkedEntityIdsSql(connectionAlias = "c"): string {
	return `(
    SELECT unnest(${connectionAlias}.entity_ids)
    UNION
    SELECT unnest(f.entity_ids)
    FROM feeds f
    WHERE f.connection_id = ${connectionAlias}.id
      AND f.deleted_at IS NULL
    UNION
    ${connectionAboutBusinessEntityIdsSubquery(connectionAlias)}
  )`;
}

/** True when a connection is business-linked to `entityIdExpr` (tag or about). */
export function connectionLinkedToBusinessEntitySql(
	entityIdExpr: string,
	connectionAlias = "c",
	orgIdExpr?: string,
): string {
	const org = orgIdExpr ?? `${connectionAlias}.organization_id`;
	return `(
    ${entityIdExpr} = ANY(${connectionAlias}.entity_ids)
    OR EXISTS (
      SELECT 1
      FROM feeds f
      WHERE f.connection_id = ${connectionAlias}.id
        AND f.deleted_at IS NULL
        AND ${entityIdExpr} = ANY(f.entity_ids)
    )
    OR EXISTS (
      SELECT 1
      FROM entity_relationships r
      JOIN entity_relationship_types rt
        ON rt.id = r.relationship_type_id
       AND rt.organization_id = r.organization_id
       AND rt.slug = '${ABOUT_RELATIONSHIP_SLUG}'
       AND rt.status = 'active'
      WHERE r.organization_id = ${org}
        AND r.to_entity_id = ${entityIdExpr}
        AND r.deleted_at IS NULL
        AND r.metadata->>'connection_id' = ${connectionAlias}.id::text
    )
  )`;
}

/** Entity ids whose names should appear on a feed's `entity_names`. */
export function feedLinkedEntityIdsSql(
	feedAlias = "f",
	connectionAlias = "c",
): string {
	return `(
    SELECT unnest(${feedAlias}.entity_ids)
    UNION
    SELECT r.to_entity_id
    FROM entity_relationships r
    JOIN entity_relationship_types rt
      ON rt.id = r.relationship_type_id
     AND rt.organization_id = r.organization_id
     AND rt.slug = '${ABOUT_RELATIONSHIP_SLUG}'
     AND rt.status = 'active'
    WHERE ${feedAlias}.kind = 'streaming'
      AND r.organization_id = ${feedAlias}.organization_id
      AND r.deleted_at IS NULL
      AND r.metadata->>'connection_id' = ${feedAlias}.connection_id::text
      AND r.metadata->>'channel_key' = ${streamingFeedChannelKeyExpr(feedAlias, connectionAlias)}
  )`;
}
