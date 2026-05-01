/**
 * Identity engine.
 *
 * Reads connector-emitted facts and resolves them against catalog entities:
 * 1. Persist each fact as an event row (semantic_type='identity_fact'),
 * superseding the prior fact for the same (sourceAccountId, namespace).
 * 2. Look up entities in each public catalog whose identity-namespace
 * metadata field equals the fact's normalizedValue.
 * 3. Apply each catalog's relationship-type auto_create_when rules,
 * writing entity_relationships with provenance pointing back to the
 * source event. Skip when assurance < required, when match strategy
 * rejects ambiguity, or when the target relationship already exists.
 * 4. On supersede, revoke derivations whose source event is no longer
 * current (status='archived' on the relationship row + valid_to=now).
 *
 * Shadow mode (env IDENTITY_ENGINE_SHADOW=='true'): writes facts but
 * skips derivation/revocation writes. Used to validate behaviour against
 * real users before flipping derivations on.
 */

import { getDb } from "../db/client";
import { insertEvent } from "../utils/insert-event";
import logger from "../utils/logger";
import {
	type AssuranceLevel,
	type AutoCreateWhenRule,
	CLAIM_COLLISION_SEMANTIC_TYPE,
	type ConnectorFact,
	type DerivedFromProvenance,
	IDENTITY_FACT_SEMANTIC_TYPE,
	assuranceMeets,
} from "@lobu/connector-sdk";
import type { EngineOptions, IngestResult } from "./types";
import { validateTypeRule } from "../utils/relationship-validation";
import { connectorCapabilityRegistry } from "./capability-registry";
import { withAccountLock } from "./lock";
import {
	IdentitySchemaError,
	validateClaimCollisionPayload,
	validateConnectorFact,
	validateDerivedRelationshipMetadata,
	validateFactEventMetadata,
	validateRelationshipTypeIdentityMetadata,
} from "./validate";
import { ruleHashFor } from "./rules";

type Sql = ReturnType<typeof getDb>;

/**
 * Stable identity of the connector account driving this ingest. The durable
 * join key is `providerStableId` — the connector's immutable account
 * identifier — which survives email changes and reconnects that produce a
 * fresh BetterAuth account row. `sourceAccountId` is kept for provenance
 * only.
 */
export interface AccountIdentity {
	/** Identifier of the connector implementation (events.connector_key). */
	connectorKey: string;
	/** Provider's immutable account id. The durable join key. */
	providerStableId: string;
	/** BetterAuth account row id; on new rows for the same provider account this differs. */
	sourceAccountId: string;
	/** Optional connection id for richer provenance. */
	connectionId?: number | null;
}

interface IngestParams {
	/** Tenant org these facts are scoped to (where the user's $member lives). */
	tenantOrganizationId: string;
	/** $member entity id in the tenant org for the authenticated user. */
	memberEntityId: number;
	/** Caller user id, used as `created_by` on event rows. */
	userId: string;
	/** Identity of the connector account producing this ingest. */
	accountIdentity: AccountIdentity;
	/**
	 * Set of facts the connector currently emits for this account. An empty
	 * array is interpreted AUTHORITATIVELY: every prior fact for this
	 * (connectorKey, providerStableId) is tombstoned and downstream
	 * derivations revoked. Callers that fail to fetch (network errors,
	 * provider unavailability) MUST NOT call ingestFacts — the engine has
	 * no way to distinguish fetch-failure from legitimate empty.
	 */
	facts: ConnectorFact[];
	/** Per-call shadow override; otherwise read from env. */
	options?: EngineOptions;
}

interface RuleRow {
	relationshipTypeId: number;
	relationshipTypeSlug: string;
	catalogOrganizationId: string;
	rules: AutoCreateWhenRule[];
	ruleVersion: number;
	ruleHash: string;
}

interface PriorFact {
	eventId: number;
	namespace: string;
	normalizedValue: string;
	providerStableId: string;
	assurance: AssuranceLevel;
}

const log = logger.child({ module: "identity-engine" });
const MAX_COLLISION_CANDIDATES = 16;

function isShadow(opts: EngineOptions | undefined): boolean {
	if (typeof opts?.shadow === "boolean") return opts.shadow;
	return process.env.IDENTITY_ENGINE_SHADOW === "true";
}

function originIdForFact(
	accountIdentity: AccountIdentity,
	fact: { namespace: string; normalizedValue: string },
): string {
	// Bind on (connectorKey, providerStableId, namespace, normalizedValue) so
	// a namespace with multiple values produces one fact per value, each with
	// its own supersede chain.
	return `identity_fact:${accountIdentity.connectorKey}:${accountIdentity.providerStableId}:${fact.namespace}:${fact.normalizedValue}`;
}

function priorKey(p: { namespace: string; normalizedValue: string }): string {
	// US (\x1f) delimiter banned by ConnectorFact field charset, so namespace
	// and normalizedValue can never produce the same join as another pair.
	return `${p.namespace}${p.normalizedValue}`;
}

function isSupersedeUniqueViolation(err: unknown): boolean {
	const e = err as {
		code?: unknown;
		constraint?: unknown;
		constraint_name?: unknown;
	};
	if (e?.code !== "23505") return false;
	return (
		e.constraint === "idx_events_superseded_by" ||
		e.constraint_name === "idx_events_superseded_by"
	);
}

function emptyResult(): IngestResult {
	return {
		factEventIds: [],
		supersededEventIds: [],
		derivedRelationshipIds: [],
		revokedRelationshipIds: [],
		collisionEventIds: [],
		skippedRules: [],
	};
}

/**
 * Public-catalog relationship types that declare auto_create_when rules.
 * Read once per ingest pass; small N (one row per relationship type that
 * opts into the engine).
 */
async function loadRules(sql: Sql): Promise<RuleRow[]> {
	const rows = await sql<{
		id: number;
		slug: string;
		organization_id: string;
		metadata: unknown;
	}>`
    SELECT rt.id, rt.slug, rt.organization_id, rt.metadata
    FROM entity_relationship_types rt
    JOIN organization o ON o.id = rt.organization_id
    WHERE rt.deleted_at IS NULL
      AND rt.status = 'active'
      AND o.visibility = 'public'
      AND rt.metadata ? 'autoCreateWhen'
  `;
	const out: RuleRow[] = [];
	for (const row of rows) {
		// Validate every metadata blob and reject rules whose stored ruleHash
		// disagrees with a fresh hash of their canonicalised rule set — that
		// means the YAML→DB seeder lost integrity and the engine must not act on
		// the rule until reseeded.
		try {
			validateRelationshipTypeIdentityMetadata(row.metadata);
		} catch (err) {
			log.warn(
				{ relationshipTypeId: row.id, err },
				"identity-engine: relationship type metadata failed schema validation; skipping rule",
			);
			continue;
		}
		const meta = row.metadata as {
			autoCreateWhen: AutoCreateWhenRule[];
			ruleVersion: number;
			ruleHash: string;
		};
		const expectedHash = ruleHashFor(meta.autoCreateWhen);
		if (expectedHash !== meta.ruleHash) {
			log.warn(
				{ relationshipTypeId: row.id, expectedHash, storedHash: meta.ruleHash },
				"identity-engine: relationship type ruleHash drift; skipping rule until reseeded",
			);
			continue;
		}
		out.push({
			relationshipTypeId: Number(row.id),
			relationshipTypeSlug: String(row.slug),
			catalogOrganizationId: String(row.organization_id),
			rules: meta.autoCreateWhen,
			ruleVersion: meta.ruleVersion,
			ruleHash: meta.ruleHash,
		});
	}
	return out;
}

async function loadPriorFacts(
	sql: Sql,
	accountIdentity: AccountIdentity,
): Promise<PriorFact[]> {
	// Diff on (connectorKey, providerStableId), not sourceAccountId, so facts
	// chain across BetterAuth account-row reissues on reconnect.
	//
	// Exclude tombstone rows (empty normalizedValue / identifier). Tombstones
	// are emitted when a namespace drops out of a refresh; if we counted them
	// as priors, every subsequent empty refresh would write a fresh tombstone
	// superseding the last one, chaining indefinitely.
	const rows = await sql<{
		id: number;
		metadata: {
			namespace?: string;
			normalizedValue?: string;
			assurance?: string;
		};
	}>`
    SELECT e.id, e.metadata
    FROM current_event_records e
    WHERE e.semantic_type = ${IDENTITY_FACT_SEMANTIC_TYPE}
      AND e.connector_key = ${accountIdentity.connectorKey}
      AND e.metadata->>'providerStableId' = ${accountIdentity.providerStableId}
      AND COALESCE(e.metadata->>'normalizedValue', '') <> ''
  `;
	return rows.map((r) => ({
		eventId: Number(r.id),
		namespace: String(r.metadata?.namespace ?? ""),
		normalizedValue: String(r.metadata?.normalizedValue ?? ""),
		providerStableId: accountIdentity.providerStableId,
		assurance: (r.metadata?.assurance ?? "self_attested") as AssuranceLevel,
	}));
}

interface MatchedEntity {
	entityId: number;
	organizationId: string;
}

/**
 * Only fields declared on an entity-type's metadata-schema with
 * `x-identity-namespace: true` are allowed as rule targets. Without this,
 * a malicious or careless rule could match on any JSONB field (e.g.
 * `internal_notes`, `system_secret`) and derive against wrong evidence.
 *
 * Cached per process lifetime. The seeder bumps `ruleVersion` when YAML
 * changes; the engine notices via ruleHash drift — cache invalidation is
 * opportunistic.
 */
interface IdentityFieldCacheEntry {
	allowed: Set<string>;
	expiresAt: number;
}

const identityFieldCache = new Map<string, IdentityFieldCacheEntry>();

/**
 * Default TTL for the per-org identity-field cache. Schema changes
 * (`x-identity-namespace` toggled on/off in YAML) propagate to all
 * running engines within this window without an explicit reseed broadcast.
 * Override per-call via `IDENTITY_FIELD_CACHE_TTL_MS`.
 */
const IDENTITY_FIELD_CACHE_TTL_MS = (() => {
	const raw = Number(process.env.IDENTITY_FIELD_CACHE_TTL_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
})();

/**
 * Drop the in-memory cache. Tests use this to refresh after declaring new
 * identity fields; production callers can use it after a known schema
 * reseed if they don't want to wait out the TTL.
 */
export function clearIdentityFieldCache(): void {
	identityFieldCache.clear();
}

async function loadIdentityFields(
	sql: Sql,
	organizationId: string,
): Promise<Set<string>> {
	const cached = identityFieldCache.get(organizationId);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.allowed;
	}
	const rows = await sql<{ slug: string; metadata_schema: unknown }>`
    SELECT slug, metadata_schema
    FROM entity_types
    WHERE organization_id = ${organizationId}
      AND deleted_at IS NULL
      AND metadata_schema IS NOT NULL
  `;
	const allowed = new Set<string>();
	for (const row of rows) {
		const schema = row.metadata_schema as
			| {
					properties?: Record<
						string,
						{ "x-identity-namespace"?: boolean | Record<string, unknown> }
					>;
				}
			| null
			| undefined;
		if (!schema || typeof schema !== "object" || !schema.properties) continue;
		for (const [field, def] of Object.entries(schema.properties)) {
			if (!def || typeof def !== "object") continue;
			const marker = def["x-identity-namespace"];
			if (marker === true || (marker && typeof marker === "object")) {
				allowed.add(field);
			}
		}
	}
	identityFieldCache.set(organizationId, {
		allowed,
		expiresAt: Date.now() + IDENTITY_FIELD_CACHE_TTL_MS,
	});
	return allowed;
}

async function findEntitiesByMetadataField(
	sql: Sql,
	catalogOrgId: string,
	field: string,
	normalizedValue: string,
): Promise<MatchedEntity[]> {
	const allowed = await loadIdentityFields(sql, catalogOrgId);
	if (!allowed.has(field)) {
		log.warn(
			{ catalogOrgId, field },
			"identity-engine: targetField is not declared x-identity-namespace; skipping match",
		);
		return [];
	}
	const rows = await sql<{ id: number; organization_id: string }>`
    SELECT e.id, e.organization_id
    FROM entities e
    WHERE e.organization_id = ${catalogOrgId}
      AND e.deleted_at IS NULL
      AND e.metadata->>${field} = ${normalizedValue}
  `;
	return rows.map((r) => ({
		entityId: Number(r.id),
		organizationId: r.organization_id,
	}));
}

async function findExistingRelationship(
	sql: Sql,
	fromEntityId: number,
	toEntityId: number,
	relationshipTypeId: number,
): Promise<number | null> {
	const rows = await sql<{ id: number }>`
    SELECT id FROM entity_relationships
    WHERE from_entity_id = ${fromEntityId}
      AND to_entity_id = ${toEntityId}
      AND relationship_type_id = ${relationshipTypeId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
	return rows.length > 0 ? Number(rows[0].id) : null;
}

async function insertDerivation(
	sql: Sql,
	fromEntityId: number,
	toEntityId: number,
	relationshipTypeId: number,
	organizationId: string,
	userId: string,
	provenance: DerivedFromProvenance,
): Promise<number | null> {
	// Validating the wrapper recursively validates `provenance` too, so there
	// is no separate inner-only validator call.
	const metadata = { derivedFrom: provenance };
	validateDerivedRelationshipMetadata(metadata);
	// Defense in depth: loadRules already filters to active public-catalog
	// types, but a soft-deleted type rule, a YAML→DB mismatch, or a stale
	// rule version could otherwise let the engine derive a relationship that
	// the manual `manage_entity` API would reject.
	await validateTypeRule(relationshipTypeId, fromEntityId, toEntityId, sql);
	// Idempotent insert: ON CONFLICT covers the partial unique index when
	// two writers escape the in-process lock (e.g. multiple replicas).
	const rows = await sql<{ id: number }>`
    INSERT INTO entity_relationships (
      from_entity_id, to_entity_id, relationship_type_id, organization_id,
      metadata, created_by, updated_by
    ) VALUES (
      ${fromEntityId}, ${toEntityId}, ${relationshipTypeId}, ${organizationId},
      ${sql.json(metadata)}, ${userId}, ${userId}
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
	if (rows.length === 0) return null;
	return Number(rows[0].id);
}

async function revokeDerivationsForEvent(
	sql: Sql,
	eventId: number,
	userId: string,
): Promise<number[]> {
	const rows = await sql<{ id: number }>`
    UPDATE entity_relationships
    SET deleted_at = NOW(),
        updated_at = NOW(),
        updated_by = ${userId}
    WHERE deleted_at IS NULL
      AND metadata ? 'derivedFrom'
      AND metadata->'derivedFrom'->>'sourceEventId' = ${String(eventId)}
    RETURNING id
  `;
	return rows.map((r) => Number(r.id));
}

async function recordCollision(
	sql: Sql,
	tenantOrgId: string,
	factEventId: number,
	candidateMemberIds: number[],
	fact: ConnectorFact,
	accountIdentity: AccountIdentity,
	relationshipTypeId: number,
	userId: string,
): Promise<number | null> {
	const candidateEntityIds = candidateMemberIds.slice(
		0,
		MAX_COLLISION_CANDIDATES,
	);
	const payload = {
		kind: "identity_match" as const,
		namespace: fact.namespace,
		identifier: fact.identifier,
		normalizedValue: fact.normalizedValue,
		candidateEntityIds,
		candidateCount: candidateMemberIds.length,
		triggeringEventId: factEventId,
		relationshipTypeId,
	};
	validateClaimCollisionPayload(payload);
	// Key on (connectorKey, providerStableId), not the BetterAuth account row
	// id, which can be re-issued on reconnect — otherwise a reconnect produces
	// duplicate pending-approval events for the same underlying collision.
	const originId = `claim_collision:${accountIdentity.connectorKey}:${accountIdentity.providerStableId}:${fact.namespace}:${fact.normalizedValue}`;
	const existing = await sql<{ id: number }>`
    SELECT id
    FROM current_event_records
    WHERE organization_id = ${tenantOrgId}
      AND origin_id = ${originId}
      AND semantic_type = ${CLAIM_COLLISION_SEMANTIC_TYPE}
      AND interaction_type = 'approval'
      AND interaction_status = 'pending'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;
	if (existing.length > 0) return Number(existing[0].id);

	const ev = await insertEvent(
		{
			organizationId: tenantOrgId,
			entityIds: candidateEntityIds,
			originId,
			semanticType: CLAIM_COLLISION_SEMANTIC_TYPE,
			interactionType: "approval",
			interactionStatus: "pending",
			metadata: payload,
			title: `Identity match collision on ${fact.namespace}`,
			payloadType: "text",
			content: `Two or more candidate $member rows match this provider-verified ${fact.namespace}; manual resolution required.`,
			createdBy: userId,
		},
		{ sql },
	);
	return ev?.id ?? null;
}

/**
 * Main entry: ingest a fresh batch of facts for one connector account.
 * Idempotent — safe to call repeatedly with the same input; superseded
 * events stay in history.
 *
 * IMPORTANT: passing `facts: []` is AUTHORITATIVE — every prior fact for
 * `(connectorKey, providerStableId)` is tombstoned. Callers that fail to
 * fetch facts (network errors, provider unavailability) MUST NOT call
 * ingestFacts.
 */
export async function ingestFacts(params: IngestParams): Promise<IngestResult> {
	// Serialise concurrent passes for the same (connectorKey, providerStableId)
	// so simultaneous sign-ins / refreshes can't lost-update each other.
	return withAccountLock(
		params.accountIdentity.connectorKey,
		params.accountIdentity.providerStableId,
		() => ingestFactsLocked(params),
	);
}

async function ingestFactsLocked(params: IngestParams): Promise<IngestResult> {
	const {
		tenantOrganizationId,
		memberEntityId,
		userId,
		accountIdentity,
		facts,
	} = params;
	const shadow = isShadow(params.options);

	// 1. Validate every fact up front. All-or-nothing — we do not partially
	// ingest, since a partial write could leave derivations dangling.
	const seenFactKeys = new Set<string>();
	for (const fact of facts) {
		try {
			validateConnectorFact(fact);
		} catch (err) {
			if (err instanceof IdentitySchemaError) {
				log.error(
					{
						err,
						namespace: fact?.namespace,
						connectorKey: accountIdentity.connectorKey,
					},
					"identity-engine: rejecting batch due to invalid fact",
				);
			}
			throw err;
		}
		// Identity coherence: facts in a batch must all belong to the same
		// provider account (matches AccountIdentity).
		if (fact.providerStableId !== accountIdentity.providerStableId) {
			throw new Error(
				`identity-engine: fact.providerStableId mismatches accountIdentity (got ${fact.providerStableId}, expected ${accountIdentity.providerStableId})`,
			);
		}
		if (fact.sourceAccountId !== accountIdentity.sourceAccountId) {
			throw new Error(
				`identity-engine: fact.sourceAccountId mismatches accountIdentity (got ${fact.sourceAccountId}, expected ${accountIdentity.sourceAccountId})`,
			);
		}
		const key = priorKey(fact);
		if (seenFactKeys.has(key)) {
			throw new Error(
				`identity-engine: duplicate fact in batch for namespace/value ${fact.namespace}/${fact.normalizedValue}`,
			);
		}
		seenFactKeys.add(key);
		// server-side capability cap: a connector may only emit
		// (namespace, assurance) pairs it declared in its capability. Anything
		// outside the declared cap is rejected before any side effect.
		const cap = connectorCapabilityRegistry.maxAssurance(
			accountIdentity.connectorKey,
			fact.namespace,
		);
		if (!cap) {
			throw new Error(
				`identity-engine: connector ${accountIdentity.connectorKey} has no registered capability for namespace ${fact.namespace}`,
			);
		}
		if (!assuranceMeets(cap, fact.assurance)) {
			throw new Error(
				`identity-engine: connector ${accountIdentity.connectorKey} cannot emit ${fact.assurance} for namespace ${fact.namespace} (capped at ${cap})`,
			);
		}
	}

	const result: IngestResult = emptyResult();

	// Wrap every write in a single transaction so a partial-batch failure
	// rolls back facts AND derivations together — never leaves derivations
	// pointing at events that no longer exist. A 23505 on
	// `idx_events_superseded_by` means another replica already wrote this
	// supersede; we treat the whole call as an idempotent no-op.
	try {
		return await getDb().begin(async (sql) => {
			// Index prior facts by (namespace, normalizedValue) so multi-value
			// namespaces are diffed independently.
			const priorFacts = await loadPriorFacts(sql, accountIdentity);
			const priorByKey = new Map<string, PriorFact>();
			for (const pf of priorFacts) {
				priorByKey.set(priorKey(pf), pf);
			}

			// 2. Persist each incoming fact, superseding the prior fact for the
			// matching (namespace, normalizedValue) tuple when one exists.
			const incomingByNamespaceValue = new Map<
				string,
				{ eventId: number; fact: ConnectorFact }
			>();
			for (const fact of facts) {
				const factMetadata = {
					namespace: fact.namespace,
					identifier: fact.identifier,
					normalizedValue: fact.normalizedValue,
					assurance: fact.assurance,
					providerStableId: fact.providerStableId,
					sourceAccountId: fact.sourceAccountId,
					validTo: fact.validTo,
					notes: fact.notes,
				};
				validateFactEventMetadata(factMetadata);

				const key = priorKey(fact);
				const supersedes = priorByKey.get(key)?.eventId ?? null;

				const inserted = await insertEvent(
					{
						organizationId: tenantOrganizationId,
						entityIds: [memberEntityId],
						originId: originIdForFact(accountIdentity, fact),
						semanticType: IDENTITY_FACT_SEMANTIC_TYPE,
						payloadType: "empty",
						metadata: factMetadata,
						connectorKey: accountIdentity.connectorKey,
						connectionId: accountIdentity.connectionId ?? null,
						supersedesEventId: supersedes,
						occurredAt: new Date(),
						createdBy: userId,
					},
					{ sql },
				);
				if (!inserted) {
					log.warn(
						{
							namespace: fact.namespace,
							providerStableId: accountIdentity.providerStableId,
						},
						"identity-engine: insertEvent returned null; skipping fact",
					);
					continue;
				}
				result.factEventIds.push(inserted.id);
				incomingByNamespaceValue.set(key, { eventId: inserted.id, fact });
				if (supersedes !== null) {
					result.supersededEventIds.push(supersedes);
				}
			}

			// 3. Diff prior vs current. Every prior (namespace, normalizedValue) the
			// connector no longer emits is tombstoned and its derivations revoked.
			// This is what makes empty-input authoritative and supports
			// multi-value namespaces correctly.
			for (const [key, pf] of priorByKey.entries()) {
				if (incomingByNamespaceValue.has(key)) continue;
				const tombstoneMeta = {
					namespace: pf.namespace,
					identifier: "",
					normalizedValue: "",
					assurance: "self_attested" as const,
					providerStableId: accountIdentity.providerStableId,
					sourceAccountId: accountIdentity.sourceAccountId,
					notes: "superseded by absence on connector refresh",
				};
				validateFactEventMetadata(tombstoneMeta);
				const tombstone = await insertEvent(
					{
						organizationId: tenantOrganizationId,
						entityIds: [memberEntityId],
						originId: `identity_fact_tombstone:${accountIdentity.connectorKey}:${accountIdentity.providerStableId}:${pf.namespace}:${pf.normalizedValue}`,
						semanticType: IDENTITY_FACT_SEMANTIC_TYPE,
						payloadType: "empty",
						metadata: tombstoneMeta,
						connectorKey: accountIdentity.connectorKey,
						connectionId: accountIdentity.connectionId ?? null,
						supersedesEventId: pf.eventId,
						occurredAt: new Date(),
						createdBy: userId,
					},
					{ sql },
				);
				if (tombstone) {
					result.factEventIds.push(tombstone.id);
					result.supersededEventIds.push(pf.eventId);
				}
			}

			if (shadow) {
				log.info(
					{
						factCount: facts.length,
						factEventIds: result.factEventIds.length,
						connectorKey: accountIdentity.connectorKey,
						providerStableId: accountIdentity.providerStableId,
					},
					"identity-engine: shadow mode — skipped derivation/revocation pass",
				);
				return result;
			}

			// 4. Revoke derivations referencing any superseded fact event.
			for (const supersededId of result.supersededEventIds) {
				const revoked = await revokeDerivationsForEvent(
					sql,
					supersededId,
					userId,
				);
				if (revoked.length > 0) {
					result.revokedRelationshipIds.push(...revoked);
					log.info(
						{ supersededEventId: supersededId, revokedCount: revoked.length },
						"identity-engine: revoked derivations for superseded fact",
					);
				}
			}

			// 5. Apply auto_create_when rules against each just-written fact.
			const rules = await loadRules(sql);
			for (const fact of facts) {
				const ev = incomingByNamespaceValue.get(priorKey(fact));
				if (!ev) continue;
				for (const ruleSet of rules) {
					for (const rule of ruleSet.rules) {
						if (rule.sourceNamespace !== fact.namespace) continue;
						if (!assuranceMeets(fact.assurance, rule.assuranceRequired)) {
							result.skippedRules.push({
								ruleId: `${ruleSet.relationshipTypeSlug}@${ruleSet.ruleVersion}`,
								reason: `assurance ${fact.assurance} below required ${rule.assuranceRequired}`,
							});
							continue;
						}
						// expired facts must not derive. validTo is optional on
						// the connector input; when present and in the past, skip.
						if (fact.validTo) {
							const expiresAt = Date.parse(fact.validTo);
							if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
								result.skippedRules.push({
									ruleId: `${ruleSet.relationshipTypeSlug}@${ruleSet.ruleVersion}`,
									reason: `fact validTo ${fact.validTo} is in the past`,
								});
								continue;
							}
						}

						const matches = await findEntitiesByMetadataField(
							sql,
							ruleSet.catalogOrganizationId,
							rule.targetField,
							fact.normalizedValue,
						);

						if (matches.length === 0) continue;

						const validMatches: MatchedEntity[] = [];
						for (const match of matches) {
							try {
								await validateTypeRule(
									ruleSet.relationshipTypeId,
									memberEntityId,
									match.entityId,
									sql,
								);
								validMatches.push(match);
							} catch (err) {
								log.debug(
									{
										err,
										relationshipTypeId: ruleSet.relationshipTypeId,
										fromEntityId: memberEntityId,
										toEntityId: match.entityId,
									},
									"identity-engine: metadata match rejected by type-rule prefilter",
								);
							}
						}
						if (validMatches.length === 0) continue;

						if (validMatches.length > 1 && rule.matchStrategy === "unique_only") {
							// Surface as a collision event for admin / user resolution.
							const collisionId = await recordCollision(
								sql,
								tenantOrganizationId,
								ev.eventId,
								validMatches.map((m) => m.entityId),
								fact,
								accountIdentity,
								ruleSet.relationshipTypeId,
								userId,
							);
							if (collisionId !== null)
								result.collisionEventIds.push(collisionId);
							result.skippedRules.push({
								ruleId: `${ruleSet.relationshipTypeSlug}@${ruleSet.ruleVersion}`,
								reason: `${validMatches.length} valid matches with match_strategy=unique_only`,
							});
							continue;
						}

						// unique_only with one match, or all_matches with N → derive each.
						// (first_match is rejected at the schema layer in @lobu/connector-sdk.)
						const targets =
							rule.matchStrategy === "unique_only" ? [validMatches[0]] : validMatches;
						for (const target of targets) {
							const existing = await findExistingRelationship(
								sql,
								memberEntityId,
								target.entityId,
								ruleSet.relationshipTypeId,
							);
							if (existing !== null) {
								// Already derived — idempotent skip.
								continue;
							}
							const provenance: DerivedFromProvenance = {
								sourceEventId: ev.eventId,
								relationshipTypeId: ruleSet.relationshipTypeId,
								ruleVersion: ruleSet.ruleVersion,
								ruleHash: ruleSet.ruleHash,
								factAssurance: fact.assurance,
								derivedAt: new Date().toISOString(),
							};
							// Relationship's organization_id matches the SOURCE entity's org
							// per the cross-org guard (AGENTS.md): tenant→public references
							// are stored in the tenant org. Reads filter by source org +
							// public-catalog target visibility, so the row is reachable from
							// both ends.
							let relId: number | null = null;
							try {
								relId = await insertDerivation(
									sql,
									memberEntityId,
									target.entityId,
									ruleSet.relationshipTypeId,
									tenantOrganizationId,
									userId,
									provenance,
								);
							} catch (err) {
								// type-rule validation failure on a single (rule, target)
								// shouldn't abort the whole batch; record the skip and move on.
								log.warn(
									{
										err,
										relationshipTypeId: ruleSet.relationshipTypeId,
										fromEntityId: memberEntityId,
										toEntityId: target.entityId,
									},
									"identity-engine: derivation rejected by type-rule validation; skipping",
								);
								result.skippedRules.push({
									ruleId: `${ruleSet.relationshipTypeSlug}@${ruleSet.ruleVersion}`,
									reason: `type-rule rejected ${memberEntityId}→${target.entityId}: ${(err as Error).message}`,
								});
							}
							if (relId !== null) {
								result.derivedRelationshipIds.push(relId);
							}
						}
					}
				}
			}

			log.info(
				{
					connectorKey: accountIdentity.connectorKey,
					providerStableId: accountIdentity.providerStableId,
					facts: result.factEventIds.length,
					superseded: result.supersededEventIds.length,
					derived: result.derivedRelationshipIds.length,
					revoked: result.revokedRelationshipIds.length,
					collisions: result.collisionEventIds.length,
					skipped: result.skippedRules.length,
				},
				"identity-engine: ingest complete",
			);
			return result;
		});
	} catch (err) {
		if (isSupersedeUniqueViolation(err)) {
			log.info(
				{
					connectorKey: accountIdentity.connectorKey,
					providerStableId: accountIdentity.providerStableId,
				},
				"identity-engine: lost supersede race; another writer won, treating as success",
			);
			return emptyResult();
		}
		throw err;
	}
}
