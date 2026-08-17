/**
 * Eval cases (evals PR 3, lobu#2564).
 *
 * A case is a real Automation run somebody decided is worth asking again.
 * Promoting one freezes that judgement as a `$eval_case` entity so the case set
 * is a reviewable thing in the workspace — diffable, commentable, owned by a
 * person — rather than a list of run ids in someone's notes.
 *
 * A case stores a POINTER, never a copy. `runs.approved_input` on the source
 * run is already the frozen dispatch payload and `createEvalRun` copies it
 * verbatim at replay time; duplicating it onto the case would create a second
 * copy free to drift from the run it claims to replay, and a case that no
 * longer matches its source is worse than no case. What the case adds is the
 * part no `runs` row carries: `expectation`, the human statement of what a good
 * answer looks like.
 *
 * `expectation` has NO consumer yet — PR 4's judge is what reads it. It is
 * captured now because it has to be written while the person still remembers
 * why the run mattered; recovering it later from a run id is guesswork.
 *
 * Identity is the (source run, case key) pair, claimed in `entity_identities`
 * under the `eval_case` namespace. The partial unique index
 * `idx_entity_identities_live_unique (organization_id, namespace, identifier,
 * COALESCE(scope_connection_id, 0))
 * WHERE deleted_at IS NULL` is the multi-replica lock, so two operators
 * promoting the same run concurrently resolve to one case rather than two.
 */

import { type DbClient, getDb } from "../db/client.js";
import { EVAL_CASE_ENTITY_TYPE_SLUG } from "../tools/constants.js";
import {
	hardDeleteEntityRows,
	patchEntityRows,
	tryInsertEntityRow,
	withEntityWriteTransaction,
} from "../utils/entity-management.js";
import logger from "../utils/logger.js";
import { resolveEntityCreator } from "../utils/resolve-entity-creator.js";
import {
	createEvalRun,
	type CreateEvalRunResult,
	loadReplayableSource,
	type ReplaySourceRejection,
} from "./eval-runs.js";
import { AUTOMATION_EVAL_RUN_TYPE } from "./run-types.js";

/** Namespace for the (source run, case key) identity claim in `entity_identities`. */
export const EVAL_CASE_NAMESPACE = "eval_case";

/**
 * The ONE definition of how a trial number rides on a case key, minted and
 * parsed by the two functions below.
 *
 * `createEvalRun` dedups on `(sourceRunId, caseKey)`, which is exactly right for
 * a single replay and exactly wrong for N trials: running the same case five
 * times would collapse into one run and report a single measurement as if it
 * were five. Trials therefore carry a distinct key.
 *
 * Trial 0 keeps the bare key so a plain `replayEvalCase` and trial 0 of a suite
 * run are the same work item rather than two — and so every case promoted
 * before trials existed keeps resolving.
 *
 * Never re-implement this split anywhere else. `findCaseForRun` recovers the
 * case by calling `evalCaseIdentifierFromRunKey`, and a second copy of the rule
 * that drifted would silently strand every score unanchored.
 */
export function trialCaseKey(caseKey: string, trial: number): string {
	return trial === 0 ? caseKey : `${caseKey}#t${trial}`;
}

/**
 * The exact suffix `trialCaseKey` mints, anchored to the end.
 *
 * Anchored and shape-checked rather than "everything after the last `#`":
 * `caseKey` is caller-supplied free text, so a case promoted as `weekly#draft`
 * would otherwise have its own key truncated to `weekly` and every one of its
 * scores would resolve to a case that does not exist — silently, with an empty
 * suite and no error anywhere.
 */
const TRIAL_SUFFIX_RE = /#t\d+$/;

/**
 * Recover the `entity_identities` identifier for the case a run belongs to.
 *
 * `createEvalRun` stamps `idempotency_key = 'automation_eval:<sourceRunId>:<caseKey>'`
 * and `promoteEvalCase` claims identifier `'<sourceRunId>:<caseKey>'`. The
 * suffix of the one IS the other, which is why neither needed a join column.
 * Trials append `#t<n>`, stripped here so every trial resolves to its case.
 */
export function evalCaseIdentifierFromRunKey(
	idempotencyKey: string | null,
): string | null {
	const prefix = `${AUTOMATION_EVAL_RUN_TYPE}:`;
	if (!idempotencyKey?.startsWith(prefix)) return null;
	const identifier = idempotencyKey.slice(prefix.length);
	if (!identifier) return null;
	return identifier.replace(TRIAL_SUFFIX_RE, "");
}

/**
 * Declared shape of `$eval_case` metadata.
 *
 * `readOnly` on the pointer fields is a HINT to whatever renders the entity —
 * nothing server-side enforces it, and no write path here consults it. It says
 * what editing them would mean: repointing a case at a different question while
 * keeping its comments and history. Promote a new case instead. `recent_scores`
 * carries the same hint for a different reason: the scorer owns it, and a hand
 * edit would be overwritten by the next run.
 *
 * Every key any write path sets is declared here, `judge_model` and
 * `recent_scores` included — an undeclared key is one a generic entity editor
 * would have no reason to preserve.
 */
const EVAL_CASE_METADATA_SCHEMA = {
	type: "object",
	properties: {
		source_run_id: {
			type: "integer",
			description: "Automation run this case replays",
			readOnly: true,
			"x-table-column": true,
		},
		automation_id: {
			type: "integer",
			description: "Automation",
			readOnly: true,
			"x-table-column": true,
		},
		case_key: {
			type: "string",
			description: "Distinguishes several cases promoted from one run",
			readOnly: true,
		},
		expectation: {
			type: "string",
			description: "What a good answer to this case looks like",
		},
		status: {
			enum: ["active", "retired"],
			type: "string",
			description: "Status",
			"x-table-column": true,
		},
		judge_model: {
			type: "string",
			description:
				"Model that grades this case, as '<provider-slug>/<model>'. Name one DIFFERENT from the model under eval. Empty = the org default.",
		},
		recent_scores: {
			type: "array",
			description:
				"Rolling window of this case's recent run scores, newest first. Written by the scorer.",
			readOnly: true,
		},
	},
} as const;

export interface EvalCase {
	entityId: number;
	organizationId: string;
	sourceRunId: number;
	automationId: number;
	caseKey: string;
}

export type PromoteEvalCaseResult =
	| { ok: true; evalCase: EvalCase; created: boolean }
	| {
			ok: false;
			reason:
				| ReplaySourceRejection
				| "no_attributable_member"
				| "slug_unavailable";
	  };

interface PromoteEvalCaseParams {
	sourceRunId: number;
	caseKey: string;
	expectation?: string | null;
	/** Who is promoting. Falls back to an org owner/admin when absent. */
	createdBy?: string | null;
	/**
	 * Org the caller is authenticated for. Required by every request-path
	 * caller: the org is resolved from the RUN, so without this a caller who
	 * knows (or guesses) a run id creates an `$eval_case` entity — and an
	 * `$eval_case` entity TYPE — inside another tenant's workspace. Checking
	 * after the fact does not help; by then the row exists.
	 */
	organizationId?: string;
}

/**
 * Promote a real Automation run into a reusable eval case.
 *
 * Validates with the SAME predicate the replay path uses
 * (`loadReplayableSource`), so a promoted case is always one that can actually
 * run. Promoting a case that would later fail at replay produces a case set
 * that looks healthy and silently measures nothing.
 *
 * Idempotent per (sourceRunId, caseKey): a repeat promote resolves to the
 * existing case rather than minting a second entity for the same question.
 */
export async function promoteEvalCase(
	params: PromoteEvalCaseParams,
	db?: DbClient,
): Promise<PromoteEvalCaseResult> {
	const sql = db ?? getDb();
	return withEntityWriteTransaction(sql, (tx) =>
		promoteEvalCaseInTransaction(params, tx),
	);
}

async function promoteEvalCaseInTransaction(
	params: PromoteEvalCaseParams,
	sql: DbClient,
): Promise<PromoteEvalCaseResult> {
	const caseKey = params.caseKey.trim() || "default";

	const loaded = await loadReplayableSource(params.sourceRunId, sql);
	if (!loaded.ok) return { ok: false, reason: loaded.reason };
	const source = loaded.source;
	// Indistinguishable from "no such run" on purpose — a cross-tenant caller
	// must not learn that the id exists.
	if (params.organizationId && params.organizationId !== source.organizationId) {
		return { ok: false, reason: "not_found" };
	}
	const identifier = `${source.sourceRunId}:${caseKey}`;

	// Existing claim → reuse (idempotent fast path, and the common case when a
	// promote is retried after a transient failure).
	const existing = await findEvalCaseByIdentifier(
		sql,
		source.organizationId,
		identifier,
	);
	if (existing) return { ok: true, evalCase: existing, created: false };

	const createdBy = await resolveEntityCreator(
		sql,
		source.organizationId,
		params.createdBy,
	);
	if (!createdBy) {
		// entities.created_by is NOT NULL behind ON DELETE RESTRICT.
		logger.warn(
			{ sourceRunId: source.sourceRunId, organizationId: source.organizationId },
			"[evals] no live member to attribute the eval case to — not promoting",
		);
		return { ok: false, reason: "no_attributable_member" };
	}

	const entityTypeRows = (await sql`
    INSERT INTO entity_types (
      slug, name, description, icon, metadata_schema,
      organization_id, created_at, updated_at
    )
    VALUES (
      ${EVAL_CASE_ENTITY_TYPE_SLUG}, 'Eval case',
      'An Automation run promoted into a reusable evaluation case', 'flask-conical',
      ${sql.json(EVAL_CASE_METADATA_SCHEMA as never)},
      ${source.organizationId}, current_timestamp, current_timestamp
    )
    ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
    DO UPDATE SET updated_at = entity_types.updated_at
    RETURNING id
  `) as unknown as Array<{ id: number | string }>;
	// `ON CONFLICT … DO UPDATE … RETURNING` always yields the row, new or existing.
	const entityTypeId = Number(entityTypeRows[0].id);

	const placed = await insertCaseEntity({
		sql,
		organizationId: source.organizationId,
		entityTypeId,
		createdBy,
		name: `Eval case · run ${source.sourceRunId} · ${caseKey}`,
		baseSlug: `eval-case-${source.sourceRunId}-${slugifyCaseKey(caseKey)}`,
		sourceRunId: source.sourceRunId,
		caseKey,
		metadata: {
			source_run_id: source.sourceRunId,
			automation_id: source.automationId,
			case_key: caseKey,
			expectation: params.expectation?.trim() || null,
			status: "active",
		},
	});

	if (placed == null) {
		logger.warn(
			{ sourceRunId: source.sourceRunId, caseKey },
			"[evals] every candidate slug is held by a different case — not promoting",
		);
		return { ok: false, reason: "slug_unavailable" };
	}

	const entityId = placed.entityId;
	await claimEvalCaseIdentity(sql, source.organizationId, identifier, entityId);

	// A racing replica may have won the claim with ITS entity. Whoever the claim
	// resolves to is the case; re-read rather than trusting the local insert.
	const winner = await findEvalCaseByIdentifier(
		sql,
		source.organizationId,
		identifier,
	);
	if (winner && winner.entityId !== entityId) {
		logger.info(
			{ lostEntityId: entityId, wonEntityId: winner.entityId, identifier },
			"[evals] lost the eval-case identity race — reusing the winner",
		);
		// Discard only a row THIS transaction inserted. `created: false` means
		// `insertCaseEntity` adopted a pre-existing row for the same (run, key);
		// deleting that would destroy a case this call never wrote.
		if (placed.created) {
			await hardDeleteEntityRows({ tx: sql, ids: [entityId] });
		}
		return { ok: true, evalCase: winner, created: false };
	}

	if (placed.created) {
		logger.info(
			{
				entityId,
				sourceRunId: source.sourceRunId,
				automationId: source.automationId,
				caseKey,
			},
			"[evals] Promoted an Automation run into an eval case",
		);
	}
	return {
		ok: true,
		evalCase: {
			entityId,
			organizationId: source.organizationId,
			sourceRunId: source.sourceRunId,
			automationId: source.automationId,
			caseKey,
		},
		created: placed.created,
	};
}

/**
 * Set a case's judge-model override.
 *
 * Deliberately a `<slug>/<model>` ref resolved by `resolveCompletionTarget`,
 * the same shape a guardrail entry's `model` already uses — the platform
 * already has this knob, so evals reuse it rather than inventing an env var or
 * a settings table. Naming a model DIFFERENT from the one under eval is how a
 * caller avoids a model grading its own output generously.
 *
 * Org-scoped: `entities.id` alone would let one tenant repoint another's case.
 */
export async function setEvalCaseJudgeModel(
	entityId: number,
	organizationId: string,
	judgeModel: string,
	db?: DbClient,
): Promise<void> {
	const sql = db ?? getDb();
	await withEntityWriteTransaction(sql, async (tx) => {
		const rows = await tx<{ metadata: Record<string, unknown> | null }>`
      SELECT e.metadata
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.id = ${entityId}
        AND e.organization_id = ${organizationId}
        AND et.slug = ${EVAL_CASE_ENTITY_TYPE_SLUG}
        AND e.deleted_at IS NULL
      FOR UPDATE OF e
    `;
		if (rows.length === 0) return;
		await patchEntityRows({
			tx,
			ids: [entityId],
			patch: {
				metadata: { ...(rows[0].metadata ?? {}), judge_model: judgeModel },
			},
		});
	});
}

/**
 * Replay a promoted case: mint an eval run from the case's source run.
 *
 * The case's own `case_key` scopes replay idempotency, which is what makes
 * repeat replays safe — `createEvalRun`'s partial unique index covers only
 * pending/claimed/running, so replaying a case whose last eval FINISHED queues
 * a fresh one, while replaying a case with an eval still in flight returns that
 * one instead of stacking duplicates.
 */
export async function replayEvalCase(
	entityId: number,
	db?: DbClient,
): Promise<CreateEvalRunResult | null> {
	const sql = db ?? getDb();
	// Constrained to the case type: `source_run_id` is not a reserved key, so a
	// bare id lookup would happily "replay" any unrelated entity carrying one.
	const rows = (await sql`
    SELECT e.metadata
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ${entityId}
      AND e.deleted_at IS NULL
      AND et.slug = ${EVAL_CASE_ENTITY_TYPE_SLUG}
    LIMIT 1
  `) as unknown as Array<{ metadata: Record<string, unknown> | null }>;

	if (rows.length === 0) {
		logger.warn({ entityId }, "[evals] no such eval case to replay");
		return null;
	}
	const metadata = rows[0].metadata ?? {};
	const sourceRunId = Number(metadata.source_run_id);
	const caseKey =
		typeof metadata.case_key === "string" ? metadata.case_key : "default";
	if (!Number.isSafeInteger(sourceRunId) || sourceRunId < 1) {
		logger.warn(
			{ entityId },
			"[evals] eval case carries no usable source_run_id — not replaying",
		);
		return null;
	}

	return createEvalRun({ sourceRunId, caseKey }, sql);
}

/**
 * How many readable numeric suffixes (`-2`, `-3`, …) to try when the base slug
 * is taken. Matches promote-keyed-entities' `SLUG_DISAMBIGUATION_ATTEMPTS`.
 */
const SLUG_DISAMBIGUATION_ATTEMPTS = 5;

/**
 * Insert the case entity, tolerating a collision on
 * `entities_slug_parent_unique (organization_id, COALESCE(parent_id, 0), slug)`.
 *
 * The slug cannot be treated as the identity. `slugifyCaseKey` is lossy — a run
 * promoted under `angle-a`, `angle_a` and `Angle A` produces one slug for three
 * different questions — and the index is NOT partial on `deleted_at`, so a
 * retired case keeps holding its slug forever. Adopting whichever row owns the
 * slug would fold distinct cases together and then replay them under the wrong
 * `case_key`, which is the wrong idempotency key. So adopt only the row that is
 * genuinely this (run, key) — the real recovery case, a promote that died
 * between the insert and its identity claim — and otherwise take a suffixed
 * slug. The `entity_identities` claim is the identity; the slug is cosmetic.
 *
 * Returns null when every candidate slug is held by some other case.
 */
async function insertCaseEntity(params: {
	sql: DbClient;
	organizationId: string;
	entityTypeId: number;
	createdBy: string;
	name: string;
	baseSlug: string;
	sourceRunId: number;
	caseKey: string;
	metadata: Record<string, unknown>;
}): Promise<{ entityId: number; created: boolean } | null> {
	const { sql } = params;
	for (let attempt = 1; attempt <= SLUG_DISAMBIGUATION_ATTEMPTS; attempt++) {
		const slug =
			attempt === 1 ? params.baseSlug : `${params.baseSlug}-${attempt}`;
		const inserted = await tryInsertEntityRow({
			tx: sql,
			row: {
				organizationId: params.organizationId,
				entityTypeId: params.entityTypeId,
				name: params.name,
				slug,
				metadata: params.metadata,
				createdBy: params.createdBy,
			},
		});
		if (inserted) {
			return { entityId: Number(inserted.id), created: true };
		}

		// Soft-deleted rows still hold the slug (the index is not partial), so look
		// without the `deleted_at` filter and only adopt a LIVE matching case.
		const owner = (await sql`
      SELECT e.id, e.metadata, e.deleted_at, et.slug AS type_slug
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${params.organizationId}
        AND COALESCE(e.parent_id, 0) = 0
        AND e.slug = ${slug}
      LIMIT 1
    `) as unknown as Array<{
			id: number | string;
			metadata: Record<string, unknown> | null;
			deleted_at: Date | null;
			type_slug: string;
		}>;
		const row = owner[0];
		if (
			row &&
			row.deleted_at == null &&
			row.type_slug === EVAL_CASE_ENTITY_TYPE_SLUG &&
			Number(row.metadata?.source_run_id) === params.sourceRunId &&
			row.metadata?.case_key === params.caseKey
		) {
			return { entityId: Number(row.id), created: false };
		}
	}
	return null;
}

async function findEvalCaseByIdentifier(
	sql: DbClient,
	organizationId: string,
	identifier: string,
): Promise<EvalCase | null> {
	const rows = (await sql`
    SELECT e.id, e.metadata
    FROM entity_identities ei
    JOIN entities e ON e.id = ei.entity_id
    WHERE ei.organization_id = ${organizationId}
      AND ei.namespace = ${EVAL_CASE_NAMESPACE}
      AND ei.identifier = ${identifier}
      AND ei.deleted_at IS NULL
      AND e.deleted_at IS NULL
    LIMIT 1
  `) as unknown as Array<{
		id: number | string;
		metadata: Record<string, unknown> | null;
	}>;
	if (rows.length === 0) return null;
	const metadata = rows[0].metadata ?? {};
	return {
		entityId: Number(rows[0].id),
		organizationId,
		sourceRunId: Number(metadata.source_run_id),
		automationId: Number(metadata.automation_id),
		caseKey:
			typeof metadata.case_key === "string" ? metadata.case_key : "default",
	};
}

/**
 * Claim the (source run, case key) identity for this entity.
 *
 * Repoints the claim when — and only when — it currently points at a
 * soft-deleted entity. `deleteEntity` does `UPDATE entities SET deleted_at` and
 * never touches `entity_identities`, so after a case is retired the live claim
 * outlives the row it names. A plain `DO NOTHING` would leave it that way
 * forever: `findEvalCaseByIdentifier` joins on live entities, so it would never
 * resolve again and the documented identity lock would be silently dead for
 * that (run, key) — promotes would keep limping along on slug adoption instead.
 *
 * The `WHERE EXISTS (… deleted_at IS NOT NULL)` is what keeps this from
 * clobbering a live claim: a concurrent replica that legitimately won the
 * identifier still wins, because its row is live and the update is skipped.
 */
async function claimEvalCaseIdentity(
	sql: DbClient,
	organizationId: string,
	identifier: string,
	entityId: number,
): Promise<void> {
	await sql`
    INSERT INTO entity_identities (
      organization_id, entity_id, namespace, identifier, created_at
    ) VALUES (
      ${organizationId}, ${entityId}, ${EVAL_CASE_NAMESPACE}, ${identifier},
      current_timestamp
    )
    ON CONFLICT (organization_id, namespace, identifier, COALESCE(scope_connection_id, 0)) WHERE deleted_at IS NULL
    DO UPDATE SET entity_id = EXCLUDED.entity_id, updated_at = current_timestamp
    WHERE EXISTS (
      SELECT 1 FROM entities de
      WHERE de.id = entity_identities.entity_id
        AND de.deleted_at IS NOT NULL
    )
  `;
}

/**
 * Slug-safe form of a case key. Kept local rather than reusing `slugify`: this
 * feeds an entity slug that must stay stable for the life of the case, so it
 * must not drift when the shared slugify helper changes.
 */
function slugifyCaseKey(caseKey: string): string {
	const cleaned = caseKey
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || "default";
}
