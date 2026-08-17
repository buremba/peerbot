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
import type {
	EntityRowInsert,
	EntityRowPatch,
} from "../utils/entity-management";
import { type EntityRuleRow, runEntityRules } from "./entity-rule-executor";

declare const validatedBrand: unique symbol;

/**
 * An `EntityRowPatch` that has passed validation (or been explicitly exempted).
 * Only this module can produce one — the brand has no public constructor, so
 * `patchEntityRows` cannot be called with an unchecked patch.
 */
export type ValidatedEntityRowPatch = EntityRowPatch & {
	readonly [validatedBrand]: true;
};

/** What a rule decided, carried on the error so a caller can route it. */
export interface EntityRowValidationVerdict {
	outcome: "deny" | "escalate";
	reason: string;
	/** Fields the rule named when escalating. Empty for a deny. */
	fields: string[];
	/** The row judged, or null for a create — there is no row yet. */
	entityId: number | null;
}

/**
 * Thrown when a patch would produce an illegal state.
 *
 * Throwing rather than returning a verdict is deliberate: it makes failing
 * closed the DEFAULT for every caller. Only `updateEntity` has approval
 * machinery to route an escalation into, and it opts in by catching this and
 * reading {@link verdict}. Merge, link auto-create and eval scaffolding have
 * nowhere to queue a card, so for them a rule that asked for review must stop
 * the write — which is exactly what an uncaught throw does.
 */
export class EntityRowValidationError extends Error {
	readonly verdict: EntityRowValidationVerdict;

	constructor(message: string, verdict: EntityRowValidationVerdict) {
		super(message);
		this.name = "EntityRowValidationError";
		this.verdict = verdict;
	}
}

/**
 * Patch columns a write rule can never govern: platform bookkeeping that no
 * tenant declares in its schema. A patch touching only these skips validation
 * entirely — no rule read, no evaluation — which is what keeps the common write
 * off the validation path.
 *
 * The complement (`metadata`, `name`, `slug`, `parentId`, `content`,
 * `softDelete`) IS governed: freezing a document has to stop a rename, not
 * merely a metadata edit. `softDelete` is governed by this seam but no
 * soft-delete caller routes through it yet — see the KNOWN GAP in
 * `deleteEntity`.
 */
const UNGOVERNED_COLUMNS: ReadonlySet<string> = new Set([
	"currentViewTemplateVersionId",
	"fieldControls",
	"enabledClassifiers",
	"embedding",
	"contentHash",
]);

/** Reserved `$`-names a rule sees for non-metadata columns. */
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
 * Flatten a patch into the single namespace a rule reasons about: metadata keys
 * plus reserved `$`-names for columns.
 *
 * `patch.metadata` is the fully merged metadata object, not a delta, so most of
 * its keys are unchanged values. That is why `row.changed(f)` compares the VALUE
 * in `committed` against the one in `next` rather than asking whether the key is
 * present — presence is true for every metadata key on every metadata write, so
 * a presence test would fire on writes that never touched the field.
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
	rules_compiled: string | null;
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
 * Validate an effective patch against every target row's declared write rules,
 * returning the patch branded for {@link patchEntityRows}.
 *
 * Queries only the caller's handle — never `getDb()`. A pooled query from
 * inside an entity write transaction is the #2818 deadlock (every pool session
 * parked `idle in transaction` on the same statement), and it would also read a
 * different snapshot than the one being written.
 *
 * Rows are grouped by their type's compiled rule so each distinct rule runs in
 * ONE isolate over its whole group. Per-row isolates do not scale — measured at
 * ~300 evals/sec, or ~21s for a 5,000-row sync, against ~13.5ms for the same
 * rows batched.
 *
 * @throws EntityRowValidationError when a rule denies the write, when a rule
 * crashes or times out (fail closed: a rule that did not finish cannot bless a
 * write), or when it returns an unusable verdict.
 */
export async function validateEntityRowPatch(params: {
	tx: DbClient;
	ids: number[];
	patch: EntityRowPatch;
	/**
	 * What an `escalate` verdict means for THIS caller.
	 *
	 * `"defer"` (the default) throws, and the caller decides whether to route
	 * that into an approval or simply fail closed. `"approved"` treats it as an
	 * allow, and belongs to exactly one caller: the path applying a proposal a
	 * human already approved.
	 *
	 * Without it, escalation is a dead end. Approving the card re-runs the same
	 * rule against the same committed state, it escalates again, and the write
	 * throws — so the approval a rule asked for could never be honoured and the
	 * card could never be cleared. A `deny` still throws in both modes: approval
	 * cannot make an illegal state legal.
	 */
	onEscalate?: "defer" | "approved";
}): Promise<ValidatedEntityRowPatch> {
	const { tx, ids, patch, onEscalate = "defer" } = params;
	const branded = patch as ValidatedEntityRowPatch;
	if (ids.length === 0) return branded;
	// Fast path: nothing a rule could govern, so no read and no evaluation.
	if (!touchesGovernedColumn(patch)) return branded;

	// The pool runs with `fetch_types: false`, so a raw JS array binds as
	// "malformed array literal". Bind the formatted `{n,n}` text and cast, exactly
	// as `patchEntityRows` itself does.
	//
	// `rules_compiled` rides the join this query already makes, so rule lookup
	// costs no extra round trip.
	const rows = await tx<CommittedRow>`
    SELECT e.id, e.metadata, e.name, e.slug, e.parent_id, e.content,
           e.deleted_at, et.rules_compiled
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ANY(${pgBigintArray(ids)}::bigint[])
  `;

	// One group per distinct compiled rule. Types without rules never reach an
	// isolate at all, which keeps an unruled org's writes exactly as cheap as
	// they are today.
	const groups = new Map<string, { ids: number[]; rows: EntityRuleRow[] }>();
	const flatPatch = flatten(patch, patch.metadata);
	for (const row of rows) {
		if (!row.rules_compiled) continue;
		const group = groups.get(row.rules_compiled) ?? { ids: [], rows: [] };
		group.ids.push(row.id);
		group.rows.push({ committed: committedState(row), patch: flatPatch });
		groups.set(row.rules_compiled, group);
	}
	if (groups.size === 0) return branded;

	for (const [compiled, group] of groups) {
		const verdicts = await runEntityRules({
			compiled,
			rows: group.rows,
			op: "update",
		});
		for (const [index, verdict] of verdicts.entries()) {
			const entityId = group.ids[index] ?? null;
			if (verdict.outcome === "deny") {
				throw new EntityRowValidationError(
					`entity ${entityId}: ${verdict.reason}`,
					{ outcome: "deny", reason: verdict.reason, fields: [], entityId },
				);
			}
			if (verdict.outcome === "escalate") {
				// A human already said yes to this exact proposal.
				if (onEscalate === "approved") continue;
				throw new EntityRowValidationError(
					`entity ${entityId}: ${verdict.reason} ` +
						`(approval required for ${verdict.fields.join(", ")})`,
					{
						outcome: "escalate",
						reason: verdict.reason,
						fields: verdict.fields,
						entityId,
					},
				);
			}
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

// ---------------------------------------------------------------------------
// Inserts
//
// The brand above made skipping validation a compile error for the UPDATE
// writer, and stopped there — so creates went straight to the table. That made
// every rule trivially routable: an agent denied a `draft -> posted` update
// simply creates the document already posted. Regression-tested, with the
// contrast case, in `__tests__/integration/authz/entity-create-validation.test.ts`.
//
// The fix is not a new mechanism, it is the SAME brand on the second writer. A
// create is an update from nothing: `committed` is `{}`, so `changed(f)` is true
// for every field being set and a rule's transition check rejects a document
// born in a state nothing exits into.
// ---------------------------------------------------------------------------

/**
 * An `EntityRowInsert` that has passed validation (or been explicitly exempted).
 * Shares {@link validatedBrand} with {@link ValidatedEntityRowPatch}: one brand,
 * two shapes, so there is one thing to reason about rather than two.
 */
export type ValidatedEntityRowInsert = EntityRowInsert & {
	readonly [validatedBrand]: true;
};

/**
 * Validate a pending insert against its type's write rules, returning the row
 * branded for {@link insertEntityRow}.
 *
 * Reads `entity_types` directly rather than joining through `entities`, because
 * the row does not exist yet — that is the only structural difference from the
 * update path.
 *
 * @throws EntityRowValidationError when the rule denies the create.
 */
export async function validateEntityRowInsert(params: {
	tx: DbClient;
	row: EntityRowInsert;
}): Promise<ValidatedEntityRowInsert> {
	const { tx, row } = params;
	const branded = row as ValidatedEntityRowInsert;

	const types = await tx<{ rules_compiled: string | null }>`
    SELECT rules_compiled FROM entity_types WHERE id = ${row.entityTypeId}
  `;
	const compiled = types[0]?.rules_compiled;
	if (!compiled) return branded;

	const [verdict] = await runEntityRules({
		compiled,
		op: "create",
		rows: [
			{
				// Nothing is committed yet, so a transition check reads the create as
				// a move from nothing — which a rule can either let fall through its
				// transition table or handle explicitly via `op`.
				committed: {},
				patch: flatten(
					{
						name: row.name,
						slug: row.slug,
						parentId: row.parentId ?? null,
						content: row.content ?? null,
					},
					row.metadata,
				),
			},
		],
	});

	if (verdict?.outcome === "deny") {
		throw new EntityRowValidationError(`new ${row.slug}: ${verdict.reason}`, {
			outcome: "deny",
			reason: verdict.reason,
			fields: [],
			entityId: null,
		});
	}
	if (verdict?.outcome === "escalate") {
		// A create has no row to hold fields against and no `deferEntityCreate`
		// in scope here, so an escalating rule stops the create. Routing a held
		// CREATE into an approval card is a separate surface from the update path
		// wired in `updateEntity`, and is deliberately not faked here.
		throw new EntityRowValidationError(
			`new ${row.slug}: ${verdict.reason} ` +
				`(a rule cannot escalate a create — approval routing exists for updates only)`,
			{
				outcome: "escalate",
				reason: verdict.reason,
				fields: verdict.fields,
				entityId: null,
			},
		);
	}
	return branded;
}

/**
 * Mint a validated insert WITHOUT running validation.
 *
 * Same contract as {@link unvalidatedEntityRowPatch}: platform bookkeeping that
 * legitimately sits outside tenant rules, named so the exemption is greppable
 * and visible in review.
 *
 * @param reason why this create is not subject to write rules.
 */
export function unvalidatedEntityRowInsert(params: {
	row: EntityRowInsert;
	reason: string;
}): ValidatedEntityRowInsert {
	return params.row as ValidatedEntityRowInsert;
}
