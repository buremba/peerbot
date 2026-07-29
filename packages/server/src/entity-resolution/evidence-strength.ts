import type { ResolutionEvidence, ResolutionKeySet } from "./policy";

/** Preserve the boundary between two free-form values without a delimiter. */
const evidenceKey = (item: ResolutionEvidence): string =>
	JSON.stringify([item.kind, item.identifier]);

/**
 * A strict evidence gain preserves everything reviewed and adds at least one
 * new proof. Unchanged evidence is not enough because the fingerprint may have
 * moved on an unmatched identity that evidence does not expose.
 */
export function hasEvidenceStrengthened(
	reviewed: ResolutionEvidence[],
	current: ResolutionEvidence[],
): boolean {
	return (
		droppedEvidence(reviewed, current).length === 0 &&
		gainedEvidence(reviewed, current).length > 0
	);
}

/** Evidence present at review time that the current assessment no longer proves. */
export function droppedEvidence(
	reviewed: ResolutionEvidence[],
	current: ResolutionEvidence[],
): ResolutionEvidence[] {
	const currentKeys = new Set(current.map(evidenceKey));
	return reviewed.filter((item) => !currentKeys.has(evidenceKey(item)));
}

/** Evidence the current assessment proves that was not recorded at review time. */
export function gainedEvidence(
	reviewed: ResolutionEvidence[],
	current: ResolutionEvidence[],
): ResolutionEvidence[] {
	const reviewedKeys = new Set(reviewed.map(evidenceKey));
	return current.filter((item) => !reviewedKeys.has(evidenceKey(item)));
}

/**
 * Whether a merge re-check added proof without changing any unmatched
 * resolution key. Evidence alone cannot establish that: a new shared phone can
 * hide a different new email on each side because only matches become evidence.
 */
export function hasMergeEvidenceStrengthened(input: {
	reviewedEvidence: ResolutionEvidence[];
	currentEvidence: ResolutionEvidence[];
	winnerId: number;
	loserIds: number[];
	reviewedResolutionKeys: readonly ResolutionKeySet[];
	currentResolutionKeys: readonly ResolutionKeySet[];
}): boolean {
	if (
		!hasEvidenceStrengthened(input.reviewedEvidence, input.currentEvidence)
	) {
		return false;
	}

	// Keys arrive as JSON objects from runs.action_input, and a rule field is a
	// user-defined metadata field name — so `keys["constructor"]` would read off
	// Object.prototype and blow up on `new Set(...)`. Index through Maps, never
	// object literals. (Same class of bug as the object-literal key map that
	// review-fix caught in assessEntityResolution.)
	const keysById = (sets: readonly ResolutionKeySet[]) =>
		new Map(
			sets.map(({ id, keys }) => [
				id,
				new Map(Object.entries(keys).map(([kind, values]) => [kind, values])),
			]),
		);
	const reviewedById = keysById(input.reviewedResolutionKeys);
	const currentById = keysById(input.currentResolutionKeys);
	const entityIds = [input.winnerId, ...input.loserIds];

	for (const entityId of entityIds) {
		const current = currentById.get(entityId);
		if (!current) return false;
		const reviewed = reviewedById.get(entityId) ?? new Map<string, string[]>();

		// Nothing the reviewer was shown may have disappeared.
		for (const [kind, reviewedValues] of reviewed) {
			const currentValues = new Set(current.get(kind) ?? []);
			if (reviewedValues.some((value) => !currentValues.has(value))) {
				return false;
			}
		}

		// Any newly appeared key must be matched by a counterpart. An unmatched
		// one produces no evidence, so it would otherwise widen the merge with a
		// claim nobody reviewed.
		const counterpartIds =
			entityId === input.winnerId ? input.loserIds : [input.winnerId];
		for (const [kind, currentValues] of current) {
			const reviewedValues = new Set(reviewed.get(kind) ?? []);
			for (const value of currentValues) {
				if (reviewedValues.has(value)) continue;
				const gainedMatch = counterpartIds.some((counterpartId) =>
					(currentById.get(counterpartId)?.get(kind) ?? []).includes(value),
				);
				if (!gainedMatch) return false;
			}
		}
	}
	return true;
}
