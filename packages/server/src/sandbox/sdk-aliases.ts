/**
 * Accepted input-field aliases for ClientSDK methods, keyed by public dotted
 * path. ONE source: the sandbox dispatch layer (`createActionCaller`) rewrites
 * these at runtime, and `search_sdk` renders the same table into discovery —
 * so the documented aliases can never drift from what the runtime accepts.
 *
 * Only clean, unambiguous renames belong here (an alias must mean exactly the
 * canonical field, never a different concept). The canonical field always wins
 * when both are supplied.
 */

export const SDK_FIELD_ALIASES: Readonly<
	Record<string, Readonly<Record<string, string>>>
> = {
	// intuitive `id` for the entity/feed id field
	"entities.get": { id: "entity_id" },
	"entities.delete": { id: "entity_id" },
	// runtime field is `entity_type` (as `entities.list` exposes it); callers guess `type`
	"entities.create": { type: "entity_type" },
	"feeds.get": { id: "feed_id" },
	// schedules use plain `id`; callers guess `schedule_id`
	"schedules.update": { schedule_id: "id" },
	"schedules.pause": { schedule_id: "id" },
	"schedules.cancel": { schedule_id: "id" },
	// runtime field is `reaction_script`; callers guess `script`
	"automations.setReactionScript": { script: "reaction_script" },
	// runtime field is `body`; callers guess `message`
	"notifications.send": { message: "body" },
	// runtime field is `display_name`; callers guess `name`
	"connections.update": { name: "display_name" },
};

/**
 * Rewrite accepted alias fields to their canonical names for one method path.
 * The canonical field wins when both are present (the alias is then dropped);
 * inputs without aliases pass through unchanged.
 */
export function applyFieldAliases(
	path: string,
	input: Record<string, unknown>,
): Record<string, unknown> {
	const aliases = SDK_FIELD_ALIASES[path];
	if (!aliases) return input;
	let out: Record<string, unknown> | null = null;
	for (const [alias, canonical] of Object.entries(aliases)) {
		if (!(alias in input)) continue;
		out ??= { ...input };
		if (!(canonical in out)) out[canonical] = out[alias];
		delete out[alias];
	}
	return out ?? input;
}
