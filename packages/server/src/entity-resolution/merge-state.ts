interface MergeStateEntity {
	name: string;
	metadata: Record<string, unknown>;
	fieldControls: Record<string, unknown>;
}

interface MergedEntityState {
	metadata: Record<string, unknown>;
	fieldControls: Record<string, unknown>;
}

function valueKey(value: unknown): string {
	if (value && typeof value === "object") {
		if (Array.isArray(value)) return `[${value.map(valueKey).join(",")}]`;
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${valueKey(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? String(value);
}

function unionValues(winner: unknown[], loser: unknown[]): unknown[] {
	const values = new Map<string, unknown>();
	for (const item of [...winner, ...loser]) values.set(valueKey(item), item);
	return [...values.values()];
}

/**
 * Merge complementary entity attributes without inventing a new source of
 * truth. Winner scalar conflicts stay canonical; arrays are unioned; missing
 * fields and their ownership markers move across. The loser's name is retained
 * as an alias so search and attribution still recognize it.
 */
export function mergeEntityState(
	winner: MergeStateEntity,
	loser: MergeStateEntity,
): MergedEntityState {
	const metadata = structuredClone(winner.metadata);
	const fieldControls = structuredClone(winner.fieldControls);

	for (const [field, loserValue] of Object.entries(loser.metadata)) {
		const winnerValue = metadata[field];
		if (
			winnerValue === undefined ||
			winnerValue === null ||
			winnerValue === ""
		) {
			metadata[field] = structuredClone(loserValue);
			if (loser.fieldControls[field] !== undefined) {
				fieldControls[field] = structuredClone(loser.fieldControls[field]);
			}
			continue;
		}
		if (Array.isArray(winnerValue) && Array.isArray(loserValue)) {
			metadata[field] = unionValues(winnerValue, loserValue);
			if (
				fieldControls[field] === undefined &&
				loser.fieldControls[field] !== undefined
			) {
				fieldControls[field] = structuredClone(loser.fieldControls[field]);
			}
		}
	}

	const aliases = unionValues(
		Array.isArray(metadata.aliases) ? metadata.aliases : [],
		[
			...(Array.isArray(loser.metadata.aliases) ? loser.metadata.aliases : []),
			loser.name,
		],
	).filter((alias) => typeof alias === "string" && alias.trim().length > 0);
	if (aliases.length > 0) metadata.aliases = aliases;

	return { metadata, fieldControls };
}
