/**
 * Entity Management Utility
 *
 * Minimal CRUD operations for entities table.
 * All validation handled by database constraints and triggers.
 * Organization scoping ensures data isolation.
 */

import { slugify } from "@lobu/core";
import { feedLinkedToBusinessEntitySql } from "../authz/channel-about";
import {
	deferEntityFieldChange,
	type DeferredMutation,
	type MutationAttribution,
	type MutationPrincipalKind,
	runMutationGate,
} from "../authz/entity-mutation-gate";
import {
	mutationPrincipalId,
	watcherIdFromPrincipalId,
} from "../authz/entity-policy";
import {
	createDbClientFromEnv,
	type DbClient,
	getDb,
	pgBigintArray,
	pgTextArray,
} from "../db/client";
import type { Env } from "../index";
import { querySqlImpl } from "../tools/admin/query_sql";
import type { ToolContext } from "../tools/registry";
import { entityLinkMatchSql } from "./content-search";
import {
	computeFieldMerge,
	type FieldControl,
	type FieldMergeResult,
	type FieldWriteSource,
} from "./entity-field-merge";
import { type EntityHookContext, getEntityHooks } from "./entity-hooks";
import { ToolUserError } from "./errors";
import logger from "./logger";
import { requireWriteAccess } from "./organization-access";
import { RESERVED_ENTITY_TYPE_SLUGS } from "./reserved";

/** Minimal type shape needed to count stored vs derived entity rows. */
export type EntityTypeCountInput = {
	id: number;
	slug: string;
	backing_sql?: string | null;
	backing_source?: string | null;
};

/**
 * Count stored rows in `entities` for a type. Used where only physical rows
 * matter (e.g. blocking conversion of a populated type to a derived view).
 * Prefer {@link countEntitiesOfType} for display counts — that path also
 * counts derived views via the same executor as list/detail.
 */
export async function countStoredEntitiesOfType(
	typeId: number,
	organizationId: string,
): Promise<number> {
	const sql = getDb();
	const rows = await sql`
    SELECT COUNT(*)::int as count
    FROM entities e
    WHERE e.entity_type_id = ${typeId}
      AND e.organization_id = ${organizationId}
      AND e.deleted_at IS NULL
  `;
	return Number(rows[0]?.count || 0);
}

/**
 * Run a derived entity type's `backing_sql` through the shared `querySqlImpl`
 * executor (org-scoped internal tables or connection pushdown). List, detail
 * resolve, and type-level counts all go through this so pagination/total_count
 * stay consistent.
 */
export async function queryDerivedEntityView(
	backingSql: string,
	backingSource: string | undefined,
	page: { limit: number; offset: number; search?: string },
	ctx: ToolContext,
): Promise<Awaited<ReturnType<typeof querySqlImpl>>> {
	// Search pushes down only on the internal path (the connection path rejects
	// search_term); external derived views simply ignore the search box.
	const search =
		page.search && !backingSource
			? { search_term: page.search, search_columns: ["name"] as string[] }
			: {};
	return querySqlImpl(
		{
			sql: backingSql,
			connection: backingSource,
			limit: page.limit,
			offset: page.offset,
			...search,
		},
		undefined,
		ctx,
	);
}

/**
 * Display count for one entity type: stored `entities` rows, or the derived
 * view's `total_count` from {@link queryDerivedEntityView} (same path as list).
 * A failed derived query returns 0 so a broken view cannot poison type lists.
 */
export async function countEntitiesOfType(
	type: EntityTypeCountInput,
	ctx: ToolContext,
): Promise<number> {
	if (type.backing_sql) {
		try {
			const result = await queryDerivedEntityView(
				type.backing_sql,
				type.backing_source ?? undefined,
				{ limit: 1, offset: 0 },
				ctx,
			);
			if (!result.error) return Number(result.total_count) || 0;
			logger.warn(
				{ err: result.error, entityType: type.slug },
				"Failed to count derived entity type rows",
			);
		} catch (err) {
			logger.warn(
				{ err, entityType: type.slug },
				"Failed to count derived entity type rows",
			);
		}
		return 0;
	}
	return countStoredEntitiesOfType(type.id, ctx.organizationId);
}

/**
 * Batch display counts for entity-type list / bootstrap. One GROUP BY for all
 * stored types, plus parallel derived view counts via
 * {@link countEntitiesOfType}.
 */
export async function getEntityCountsByTypes(
	types: EntityTypeCountInput[],
	ctx: ToolContext,
): Promise<Map<number, number>> {
	const counts = new Map<number, number>();
	if (types.length === 0) return counts;

	const stored = types.filter((t) => !t.backing_sql);
	const derived = types.filter((t) => !!t.backing_sql);

	if (stored.length > 0) {
		const sql = getDb();
		const rows = await sql`
      SELECT e.entity_type_id AS entity_type_id, COUNT(*)::int as entity_count
      FROM entities e
      WHERE e.organization_id = ${ctx.organizationId}
        AND e.deleted_at IS NULL
      GROUP BY e.entity_type_id
    `;
		for (const row of rows) {
			counts.set(Number(row.entity_type_id), Number(row.entity_count));
		}
	}

	if (derived.length > 0) {
		await Promise.all(
			derived.map(async (t) => {
				counts.set(t.id, await countEntitiesOfType(t, ctx));
			}),
		);
	}

	return counts;
}

interface EntityCreateOptions {
	skipHooks?: boolean;
	hookContext?: EntityHookContext;
}

interface EntityUpdateOptions {
	policyPrincipalKind?: MutationPrincipalKind;
	/** Attribution for a deferred approval of blocked fields. Defaults to 'agent'. */
	attribution?: MutationAttribution;
	/** Watcher-run window, so a deferred approval groups into its per-window batch. */
	windowId?: number | null;
	/**
	 * The resolved acting-principal id (`watcher:<id>` / agent id / null), from the
	 * shared {@link resolveActingPrincipal} seam. Used directly for per-principal
	 * policy matching — the caller owns identity resolution, not this function.
	 */
	principalId?: string | null;
	/**
	 * The watcher's owning agent, folded into the gate so the agent's envelope
	 * binds a watcher's direct update (a reaction script) — see the gate's
	 * `ownerAgentId`. Null for agent/user writes.
	 */
	ownerAgentId?: string | null;
	/**
	 * False iff a watcher whose owning agent couldn't be resolved — the gate fails
	 * closed (deny). See the gate's `ownerResolved`. Defaults true.
	 */
	ownerResolved?: boolean;
}

// ============================================
// Shared Helpers
// ============================================

const CONVENIENCE_FIELDS = [
  'domain',
  'category',
  'platform_type',
  'main_market',
  'market',
  'link',
  'external_ids',
] as const;

/**
 * Merge convenience fields (domain, category, etc.) into a metadata object.
 * For creates, uses truthiness; for updates, uses `!== undefined` to allow clearing fields.
 */
function mergeConvenienceFields(
	data: Partial<EntityData>,
	base: Record<string, any>,
	mode: "create" | "update",
): Record<string, any> {
  const out = { ...base };
  for (const key of CONVENIENCE_FIELDS) {
    const value = data[key];
    if (mode === 'update') {
      if (value !== undefined) out[key] = value;
    } else if (key === 'external_ids') {
      if (value && typeof value === 'object' && Object.keys(value).length > 0) {
        out[key] = value;
      }
    } else if (value) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Convert a numeric embedding array to a PostgreSQL vector literal.
 */
export function toVectorLiteral(
	embedding: number[] | null | undefined,
): string | null {
	if (!embedding || embedding.length === 0) return null;
	return `[${embedding.join(",")}]`;
}

// ============================================
// Type Definitions
// ============================================

export interface EntityData {
  entity_type: string;
  name: string;
  slug?: string; // Auto-generated from name if not provided
  parent_id?: number | null;

  // Organization scoping
  organization_id?: string;

  // Attribution: entities.created_by is NOT NULL and FK → user. Set explicitly by
  // the approval-apply path to the approving human (a watcher/agent proposer isn't
  // a user row). Falls back to "system" — which is only valid where a matching
  // user exists — when omitted.
  created_by?: string | null;

  // Common fields
  enabled_classifiers?: string[] | null;

  // Content & embeddings (used by memory entities and any content-bearing entity)
  content?: string | null;
  embedding?: number[] | null;
  content_hash?: string | null;

  // Metadata - contains all type-specific fields
  metadata?: Record<string, any>;

  // Optional human-correction note: on a human update it is stored on the
  // field_controls marker for every field this edit claims, so the watcher (and
  // the UI) can show WHY the value was set. Ignored for agent/system writes.
  field_note?: string | null;

  // Approve/affirm: field names whose CURRENT value the human endorses as-is.
  // No value change, but ownership is claimed so a watcher can't later overwrite
  // them without an approval. This is the "approve" half of the recap feedback
  // loop; "correct" is a normal metadata update. Ignored for agent/system writes.
  affirm_fields?: string[] | null;

  // Convenience fields - will be merged into metadata
  domain?: string | null;
  category?: string | null;
  platform_type?: string | null;
  main_market?: string | null;
  external_ids?: Record<string, any>;
  market?: string | null;
  link?: string | null;
}

export interface CreatedEntity {
  id: number;
  entity_type: string;
  name: string;
  slug: string;
  parent_id: number | null;
  parent_name?: string | null;
  parent_slug?: string | null;
  parent_entity_type?: string | null;
  metadata?: Record<string, any> | null;
  enabled_classifiers?: string[] | null;
  created_at: Date;
  total_content?: number | null;
  active_connections?: number | null;
  behaviors_count?: number | null;
  children_count?: number | null;
  current_view_template_version_id?: number | null;
  warnings?: string[];
}

/**
 * Outcome of the ownership-aware merge in `updateEntity`, threaded out so the
 * caller can queue an approval for blocked (human-owned) fields. Kept off the
 * shared `CreatedEntity` interface — only `updateEntity`'s return carries it.
 */
export interface FieldMergeInfo {
  applied: string[];
  blocked: Record<string, { current: unknown; proposed: unknown }>;
}

// ============================================
// Transaction-bound row writes
// ============================================

/**
 * Physical entity-row values accepted by the internal write kernel.
 *
 * This is deliberately below the semantic CRUD layer: it performs no access,
 * policy, hook, schema, or hierarchy checks and never opens a transaction. A
 * caller must pass the pool/transaction handle that already owns those
 * decisions. Keeping the handle explicit lets projection writers join their
 * surrounding transaction without issuing entity SQL outside this module.
 */
export interface EntityRowInsert {
	organizationId: string;
	entityTypeId: number;
	name: string;
	slug: string;
	parentId?: number | null;
	metadata?: Record<string, unknown>;
	enabledClassifiers?: string[] | null;
	createdBy: string;
	content?: string | null;
	embedding?: number[] | null;
	contentHash?: string | null;
}

/** Columns the physical kernel may change without making selectors dynamic. */
export interface EntityRowPatch {
	name?: string;
	slug?: string;
	parentId?: number | null;
	metadata?: Record<string, unknown> | null;
	fieldControls?: Record<string, unknown>;
	enabledClassifiers?: string[] | null;
	content?: string | null;
	embedding?: number[] | null;
	/** true stamps deleted_at. The kernel never clears an existing tombstone. */
	softDelete?: boolean;
}

export interface InsertedEntityRow {
	id: number;
	name: string;
	slug: string;
	parent_id: number | null;
	metadata: Record<string, unknown> | null;
	created_at: Date;
}

async function insertEntityRowWithConflictMode(
	params: {
		tx: DbClient;
		row: EntityRowInsert;
	},
	onConflictDoNothing: boolean,
): Promise<InsertedEntityRow | null> {
	const { tx, row } = params;
	const embeddingLiteral = toVectorLiteral(row.embedding);
	const conflictClause = onConflictDoNothing ? tx`ON CONFLICT DO NOTHING` : tx``;
	const rows = await tx<InsertedEntityRow>`
    INSERT INTO entities (
      organization_id, entity_type_id, name, slug, parent_id, metadata,
      enabled_classifiers, created_by, content, embedding, content_hash,
      created_at, updated_at
    ) VALUES (
      ${row.organizationId}, ${row.entityTypeId}, ${row.name}, ${row.slug},
      ${row.parentId ?? null}, ${tx.json(row.metadata ?? {})},
      ${row.enabledClassifiers != null ? pgTextArray(row.enabledClassifiers) : null}::text[],
      ${row.createdBy}, ${row.content ?? null}, ${embeddingLiteral}::vector,
      ${row.contentHash ?? null}, current_timestamp, current_timestamp
    )
    ${conflictClause}
    RETURNING id, name, slug, parent_id, metadata, created_at
  `;
	return rows[0] ?? null;
}

/** Insert one physical entity row using exactly the caller's DB handle. */
export async function insertEntityRow(params: {
	tx: DbClient;
	row: EntityRowInsert;
}): Promise<InsertedEntityRow> {
	const inserted = await insertEntityRowWithConflictMode(params, false);
	if (!inserted) throw new Error("Failed to create entity");
	return inserted;
}

/**
 * Try one physical entity insert and return null on any uniqueness conflict.
 * This deliberately mirrors PostgreSQL's untargeted `ON CONFLICT DO NOTHING`;
 * callers own the domain-specific lookup that resolves the winning row.
 */
export function tryInsertEntityRow(params: {
	tx: DbClient;
	row: EntityRowInsert;
}): Promise<InsertedEntityRow | null> {
	return insertEntityRowWithConflictMode(params, true);
}

/**
 * Patch an explicit, bounded set of entity ids using the caller's DB handle.
 * Omitted fields remain unchanged; nullable fields distinguish null from
 * omission. Only live rows are patched — a tombstoned row is skipped, so the
 * kernel can never resurrect one. Every call touches updated_at, including a
 * fully blocked update whose patch ends up empty.
 *
 * Returns the ids actually written, ascending.
 */
export async function patchEntityRows(params: {
	tx: DbClient;
	ids: number[];
	patch: EntityRowPatch;
}): Promise<number[]> {
	if (params.ids.length === 0) return [];
	const { tx, patch } = params;
	const hasName = patch.name !== undefined;
	const hasSlug = patch.slug !== undefined;
	const hasParent = patch.parentId !== undefined;
	const hasMetadata = patch.metadata !== undefined;
	const hasFieldControls = patch.fieldControls !== undefined;
	const hasEnabledClassifiers = patch.enabledClassifiers !== undefined;
	const hasContent = patch.content !== undefined;
	const hasEmbedding = patch.embedding !== undefined;

	const idsLiteral = pgBigintArray(params.ids);
	const embeddingLiteral = toVectorLiteral(patch.embedding);
	const rows = await tx<{ id: number }>`
    UPDATE entities SET
      name = CASE WHEN ${hasName} THEN ${patch.name ?? null} ELSE name END,
      slug = CASE WHEN ${hasSlug} THEN ${patch.slug ?? null} ELSE slug END,
      parent_id = CASE WHEN ${hasParent} THEN ${patch.parentId ?? null}::bigint ELSE parent_id END,
      metadata = CASE WHEN ${hasMetadata} THEN ${patch.metadata == null ? null : tx.json(patch.metadata)} ELSE metadata END,
      field_controls = CASE WHEN ${hasFieldControls} THEN ${tx.json(patch.fieldControls ?? {})} ELSE field_controls END,
      enabled_classifiers = CASE WHEN ${hasEnabledClassifiers} THEN ${patch.enabledClassifiers != null ? pgTextArray(patch.enabledClassifiers) : null}::text[] ELSE enabled_classifiers END,
      content = CASE WHEN ${hasContent} THEN ${patch.content ?? null} ELSE content END,
      embedding = CASE WHEN ${hasEmbedding} THEN ${embeddingLiteral}::vector ELSE embedding END,
      deleted_at = CASE WHEN ${patch.softDelete === true} THEN current_timestamp ELSE deleted_at END,
      updated_at = current_timestamp
    WHERE id = ANY(${idsLiteral}::bigint[])
      AND deleted_at IS NULL
    RETURNING id
  `;
	return rows.map((row) => Number(row.id)).sort((a, b) => a - b);
}

/** Hard-delete an explicit, bounded set of entity ids on the caller's handle. */
export async function hardDeleteEntityRows(params: {
	tx: DbClient;
	ids: number[];
}): Promise<number[]> {
	if (params.ids.length === 0) return [];
	const idsLiteral = pgBigintArray(params.ids);
	const rows = await params.tx<{ id: number }>`
    DELETE FROM entities
    WHERE id = ANY(${idsLiteral}::bigint[])
    RETURNING id
  `;
	return rows.map((row) => Number(row.id)).sort((a, b) => a - b);
}

/**
 * Lock one live entity in the caller's transaction, apply the pure ownership
 * merge, and persist the resulting metadata and controls through the physical
 * row kernel. Callers remain responsible for audit events or approval delivery.
 */
export async function mergeEntityFields(params: {
	tx: DbClient;
	entityId: number;
	fields: Record<string, unknown>;
	source: FieldWriteSource;
	/** User id for a human edit; null/system otherwise. */
	actorId: string | null;
	note?: string | null;
	/** Snapshot the proposal was built on (deferred-apply staleness guard). */
	expectedCurrent?: Record<string, unknown> | null;
	/** Fields (human source) whose current value is approved as-is, claiming
	 * ownership without a value change. */
	affirm?: string[];
	/** Additional fields a non-human policy decision requires approval for. */
	requireApproval?: string[] | Set<string>;
}): Promise<FieldMergeResult> {
	const { tx, entityId, fields, source, actorId } = params;
	const rows = await tx<{ metadata: unknown; field_controls: unknown }>`
    SELECT metadata, field_controls FROM entities
    WHERE id = ${entityId} AND deleted_at IS NULL
    FOR UPDATE
  `;
	if (rows.length === 0) {
		throw new Error(`Entity ${entityId} not found`);
	}

	const metadata = parseEntityJsonObject(rows[0].metadata);
	const controls = parseEntityJsonObject(rows[0].field_controls) as Record<
		string,
		FieldControl
	>;
	const merge = computeFieldMerge({
		metadata,
		controls,
		fields,
		source,
		actorId,
		note: params.note ?? null,
		nowIso: new Date().toISOString(),
		expectedCurrent: params.expectedCurrent ?? null,
		affirm: params.affirm,
		requireApproval: params.requireApproval,
	});

	if (merge.changed) {
		await patchEntityRows({
			tx,
			ids: [entityId],
			patch: {
				metadata: merge.nextMetadata,
				fieldControls: merge.nextControls,
			},
		});
	}
	return merge;
}

function parseEntityJsonObject(value: unknown): Record<string, unknown> {
	if (value == null) return {};
	if (typeof value === "string") {
		try {
			return JSON.parse(value) as Record<string, unknown>;
		} catch {
			return {};
		}
	}
	return value as Record<string, unknown>;
}

// ============================================
// Validation Helpers
// ============================================

/**
 * Check for circular parent references in entity hierarchy.
 * Replaces the PostgreSQL `prevent_entity_cycles()` trigger.
 *
 * Walks up the ancestor chain from the proposed parent_id.
 * If we encounter `entityId` as an ancestor, that would create a cycle.
 */
async function preventEntityCycles(
	entityId: number | null,
	parentId: number | null,
): Promise<void> {
  if (parentId === null) return;

  const sql = getDb();
  const MAX_DEPTH = 10;
  let currentId: number | null = parentId;
  let depth = 0;

  while (currentId !== null) {
    if ((entityId !== null && currentId === entityId) || ++depth >= MAX_DEPTH) {
      throw new Error('Circular reference detected or hierarchy too deep (max 10 levels)');
    }

    const rows: Array<Record<string, unknown>> = await sql`
      SELECT parent_id FROM entities WHERE id = ${currentId}
    `;
    currentId = rows.length > 0 ? (rows[0].parent_id as number | null) : null;
  }
}

async function loadEntityTreeIds(sql: DbClient, entityId: number): Promise<number[]> {
  const rows = await sql<{ id: number }>`
    WITH RECURSIVE entity_tree AS (
      SELECT id
      FROM entities
      WHERE id = ${entityId}
      UNION ALL
      SELECT e.id
      FROM entities e
      JOIN entity_tree et ON e.parent_id = et.id
    )
    SELECT id
    FROM entity_tree
  `;

  return rows.map((row) => Number(row.id));
}

// ============================================
// CRUD Operations
// ============================================

/**
 * Create new entity
 * Entity is created in the user's organization
 */
export async function createEntity(
	data: EntityData,
	opts?: EntityCreateOptions,
): Promise<CreatedEntity> {
	// Input validation
	if (!data.name || data.name.trim().length === 0) {
		throw new Error("Entity name is required");
	}

	if (!data.entity_type || data.entity_type.trim().length === 0) {
		throw new Error("Entity type is required");
	}

	// Illegal type *names* that are not knowledge types (routes / product words).
	// System types ($member, $resource) are valid entity instance types.
	if (
		(RESERVED_ENTITY_TYPE_SLUGS as readonly string[]).includes(
			data.entity_type.toLowerCase(),
		)
	) {
		throw new Error(
			`Cannot create entity with reserved type '${data.entity_type}'. Reserved: ${RESERVED_ENTITY_TYPE_SLUGS.join(", ")}`,
		);
	}

	if (!data.organization_id) {
		throw new Error("Organization ID is required");
	}

	// Run beforeCreate hook
	if (!opts?.skipHooks && opts?.hookContext) {
		const hooks = getEntityHooks(data.entity_type);
		if (hooks?.beforeCreate) {
			data = await hooks.beforeCreate(data, opts.hookContext);
		}
	}

	const sql = getDb();

	// Resolve entity_type slug → entity_types(id) via the schema search path:
	//   1. The entity's own org (the user's tenant — local types win).
	//   2. Any org with visibility='public' (canonical/world-knowledge catalogs).
	// First match wins. The resolved id is materialized on the row so reads
	// never need to repeat the search. `ORDER BY (et.organization_id = own_org)
	// DESC` keeps tenant-local types ahead of public ones when both exist.
	//
	// KNOWN LIMITATION: this trusts every visibility='public' org as a curated
	// catalog. If a tenant can flip their own org public *and* register types
	// before another tenant references the same slug, they could squat on
	// common slugs (`brand`, `tax_filing`). Operationally we restrict
	// visibility flips to admins; long-term the right fix is either an
	// explicit `is_catalog` flag on `organization` or per-agent `uses_catalog`
	// declarations narrowing the search scope.
	const typeRow = await sql<{ id: number; backing_sql: string | null }>`
    SELECT et.id, et.backing_sql
    FROM entity_types et
    LEFT JOIN organization o ON o.id = et.organization_id
    WHERE et.slug = ${data.entity_type}
      AND et.deleted_at IS NULL
      AND (
        et.organization_id = ${data.organization_id}
        OR o.visibility = 'public'
      )
    ORDER BY (et.organization_id = ${data.organization_id}) DESC, et.id ASC
    LIMIT 1
  `;
	if (typeRow.length === 0) {
		throw new ToolUserError(
			`Unknown entity type '${data.entity_type}'. Use client.entitySchema.listTypes() to list available types or client.entitySchema.createType(...) to create a custom type first.`,
			400,
		);
	}
	// A derived (view-backed) type has no stored rows — its data is its backing_sql
	// view. Reject inserts here (the single chokepoint; covers tenant + public
	// catalog types) so a row the view ignores can't be orphaned.
	if (typeRow[0].backing_sql) {
		throw new ToolUserError(
			`Entity type '${data.entity_type}' is derived (a SQL view) and has no stored rows. Edit its backing view instead of creating entities.`,
			400,
		);
	}
	const entityTypeId = typeRow[0].id;

	// Generate slug from name if not provided
	const slug = data.slug || slugify(data.name);

	const metadata = mergeConvenienceFields(data, data.metadata || {}, "create");

	const createdBy = data.created_by || "system";

	// Validate parent hierarchy (replaces prevent_entity_cycles trigger)
	if (data.parent_id) {
		await preventEntityCycles(null, data.parent_id);
	}

	const contentValue = data.content?.trim() || null;
	const contentHash = data.content_hash || null;

	try {
		const inserted = await sql.begin(async (tx) => {
			return insertEntityRow({
				tx,
				row: {
					organizationId: data.organization_id as string,
					entityTypeId,
					name: data.name.trim(),
					slug,
					parentId: data.parent_id || null,
					metadata,
					enabledClassifiers: data.enabled_classifiers,
					createdBy,
					content: contentValue,
					embedding: data.embedding,
					contentHash,
				},
			});
		});

		// The validator above already resolved data.entity_type → entityTypeId.
		// Pass the slug back through directly rather than JOIN-ing on every insert.
		const created: CreatedEntity = {
			...inserted,
			entity_type: data.entity_type,
		};

		// Run afterCreate hook
		if (!opts?.skipHooks && opts?.hookContext) {
			const hooks = getEntityHooks(created.entity_type);
			if (hooks?.afterCreate) {
				await hooks.afterCreate(created, opts.hookContext);
			}
		}

		return created;
	} catch (error: any) {
		const msg = error.message ?? "";

		// Handle database constraint violations
		if (msg.includes("duplicate key") || msg.includes("unique constraint")) {
			throw new Error("Entity already exists with this name/domain");
		}
		if (msg.includes("foreign key")) {
			if (data.parent_id) {
				throw new Error(`Parent entity ${data.parent_id} does not exist`);
			}
			throw new Error(`Foreign key violation: ${msg}`);
		}
		if (msg.includes("check constraint")) {
			throw new Error(`Invalid entity data: ${msg}`);
		}
		if (msg.includes("Circular reference")) {
			throw new Error("Cannot create circular entity hierarchy");
		}
		throw error;
	}
}

/**
 * Update existing entity
 * Database handles validation
 * Requires write access (entity must belong to user's organization)
 */
export async function updateEntity(
	entityId: number,
	data: Partial<EntityData>,
	env: Env,
	ctx: ToolContext,
	opts?: EntityUpdateOptions,
): Promise<
	CreatedEntity & { fieldMerge?: FieldMergeInfo; deferred?: DeferredMutation }
> {
	const pgSql = createDbClientFromEnv(env);
	const sql = getDb();

	// Validate write access (uses PG for auth tables)
	await requireWriteAccess(pgSql, entityId, ctx);

	// Validate parent hierarchy (replaces prevent_entity_cycles trigger)
	if (data.parent_id !== undefined && data.parent_id !== null) {
		await preventEntityCycles(entityId, data.parent_id);
	}

	// Generate new slug if provided or name is being updated
	const newSlug = data.slug ?? (data.name ? slugify(data.name) : null);

	const metadataUpdates = mergeConvenienceFields(
		data,
		data.metadata ?? {},
		"update",
	);
	const hasMetadataUpdates = Object.keys(metadataUpdates).length > 0;
	const affirmFields = Array.isArray(data.affirm_fields)
		? data.affirm_fields
		: [];

	// A genuine human edit (a real user, not an agent run) claims per-field
	// ownership so a watcher can't later overwrite it without an approval. Every
	// non-human write (chat agent or watcher reaction via manage_entity) is an
	// ownership-aware watcher-source merge: unowned fields write, owned fields
	// are blocked and surfaced to the caller for an approval. There is no
	// plain-merge branch — the only caller is agent-attributed.
	const isHumanEdit = !!ctx.userId && !ctx.agentId;
	// affirm_fields claims ownership, which only a human may do. An agent must
	// never silently claim a field — reject before touching the transaction.
	if (!isHumanEdit && affirmFields.length > 0) {
		throw new Error("affirm_fields is only allowed for human edits");
	}

	const hasContent = data.content !== undefined;
	const contentValue = data.content?.trim() || null;
	const hasEmbedding = data.embedding !== undefined;

	// An affirm-only edit (approve a value as-is) has no metadata delta but still
	// must run the merge so it can claim field ownership.
	const hasAffirm = isHumanEdit && affirmFields.length > 0;

	// Outcome of the ownership-aware merge, threaded out so the caller can queue
	// an approval for blocked (human-owned) fields AFTER the tx commits.
	let fieldMerge: FieldMergeInfo | undefined;

	// Lock the entity row, merge metadata, and write in ONE transaction: concurrent
	// updates to the same entity serialize on the row lock, fixing the pre-existing
	// non-transactional read-modify-write race on entities.metadata.
	const result = await sql.begin(async (tx) => {
		const current = await tx`
      SELECT e.metadata, e.field_controls, e.organization_id, et.slug AS entity_type,
             e.name, e.parent_id, e.content
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.id = ${entityId} AND e.deleted_at IS NULL
      FOR UPDATE
    `;
		if (current.length === 0) {
			throw new Error(`Entity ${entityId} not found`);
		}

		const existing = (
			typeof current[0].metadata === "string"
				? JSON.parse(current[0].metadata as string)
				: (current[0].metadata ?? {})
		) as Record<string, unknown>;
		const existingControls = (
			typeof current[0].field_controls === "string"
				? JSON.parse(current[0].field_controls as string)
				: (current[0].field_controls ?? {})
		) as Record<string, FieldControl>;

		// Non-human edits run ONE policy pass over metadata fields AND the
		// top-level attributes (name/content/parent_id as reserved $-paths, so a
		// field-scoped policy can target them too). A gated attribute is stripped
		// from this write and queued as a blocked change like any owned field —
		// otherwise "updates need approval" would gate metadata while an agent
		// could still rename or re-parent the entity.
		const requireApproval: string[] = [];
		const blockedAttributes: Record<
			string,
			{ current: unknown; proposed: unknown }
		> = {};
		let applyName = data.name !== undefined;
		let applyParent = data.parent_id !== undefined;
		let applyContent = hasContent;
		if (!isHumanEdit) {
			const principalKind: MutationPrincipalKind =
				opts?.policyPrincipalKind ?? "agent";
			const attributeProposals: Record<
				string,
				{ current: unknown; proposed: unknown }
			> = {};
			if (applyName && (data.name ?? null) !== (current[0].name ?? null)) {
				attributeProposals.$name = {
					current: current[0].name ?? null,
					proposed: data.name ?? null,
				};
			}
			const currentParentId =
				current[0].parent_id == null ? null : Number(current[0].parent_id);
			if (applyParent && (data.parent_id ?? null) !== currentParentId) {
				attributeProposals.$parent_id = {
					current: currentParentId,
					proposed: data.parent_id ?? null,
				};
			}
			if (
				applyContent &&
				contentValue !== ((current[0].content as string | null) ?? null)
			) {
				attributeProposals.$content = {
					current: current[0].content ?? null,
					proposed: contentValue,
				};
			}
			const fieldOwners = {
				...(Object.fromEntries(
					Object.keys(metadataUpdates).map((field) => [
						field,
						Object.hasOwn(existingControls, field) ? "human" : "none",
					]),
				) as Record<string, "human" | "none">),
				...(Object.fromEntries(
					Object.keys(attributeProposals).map((attr) => [attr, "none"]),
				) as Record<string, "none">),
			};
			if (Object.keys(fieldOwners).length > 0) {
				const decision = await runMutationGate({
					action: "update",
					organizationId: ctx.organizationId,
					principalKind,
					sql: tx,
					attribution: opts?.attribution ?? "agent",
					windowId: opts?.windowId ?? null,
					principalId:
						opts?.principalId ??
						mutationPrincipalId({ agentId: ctx.agentId }),
					ownerAgentId: opts?.ownerAgentId ?? null,
					ownerResolved: opts?.ownerResolved ?? true,
					entityTypeSlug: String(current[0].entity_type),
					entityId,
					entityOrgId: String(current[0].organization_id),
					fields: fieldOwners,
				});
				if (decision.outcome === "deny") {
					throw new ToolUserError(decision.reason, 403);
				}
				for (const field of decision.requireApproval) {
					if (attributeProposals[field]) {
						blockedAttributes[field] = attributeProposals[field];
						if (field === "$name") applyName = false;
						if (field === "$parent_id") applyParent = false;
						if (field === "$content") applyContent = false;
					} else {
						requireApproval.push(field);
					}
				}
			}
		}

		let mergedMetadata: Record<string, unknown> | null = null;
		let mergedControls: Record<string, unknown> | null = null;
		if (hasMetadataUpdates || hasAffirm) {
			const merge = computeFieldMerge({
				metadata: existing,
				controls: existingControls,
				fields: metadataUpdates,
				source: isHumanEdit ? "human" : "watcher",
				actorId: isHumanEdit
					? ctx.userId
					: (ctx.agentId ?? ctx.clientId ?? null),
				note: isHumanEdit ? (data.field_note ?? null) : null,
				nowIso: new Date().toISOString(),
				affirm: isHumanEdit ? affirmFields : undefined,
				requireApproval,
			});
			mergedMetadata = merge.nextMetadata;
			// A human edit claims ownership of the fields it sets; a watcher-source
			// merge never claims ownership, so leave field_controls untouched.
			mergedControls = isHumanEdit ? merge.nextControls : null;
			fieldMerge = {
				applied: Object.keys(merge.applied),
				blocked: Object.fromEntries(
					Object.entries(merge.blocked).map(([p, v]) => [
						p,
						{ current: v.current, proposed: v.proposed },
					]),
				),
			};
		}
		if (Object.keys(blockedAttributes).length > 0) {
			fieldMerge = {
				applied: fieldMerge?.applied ?? [],
				blocked: { ...(fieldMerge?.blocked ?? {}), ...blockedAttributes },
			};
		}

		const rowPatch: EntityRowPatch = {};
		if (applyName && data.name !== undefined) rowPatch.name = data.name;
		const slugPatch = data.slug ?? (applyName ? newSlug : null);
		if (slugPatch !== null) rowPatch.slug = slugPatch;
		if (applyParent) rowPatch.parentId = data.parent_id ?? null;
		if (hasMetadataUpdates) rowPatch.metadata = mergedMetadata;
		if (mergedControls !== null) rowPatch.fieldControls = mergedControls;
		if (data.enabled_classifiers !== undefined) {
			rowPatch.enabledClassifiers = data.enabled_classifiers;
		}
		if (applyContent) rowPatch.content = contentValue;
		if (hasEmbedding && (applyContent || !hasContent)) {
			rowPatch.embedding = data.embedding ?? null;
		}
		await patchEntityRows({ tx, ids: [entityId], patch: rowPatch });

    const sel = await tx<CreatedEntity>`
      SELECT e.id, et.slug AS entity_type, e.name, e.slug, e.parent_id, e.metadata, e.created_at
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.id = ${entityId}
      LIMIT 1
    `;
		if (sel.length === 0) {
			throw new Error(`Entity ${entityId} not found`);
		}
		return { ...sel[0], fieldMerge } as CreatedEntity & {
			fieldMerge?: FieldMergeInfo;
		};
	});

	// Post-commit: package any blocked (human-owned or policy-gated) fields as a
	// single deferred approval. The caller queues it AFTER its own tx + change
	// event so the approval never rides — nor rolls back with — the edit.
	const blockedPaths = Object.keys(result.fieldMerge?.blocked ?? {});
	if (blockedPaths.length > 0) {
		const blocked = result.fieldMerge?.blocked ?? {};
		return {
			...result,
			deferred: deferEntityFieldChange({
				entityId,
				fields: Object.fromEntries(
					blockedPaths.map((p) => [p, blocked[p].proposed]),
				),
				current: Object.fromEntries(
					blockedPaths.map((p) => [p, blocked[p].current]),
				),
				attribution: opts?.attribution ?? "agent",
				// The approval card groups by the acting watcher; recover its numeric
				// id from the resolved principalId (`watcher:<id>`), null otherwise.
				watcherId: watcherIdFromPrincipalId(opts?.principalId ?? null),
				windowId: opts?.windowId ?? null,
			}),
		};
	}

	return result;
}

/**
 * Get entity by ID
 * Only returns entity if user has read access (own org or public)
 */
export async function getEntity(
	entityId: number,
	_env: Env,
	ctx: ToolContext,
	opts?: { includeDeleted?: boolean },
): Promise<CreatedEntity | null> {
  const sql = getDb();
  if (!ctx.organizationId) return null;
  const includeDeleted = opts?.includeDeleted ?? false;

  // Operational counts always scope to the caller's org. When `e` is a
  // public-catalog entity, totals reflect the caller's events/feeds/watchers/
  // children that reference it — never cross-tenant activity around the
  // public row.
  //
  // Visibility branches checked here:
  //   1. caller's own org (always readable)
  //   2. public-catalog entity (anyone reads, except `$member`)
  const result = await sql<CreatedEntity>`
    SELECT
      e.id, et.slug AS entity_type, e.name, e.slug, e.parent_id, e.metadata, e.created_at,
      e.current_view_template_version_id,
      pe.name as parent_name, pe.slug as parent_slug, pet.slug as parent_entity_type,
      (
        SELECT COUNT(*) FROM current_event_records ev
        WHERE ${sql.unsafe(entityLinkMatchSql('e.id::bigint', 'ev'))}
          AND ev.organization_id = ${ctx.organizationId}
      ) as total_content,
      (
        SELECT COUNT(DISTINCT c.connector_key)
        FROM feeds f
        JOIN connections c ON c.id = f.connection_id
        WHERE f.organization_id = ${ctx.organizationId}
          AND f.deleted_at IS NULL
          AND c.deleted_at IS NULL
          AND ${sql.unsafe(feedLinkedToBusinessEntitySql('e.id', 'f', 'c', 'e.organization_id'))}
      ) as active_connections,
      (
        SELECT COUNT(*) FROM watchers i
        WHERE e.id = ANY(i.entity_ids)
          AND i.organization_id = ${ctx.organizationId}
      ) as behaviors_count,
      (
        SELECT COUNT(*) FROM entities c
        WHERE c.parent_id = e.id
          AND c.organization_id = ${ctx.organizationId}
          AND c.deleted_at IS NULL
      ) as children_count
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    LEFT JOIN entities pe ON e.parent_id = pe.id
    LEFT JOIN entity_types pet ON pet.id = pe.entity_type_id
    LEFT JOIN organization eo ON eo.id = e.organization_id
    WHERE e.id = ${entityId}
      AND (
        e.organization_id = ${ctx.organizationId}
        OR (eo.visibility = 'public' AND et.slug <> '$member')
      )
      ${includeDeleted ? sql`` : sql`AND e.deleted_at IS NULL`}
  `;

  return result.length > 0 ? result[0] : null;
}

/**
 * Force-delete dependency report: what a hard delete of the tree removes or
 * detaches. Computed up front so `dry_run` can return it without mutating and
 * the real delete can echo exactly what it touched. Event rows are append-only
 * and are only ever detached, never deleted.
 */
export interface ForceDeleteTreeReport {
  entities: number;
  relationships: number;
  behaviors_deleted: number;
  behaviors_detached: number;
  feeds_deleted: number;
  feeds_detached: number;
  events_detached: number;
}

/**
 * Delete entity
 * Soft delete by default (sets deleted_at), hard delete with force=true.
 * A hard delete removes the tree + its relationships, deletes/detaches
 * dependent behaviors and feeds, and detaches (never deletes) event rows that
 * reference the tree. `dryRun` returns the dependency report without mutating.
 * Requires write access (entity must belong to user's organization)
 */
export async function deleteEntity(
	entityId: number,
	force: boolean = false,
	env: Env,
	ctx: ToolContext,
	opts?: { skipHooks?: boolean; dryRun?: boolean },
): Promise<{
  message: string;
  deleted: number;
  dry_run?: boolean;
  tree?: ForceDeleteTreeReport;
}> {
  const pgSql = createDbClientFromEnv(env);
  const sql = getDb();

  // Validate write access (uses PG for auth tables)
  await requireWriteAccess(pgSql, entityId, ctx);

  // Run beforeDelete hook (a dry run mutates nothing, so hooks stay silent)
  if (!opts?.skipHooks && !opts?.dryRun) {
    const entityRow = await sql`
      SELECT et.slug AS entity_type, e.metadata
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.id = ${entityId} AND e.deleted_at IS NULL
    `;
    if (entityRow.length > 0) {
      const hooks = getEntityHooks(entityRow[0].entity_type as string);
      if (hooks?.beforeDelete) {
        await hooks.beforeDelete(
          {
            id: entityId,
            entity_type: entityRow[0].entity_type as string,
            metadata: entityRow[0].metadata as Record<string, unknown> | null,
          },
          { organizationId: ctx.organizationId, userId: ctx.userId }
        );
      }
    }
  }

  // Check if entity has children
  if (!force) {
    const children = await sql`
      SELECT COUNT(*) as count
      FROM entities
      WHERE parent_id = ${entityId}
        AND deleted_at IS NULL
    `;

    const childCount = Number(children[0]?.count || 0);
    if (childCount > 0) {
      throw new Error(
        `Cannot delete entity: it has ${childCount} child entities. Use force_delete_tree=true to delete the entire hierarchy.`
      );
    }
  }

  if (force) {
    const entityTreeIds = await loadEntityTreeIds(sql, entityId);
    const entityTreeIdsLiteral = pgBigintArray(entityTreeIds);

    // Preflight dependency report: what this delete removes vs. detaches.
    // A behavior/feed whose entities all live inside the tree is deleted with
    // it; one that also spans outside entities is detached (tree ids pruned
    // from its entity_ids). Event rows are append-only history — they are
    // counted here and DETACHED below, never deleted.
    const preflight = await sql<Record<string, number>>`
      SELECT
        (SELECT COUNT(*) FROM entity_relationships r
          WHERE r.from_entity_id = ANY(${entityTreeIdsLiteral}::bigint[])
             OR r.to_entity_id = ANY(${entityTreeIdsLiteral}::bigint[]))::int AS relationships,
        (SELECT COUNT(*) FROM watchers w
          WHERE w.entity_ids && ${entityTreeIdsLiteral}::bigint[]
            AND w.entity_ids <@ ${entityTreeIdsLiteral}::bigint[])::int AS behaviors_deleted,
        (SELECT COUNT(*) FROM watchers w
          WHERE w.entity_ids && ${entityTreeIdsLiteral}::bigint[]
            AND NOT (w.entity_ids <@ ${entityTreeIdsLiteral}::bigint[]))::int AS behaviors_detached,
        (SELECT COUNT(*) FROM feeds f
          WHERE f.entity_ids && ${entityTreeIdsLiteral}::bigint[]
            AND f.entity_ids <@ ${entityTreeIdsLiteral}::bigint[])::int AS feeds_deleted,
        (SELECT COUNT(*) FROM feeds f
          WHERE f.entity_ids && ${entityTreeIdsLiteral}::bigint[]
            AND NOT (f.entity_ids <@ ${entityTreeIdsLiteral}::bigint[]))::int AS feeds_detached,
        (SELECT COUNT(*) FROM events e
          WHERE e.entity_ids && ${entityTreeIdsLiteral}::bigint[])::int AS events_detached
    `;
    const report: ForceDeleteTreeReport = {
      entities: entityTreeIds.length,
      relationships: Number(preflight[0]?.relationships || 0),
      behaviors_deleted: Number(preflight[0]?.behaviors_deleted || 0),
      behaviors_detached: Number(preflight[0]?.behaviors_detached || 0),
      feeds_deleted: Number(preflight[0]?.feeds_deleted || 0),
      feeds_detached: Number(preflight[0]?.feeds_detached || 0),
      events_detached: Number(preflight[0]?.events_detached || 0),
    };

    if (opts?.dryRun) {
      return {
        message: `Dry run: force delete would remove ${report.entities} entities and detach ${report.events_detached} event rows`,
        deleted: 0,
        dry_run: true,
        tree: report,
      };
    }

    // Deletion predicate for behaviors/feeds: only rows whose entity set is
    // non-empty AND fully inside the tree. Requiring the overlap (&&) first is
    // load-bearing — a bare `entity_ids <@ tree` (or a COALESCE to '{}') also
    // matches every empty/NULL-linked row IN EVERY ORG (empty set ⊂ anything),
    // and lets the GIN index on entity_ids drive the scan instead of a
    // full-table pass.
    await sql.begin(async (tx) => {
      await tx`
        DELETE FROM entity_relationships
        WHERE from_entity_id = ANY(${entityTreeIdsLiteral}::bigint[])
           OR to_entity_id = ANY(${entityTreeIdsLiteral}::bigint[])
      `;

      // Canvas-on-events: window_id link rows carry canvas root event ids, so
      // key the cleanup on the denormalized watcher_id.
      await tx`
        DELETE FROM watcher_window_events
        WHERE watcher_id IN (
          SELECT id
          FROM watchers
          WHERE entity_ids && ${entityTreeIdsLiteral}::bigint[]
            AND entity_ids <@ ${entityTreeIdsLiteral}::bigint[]
        )
      `;
      // Before hard-deleting watchers: if any of those rows are group roots
      // (id = watcher_group_id) with surviving siblings, transfer ownership
      // of the shared watcher_versions chain to a sibling so the upcoming
      // ON DELETE CASCADE doesn't wipe out the version row that the rest
      // of the group still depends on.
      await tx`
        UPDATE watcher_versions wv
        SET watcher_id = s.new_root
        FROM (
          SELECT r.old_root, MIN(s.id) AS new_root
          FROM (
            SELECT w.id AS old_root
            FROM watchers w
            WHERE w.id = w.watcher_group_id
              AND w.entity_ids && ${entityTreeIdsLiteral}::bigint[]
              AND w.entity_ids <@ ${entityTreeIdsLiteral}::bigint[]
          ) r
          JOIN watchers s
            ON s.watcher_group_id = r.old_root
           AND s.id <> r.old_root
           AND NOT (
             COALESCE(s.entity_ids, '{}'::bigint[]) && ${entityTreeIdsLiteral}::bigint[]
             AND COALESCE(s.entity_ids, '{}'::bigint[]) <@ ${entityTreeIdsLiteral}::bigint[]
           )
           AND NOT EXISTS (
             SELECT 1 FROM watcher_versions vv WHERE vv.watcher_id = s.id
           )
          GROUP BY r.old_root
        ) s
        WHERE wv.watcher_id = s.old_root
      `;
      await tx`
        UPDATE watchers w
        SET watcher_group_id = s.new_root,
            source_watcher_id = CASE WHEN w.source_watcher_id = s.old_root THEN s.new_root ELSE w.source_watcher_id END
        FROM (
          SELECT r.old_root, MIN(s.id) AS new_root
          FROM (
            SELECT w.id AS old_root
            FROM watchers w
            WHERE w.id = w.watcher_group_id
              AND w.entity_ids && ${entityTreeIdsLiteral}::bigint[]
              AND w.entity_ids <@ ${entityTreeIdsLiteral}::bigint[]
          ) r
          JOIN watchers s
            ON s.watcher_group_id = r.old_root
           AND s.id <> r.old_root
           AND NOT (
             COALESCE(s.entity_ids, '{}'::bigint[]) && ${entityTreeIdsLiteral}::bigint[]
             AND COALESCE(s.entity_ids, '{}'::bigint[]) <@ ${entityTreeIdsLiteral}::bigint[]
           )
           AND NOT EXISTS (
             SELECT 1 FROM watcher_versions vv WHERE vv.watcher_id = s.id
           )
          GROUP BY r.old_root
        ) s
        WHERE w.watcher_group_id = s.old_root
      `;
      await tx`
        DELETE FROM watchers
        WHERE entity_ids && ${entityTreeIdsLiteral}::bigint[]
          AND entity_ids <@ ${entityTreeIdsLiteral}::bigint[]
      `;
      // Detach survivors: prune tree ids from watchers that also span entities
      // outside the tree. Fully-contained rows were deleted above, so pruning
      // can never leave an empty entity set behind — no orphan sweep needed.
      await tx`
        UPDATE watchers
        SET entity_ids = ARRAY(
          SELECT linked_id
          FROM unnest(entity_ids) AS linked_id
          WHERE NOT (linked_id = ANY(${entityTreeIdsLiteral}::bigint[]))
        )
        WHERE entity_ids && ${entityTreeIdsLiteral}::bigint[]
      `;

      await tx`
        DELETE FROM feeds
        WHERE entity_ids && ${entityTreeIdsLiteral}::bigint[]
          AND entity_ids <@ ${entityTreeIdsLiteral}::bigint[]
      `;
      await tx`
        UPDATE feeds
        SET entity_ids = ARRAY(
          SELECT linked_id
          FROM unnest(entity_ids) AS linked_id
          WHERE NOT (linked_id = ANY(${entityTreeIdsLiteral}::bigint[]))
        )
        WHERE entity_ids && ${entityTreeIdsLiteral}::bigint[]
      `;

      // Detach event references instead of blocking on them: `events` is
      // append-only (never DELETE), but the platform's own lifecycle events
      // (change audits etc.) reference fresh entities immediately, so a hard
      // delete must prune the tree ids out of events.entity_ids — the rows
      // survive as history, they just stop pointing at deleted entities.
      // Batched so a large history can't push one UPDATE past
      // statement_timeout; still atomic (all batches share this transaction).
      const EVENT_DETACH_BATCH = 5000;
      for (;;) {
        const detached = await tx<{ id: number }>`
          UPDATE events e
          SET entity_ids = ARRAY(
            SELECT linked_id
            FROM unnest(e.entity_ids) AS linked_id
            WHERE NOT (linked_id = ANY(${entityTreeIdsLiteral}::bigint[]))
          )
          WHERE e.id IN (
            SELECT id FROM events
            WHERE entity_ids && ${entityTreeIdsLiteral}::bigint[]
            LIMIT ${EVENT_DETACH_BATCH}
          )
          RETURNING e.id
        `;
        if (detached.length < EVENT_DETACH_BATCH) break;
      }

      await hardDeleteEntityRows({ tx, ids: entityTreeIds });
    });

    return {
      message:
        report.events_detached > 0
          ? `Entity and all descendants deleted; ${report.events_detached} event rows kept as history and detached`
          : 'Entity and all descendants deleted successfully',
      deleted: entityTreeIds.length,
      tree: report,
    };
  }

  if (opts?.dryRun) {
    return {
      message: 'Dry run: entity would be soft-deleted',
      deleted: 0,
      dry_run: true,
    };
  }
  // Soft delete: stamp deleted_at. Stays a single pool-level statement, so the
  // semantic layer's existing transaction boundary is unchanged.
  await patchEntityRows({ tx: sql, ids: [entityId], patch: { softDelete: true } });

  return {
    message: 'Entity soft-deleted successfully',
    deleted: 1,
  };
}

/**
 * List entities with filters
 * Uses dynamic query fragments for scoped filtering
 * Only returns entities from readable organizations (user's org + public)
 */
export async function listEntities(
	filters: {
		entity_type?: string;
		parent_id?: number | null;
		search?: string;
		category?: string;
		main_market?: string;
		market?: string;
		limit?: number;
		offset?: number;
		sort_by?: string;
		sort_order?: "asc" | "desc";
	},
	_env: Env,
	ctx: ToolContext,
): Promise<{
  entities: CreatedEntity[];
  hasMore: boolean;
  totalCount: number;
  limit: number;
  offset: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
}> {
	const sql = getDb();
	const limit = Math.min(Math.max(filters.limit || 100, 1), 500);
	const offset = Math.max(filters.offset || 0, 0);

	if (!ctx.organizationId) {
		return {
			entities: [],
			hasMore: false,
			totalCount: 0,
			limit,
			offset,
			sortBy: filters.sort_by ?? "created_at",
			sortOrder: filters.sort_order === "asc" ? "asc" : "desc",
		};
	}

	// Derived ("view") entity types have no rows in `entities` — their rows come
	// from `backing_sql`. Return them in the standard list shape so the frontend
	// renders them with the normal table (no derived-specific UI path).
	if (filters.entity_type) {
		const etRows = await sql`
      SELECT backing_sql, backing_source
      FROM entity_types
      WHERE slug = ${filters.entity_type}
        AND organization_id = ${ctx.organizationId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
		const backingSql = etRows[0]?.backing_sql as string | null | undefined;
		if (backingSql) {
			return listDerivedEntities(
				filters.entity_type,
				backingSql,
				(etRows[0]?.backing_source as string | null | undefined) ?? undefined,
				{ limit, offset, search: filters.search },
				ctx,
			);
		}
	}

	const conditions: string[] = ["{e}.deleted_at IS NULL"];
	const params: unknown[] = [];
	let paramIdx = 1;

	// Organization filter
	conditions.push(`{e}.organization_id = $${paramIdx++}`);
	params.push(ctx.organizationId);

	if (filters.entity_type) {
		conditions.push(`{et}.slug = $${paramIdx++}`);
		params.push(filters.entity_type);
	}

	if (filters.parent_id !== undefined) {
		if (filters.parent_id === null) {
			conditions.push("{e}.parent_id IS NULL");
		} else {
			conditions.push(`{e}.parent_id = $${paramIdx++}`);
			params.push(filters.parent_id);
		}
	}

	if (filters.search) {
		conditions.push(
			`({e}.name ILIKE $${paramIdx} OR {e}.metadata->>'domain' ILIKE $${paramIdx})`,
		);
		params.push(`%${filters.search}%`);
		paramIdx++;
	}

	if (filters.category) {
		conditions.push(`{e}.metadata->>'category' = $${paramIdx++}`);
		params.push(filters.category);
	}

	if (filters.main_market) {
		conditions.push(`{e}.metadata->>'main_market' = $${paramIdx++}`);
		params.push(filters.main_market);
	}

	if (filters.market) {
		conditions.push(`{e}.metadata->>'market' = $${paramIdx++}`);
		params.push(filters.market);
	}

	// Render the shared conditions for a given pair of table aliases. The
	// outer query uses e/et; the page-id prefetch subquery below re-binds the
	// very same $N params to e2/et2 (single statement, single param list).
	const renderWhere = (eAlias: string, etAlias: string) =>
		conditions
			.map((c) =>
				c.replace(/\{e\}\./g, `${eAlias}.`).replace(/\{et\}\./g, `${etAlias}.`),
			)
			.join(" AND ");

	const whereClause = renderWhere("e", "et");

	const sortColumnMap: Record<string, string> = {
		name: "e.name",
		created_at: "e.created_at",
		total_content: "total_content",
		active_connections: "active_connections",
		behaviors_count: "behaviors_count",
		children_count: "children_count",
	};

	const sortBy =
		filters.sort_by && sortColumnMap[filters.sort_by]
			? filters.sort_by
			: "created_at";
	const normalizedSortOrder = filters.sort_order === "asc" ? "asc" : "desc";
	const sortOrderSql = normalizedSortOrder === "asc" ? "ASC" : "DESC";
	const orderBy = `${sortColumnMap[sortBy]} ${sortOrderSql}, e.id ASC`;

	const baseQuery = `
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    LEFT JOIN entities pe ON e.parent_id = pe.id
    LEFT JOIN entity_types pet ON pet.id = pe.entity_type_id
    LEFT JOIN LATERAL (SELECT COUNT(*) as cnt FROM current_event_records ev WHERE ${entityLinkMatchSql('e.id::bigint', 'ev')}) tc ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT c.connector_key) as cnt
      FROM feeds f
      JOIN connections c ON c.id = f.connection_id
      WHERE f.deleted_at IS NULL
        AND c.deleted_at IS NULL
        AND ${feedLinkedToBusinessEntitySql('e.id', 'f', 'c', 'e.organization_id')}
    ) ac ON true
    LEFT JOIN LATERAL (SELECT COUNT(*) as cnt FROM watchers i WHERE e.id = ANY(i.entity_ids)) ic ON true
    LEFT JOIN LATERAL (SELECT COUNT(*) as cnt FROM entities c WHERE c.parent_id = e.id) cc ON true
    WHERE ${whereClause}
  `;

  const totalCountResult = await sql.unsafe<{ total_count: number }>(
    `SELECT CAST(COUNT(*) AS INTEGER) as total_count ${baseQuery}`,
    params
  );

  // Two-stage page fetch. The four per-row count LATERALs make enrichment
  // expensive (~ms..100ms per row), and with ORDER BY + LIMIT the planner
  // still evaluates them for EVERY filter-matching row before the top-N sort
  // picks the page (2,042 market companies ≈ 8s per page load). When sorting
  // by a plain entity column we resolve the page ids first — filters + ORDER
  // BY only, no LATERALs — and enrich just those rows. Sorts by computed
  // columns (total_content, …) need the counts for ordering, so they keep the
  // single-query shape.
  const plainSort = sortBy === 'name' || sortBy === 'created_at';
  const pageIdClause = plainSort
    ? `AND e.id = ANY(ARRAY(
         SELECT e2.id FROM entities e2
         JOIN entity_types et2 ON et2.id = e2.entity_type_id
         WHERE ${renderWhere('e2', 'et2')}
         ORDER BY ${sortColumnMap[sortBy].replace(/^e\./, 'e2.')} ${sortOrderSql}, e2.id ASC
         LIMIT ${limit + 1} OFFSET ${offset}
       ))`
    : '';

  const result = await sql.unsafe<CreatedEntity>(
    `SELECT
      e.id, et.slug AS entity_type, e.name, e.slug, e.parent_id, e.metadata, e.created_at,
      COALESCE(tc.cnt, 0) as total_content,
      COALESCE(ac.cnt, 0) as active_connections,
      COALESCE(ic.cnt, 0) as behaviors_count,
      COALESCE(cc.cnt, 0) as children_count,
      pe.name as parent_name, pe.slug as parent_slug, pet.slug as parent_entity_type
    ${baseQuery}
    ${pageIdClause}
    ORDER BY ${orderBy}
    LIMIT ${limit + 1}
    ${plainSort ? '' : `OFFSET ${offset}`}`,
    params
  );

  const hasMore = result.length > limit;
  const entities = hasMore
    ? (result.slice(0, limit) as unknown as CreatedEntity[])
    : (result as unknown as CreatedEntity[]);

  const totalCount = Number(totalCountResult[0]?.total_count || 0);

  return { entities, hasMore, totalCount, limit, offset, sortBy, sortOrder: normalizedSortOrder };
}

/**
 * Routing key for a derived row: the slug the backing SQL projects, falling
 * back to its `id` column. Both the list and the detail resolver derive the key
 * the same way so a listed row's link always resolves. Empty ⇒ unroutable.
 */
export function derivedRowSlug(row: Record<string, unknown>): string {
  const raw = row.slug ?? row.id;
  return raw != null ? String(raw).trim() : '';
}

/** Display name for a derived row: its name/title column, else the slug. */
export function derivedRowName(row: Record<string, unknown>, slug: string): string {
  const raw = row.name ?? row.title ?? slug;
  return raw != null && String(raw).trim() ? String(raw) : slug;
}

/**
 * List rows of a derived ("view") entity type by running its `backing_sql`
 * through {@link queryDerivedEntityView} (same executor as detail resolve and
 * type-level counts). Maps each row to the standard `CreatedEntity` shape so
 * the frontend treats derived rows like any other entity. Rows have no stored
 * numeric id; the projected `slug` (or `id`) is the routing key, so the
 * synthetic `id` is page-local and used only for table keys. Rows that project
 * no slug/id are unroutable and dropped (they can't link to a detail page).
 */
async function listDerivedEntities(
	entityType: string,
	backingSql: string,
	backingSource: string | undefined,
	page: { limit: number; offset: number; search?: string },
	ctx: ToolContext,
): Promise<{
  entities: CreatedEntity[];
  hasMore: boolean;
  totalCount: number;
  limit: number;
  offset: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
}> {
	const result = await queryDerivedEntityView(
		backingSql,
		backingSource,
		page,
		ctx,
	);
	if (result.error) {
		throw new ToolUserError(
			`Derived view '${entityType}' failed: ${result.error}`,
			400,
		);
	}

	const createdAt = new Date();
	const entities: CreatedEntity[] = [];
	result.rows.forEach((row, index) => {
		const slug = derivedRowSlug(row);
		// Drop unroutable rows: without a slug/id the detail link goes nowhere.
		if (!slug) return;
		entities.push({
			id: page.offset + index + 1,
			entity_type: entityType,
			name: derivedRowName(row, slug),
			slug,
			parent_id: null,
			metadata: row,
			created_at: createdAt,
			total_content: 0,
			active_connections: 0,
			behaviors_count: 0,
			children_count: 0,
		});
	});

	return {
		entities,
		hasMore: result.has_more,
		totalCount: result.total_count,
		limit: page.limit,
		offset: page.offset,
		sortBy: "created_at",
		sortOrder: "desc",
	};
}

// ============================================
// Relationship Batch Loading
// ============================================

export interface RelationshipColumnSpec {
  relationship_type: string;
  direction?: 'outbound' | 'inbound' | 'both';
  label: string;
}

interface RelatedEntityInfo {
  id: number;
  name: string;
  slug: string;
  entity_type: string;
}

export async function batchLoadRelationships(
	entityIds: number[],
	specs: RelationshipColumnSpec[],
	organizationId: string,
): Promise<Map<number, Record<string, RelatedEntityInfo[]>>> {
  const result = new Map<number, Record<string, RelatedEntityInfo[]>>();
  if (entityIds.length === 0 || specs.length === 0) return result;

  const sql = getDb();
  const typeSlugs = pgTextArray([...new Set(specs.map((s) => s.relationship_type))]);
  const idArray = pgBigintArray(entityIds);

  const rows = await sql`
    SELECT
      r.from_entity_id,
      r.to_entity_id,
      rt.slug AS relationship_type_slug,
      fe.id AS from_id, fe.name AS from_name, fe.slug AS from_slug, fet.slug AS from_entity_type,
      te.id AS to_id, te.name AS to_name, te.slug AS to_slug, tet.slug AS to_entity_type
    FROM entity_relationships r
    JOIN entity_relationship_types rt ON r.relationship_type_id = rt.id
    LEFT JOIN entities fe ON r.from_entity_id = fe.id
    LEFT JOIN entity_types fet ON fet.id = fe.entity_type_id
    LEFT JOIN entities te ON r.to_entity_id = te.id
    LEFT JOIN entity_types tet ON tet.id = te.entity_type_id
    WHERE r.organization_id = ${organizationId}
      AND r.deleted_at IS NULL
      AND rt.slug = ANY(${typeSlugs}::text[])
      AND (r.from_entity_id = ANY(${idArray}::bigint[]) OR r.to_entity_id = ANY(${idArray}::bigint[]))
  `;

  // Build a direction lookup per spec
  const specByType = new Map<string, 'outbound' | 'inbound' | 'both'>();
  for (const spec of specs) {
    specByType.set(spec.relationship_type, spec.direction ?? 'both');
  }

  for (const row of rows) {
    const relType = row.relationship_type_slug as string;
    const direction = specByType.get(relType) ?? 'both';
    const fromId = Number(row.from_entity_id);
    const toId = Number(row.to_entity_id);

    const pairs: Array<[number, RelatedEntityInfo]> = [];

    if ((direction === 'outbound' || direction === 'both') && entityIds.includes(fromId)) {
      pairs.push([
        fromId,
        {
          id: Number(row.to_id),
          name: row.to_name as string,
          slug: row.to_slug as string,
          entity_type: row.to_entity_type as string,
        },
      ]);
    }
    if ((direction === 'inbound' || direction === 'both') && entityIds.includes(toId)) {
      pairs.push([
        toId,
        {
          id: Number(row.from_id),
          name: row.from_name as string,
          slug: row.from_slug as string,
          entity_type: row.from_entity_type as string,
        },
      ]);
    }

    for (const [entityId, related] of pairs) {
      let record = result.get(entityId);
      if (!record) {
        record = {};
        result.set(entityId, record);
      }
      if (!record[relType]) record[relType] = [];
      // Deduplicate by related entity id
      if (!record[relType].some((r) => r.id === related.id)) {
        record[relType].push(related);
      }
    }
  }

  return result;
}
