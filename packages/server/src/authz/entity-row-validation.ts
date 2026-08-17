/**
 * The entity-row VALIDATION seam.
 *
 * `patchEntityRows` is the single physical writer for entity rows (the
 * `check-entity-write-funnel` gate proves no raw entity SQL lives outside
 * `entity-management.ts`). It is therefore the only place every write
 * converges, and the only place a state invariant can be enforced without
 * depending on 20-odd callers each remembering to ask.
 *
 * Enforcement is structural rather than conventional: `patchEntityRows` accepts
 * only a {@link ValidatedEntityRowPatch}, which this module alone can mint. A
 * caller that forgets to validate does not slip through — it fails to compile.
 *
 * Two reasons validation lives HERE and not in `runMutationGate`:
 *
 *  1. The gate answers a PERMISSION question (may this principal write this
 *     field) and is keyed on `principalKind` + ownership. Validation answers
 *     "is the resulting state legal", which has no principal in it.
 *  2. The gate runs BEFORE approval-held fields are stripped and before the
 *     ownership merge rewrites the patch. It therefore judges a proposal, not
 *     what commits. This seam sees the effective patch — the exact bytes about
 *     to hit the table — so it cannot be fooled by either transformation.
 */

import { type DbClient, pgBigintArray } from "../db/client";
import type { EntityRowPatch } from "../utils/entity-management";
import {
	MalformedSpecError,
	evaluateTransition,
	specFromMetadataSchema,
} from "./entity-transition-rules";

declare const validatedBrand: unique symbol;

/**
 * An `EntityRowPatch` that has passed validation (or been explicitly exempted).
 * Only this module can produce one — the brand has no public constructor, so
 * `patchEntityRows` cannot be called with an unchecked patch.
 */
export type ValidatedEntityRowPatch = EntityRowPatch & {
	readonly [validatedBrand]: true;
};

/** Thrown when a patch would produce an illegal state. */
export class EntityRowValidationError extends Error {}

/**
 * Patch columns a transition spec can never govern: platform bookkeeping that
 * no tenant declares in its schema. A patch touching only these skips
 * validation entirely — no spec read, no evaluation — which is what keeps the
 * common write off the validation path.
 *
 * The complement (`metadata`, `name`, `slug`, `parentId`, `content`,
 * `softDelete`) IS governed: freezing a document has to stop a rename and a
 * delete, not merely a metadata edit.
 */
const UNGOVERNED_COLUMNS: ReadonlySet<string> = new Set([
	"currentViewTemplateVersionId",
	"fieldControls",
	"enabledClassifiers",
	"embedding",
	"contentHash",
]);

/** Reserved `$`-names the spec sees for non-metadata columns. */
const RESERVED_COLUMN_NAMES: Readonly<Record<string, string>> = {
	name: "$name",
	slug: "$slug",
	parentId: "$parent_id",
	content: "$content",
	softDelete: "$deleted",
};

function touchesGovernedColumn(patch: EntityRowPatch): boolean {
	return Object.keys(patch).some((k) => !UNGOVERNED_COLUMNS.has(k));
}

/**
 * Flatten a patch into the single namespace a spec reasons about: metadata keys
 * plus reserved `$`-names for columns.
 *
 * `patch.metadata` is the fully merged metadata object, not a delta, so most of
 * its keys are unchanged values. `evaluateTransition` compares against the
 * committed row and ignores no-ops, which is what makes passing the whole
 * object correct rather than a source of false violations.
 */
function flatten(
	patch: EntityRowPatch,
	metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
	const flat: Record<string, unknown> = { ...(metadata ?? {}) };
	for (const [column, reserved] of Object.entries(RESERVED_COLUMN_NAMES)) {
		if (Object.hasOwn(patch, column)) {
			flat[reserved] = patch[column as keyof EntityRowPatch] ?? null;
		}
	}
	return flat;
}

interface CommittedRow {
	id: number;
	metadata: unknown;
	metadata_schema: unknown;
	name: string | null;
	slug: string | null;
	parent_id: string | number | null;
	content: string | null;
	deleted_at: Date | null;
}

function committedState(row: CommittedRow): Record<string, unknown> {
	const metadata = (
		typeof row.metadata === "string"
			? JSON.parse(row.metadata)
			: (row.metadata ?? {})
	) as Record<string, unknown>;
	return {
		...metadata,
		$name: row.name ?? null,
		$slug: row.slug ?? null,
		$parent_id: row.parent_id == null ? null : Number(row.parent_id),
		$content: row.content ?? null,
		$deleted: row.deleted_at != null,
	};
}

/**
 * Validate an effective patch against every target row's declared transition
 * spec, returning the patch branded for {@link patchEntityRows}.
 *
 * Queries only the caller's handle — never `getDb()`. A pooled query from
 * inside an entity write transaction is the #2818 deadlock (every pool session
 * parked `idle in transaction` on the same statement), and it would also read a
 * different snapshot than the one being written.
 *
 * @throws EntityRowValidationError when the patch would produce an illegal
 * state, or when a type declares a spec that cannot be parsed (opting in with a
 * typo must fail closed, not silently disable the invariant).
 */
export async function validateEntityRowPatch(params: {
	tx: DbClient;
	ids: number[];
	patch: EntityRowPatch;
}): Promise<ValidatedEntityRowPatch> {
	const { tx, ids, patch } = params;
	const branded = patch as ValidatedEntityRowPatch;
	if (ids.length === 0) return branded;
	// Fast path: nothing a spec could govern, so no read and no evaluation.
	if (!touchesGovernedColumn(patch)) return branded;

	// The pool runs with `fetch_types: false`, so a raw JS array binds as
	// "malformed array literal". Bind the formatted `{n,n}` text and cast, exactly
	// as `patchEntityRows` itself does.
	const rows = await tx<CommittedRow>`
    SELECT e.id, e.metadata, e.name, e.slug, e.parent_id, e.content,
           e.deleted_at, et.metadata_schema
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ANY(${pgBigintArray(ids)}::bigint[])
  `;

	for (const row of rows) {
		let spec: ReturnType<typeof specFromMetadataSchema>;
		try {
			spec = specFromMetadataSchema(row.metadata_schema);
		} catch (err) {
			if (err instanceof MalformedSpecError) {
				throw new EntityRowValidationError(
					`entity ${row.id}: invalid x-transitions: ${err.message}`,
				);
			}
			throw err;
		}
		if (!spec) continue;

		const reason = evaluateTransition({
			spec,
			committed: committedState(row),
			patch: flatten(patch, patch.metadata),
		});
		if (reason !== null) {
			throw new EntityRowValidationError(`entity ${row.id}: ${reason}`);
		}
	}
	return branded;
}

/**
 * Mint a validated patch WITHOUT running validation.
 *
 * For platform bookkeeping that legitimately sits outside tenant state rules —
 * eval scaffolding, ACL graph upkeep, merge-ledger transitions. Deliberately
 * named and greppable: an exemption should be visible in review, unlike the
 * implicit bypass that every direct `patchEntityRows` caller enjoyed before
 * this seam existed.
 *
 * @param reason why this write is not subject to state validation.
 */
export function unvalidatedEntityRowPatch(params: {
	patch: EntityRowPatch;
	reason: string;
}): ValidatedEntityRowPatch {
	return params.patch as ValidatedEntityRowPatch;
}
