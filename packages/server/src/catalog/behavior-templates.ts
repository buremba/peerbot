import type { CatalogEntry } from "./types";

/**
 * Bundled default Behavior templates served by the global catalog
 * (`GET /catalog?kinds=behaviors`) when `LOBU_CATALOG_URIS` is unset. Each
 * entry's `detail` mirrors `manage_behaviors` create fields (snake_case) so the
 * "From catalog" picker can prefill the form directly — the same prefill shape
 * the "Clone existing" path uses.
 *
 * Most templates are entity-agnostic, so the user picks the entity and schedule
 * in the form. Specialized templates may include portable `@` sources and a
 * reaction script; an exported reaction input schema then governs extraction.
 * Override or replace these by pointing `LOBU_CATALOG_URIS` at your own
 * `behaviors.json` manifest (env wins outright — there is no merge with these
 * defaults).
 */
function scheduleTrigger(cron: string): Record<string, unknown> {
	return {
		kind: "schedule",
		cron,
		execution: "window",
		active_run: "coalesce",
		skip_if_unchanged: true,
	};
}

export const BEHAVIOR_CATALOG_TEMPLATES: CatalogEntry[] = [
	{
		id: "daily-summary",
		name: "Daily summary",
		version: "1.0.0",
		description:
			"Summarize the most important activity in each window into a short digest.",
		detail: {
			slug: "daily-summary",
			triggers: [scheduleTrigger("0 8 * * *")],
			prompt:
				"Review the activity in this window and produce a concise summary of what matters most. Call out anything notable, surprising, or worth acting on.\n\nReturn a short narrative summary plus a bullet-point list of the most important highlights.\n",
			tags: ["summary", "digest"],
		},
	},
	{
		id: "sentiment-monitor",
		name: "Sentiment monitor",
		version: "1.0.0",
		description:
			"Track sentiment over time and surface the drivers behind shifts.",
		detail: {
			slug: "sentiment-monitor",
			triggers: [scheduleTrigger("0 */6 * * *")],
			prompt:
				"Analyze the overall sentiment of the activity in this window. Classify it, score it, and explain the main drivers behind the sentiment.\n\nReport the sentiment classification (positive, neutral, or negative), a score from -1 (negative) to 1 (positive), and the key factors driving it.\n",
			classifiers: [
				{
					slug: "sentiment",
					name: "Sentiment",
					source_path: "$",
					value_field: "sentiment",
				},
			],
			tags: ["sentiment", "monitoring"],
		},
	},
	{
		id: "risk-alert",
		name: "Risk & anomaly alert",
		version: "1.0.0",
		description:
			"Watch for anomalies and rising risk, with guidance on when to escalate.",
		detail: {
			slug: "risk-alert",
			triggers: [scheduleTrigger("0 */4 * * *")],
			prompt:
				"Inspect the activity in this window for anomalies, risks, or anything that deviates from the norm. Assess the risk level and recommend whether action is needed.\n\nReport the overall risk level (low, medium, or high), the specific anomalies or risks detected, and a recommended action.\n",
			reactions_guidance:
				"Only alert when risk is high, or medium with a concrete recommended action. Keep low-risk windows silent.",
			tags: ["risk", "alert", "monitoring"],
		},
	},
	{
		id: "action-items",
		name: "Action item extractor",
		version: "1.0.0",
		description:
			"Pull tasks, follow-ups, and commitments out of the activity in each window.",
		detail: {
			slug: "action-items",
			triggers: [scheduleTrigger("0 18 * * *")],
			prompt:
				"Extract every actionable task, follow-up, or commitment mentioned in this window. Capture who owns it and any due date if stated.\n\nReturn a list of action items, each with a title and — when known — an owner and a due date or timeframe.\n",
			tags: ["tasks", "action-items"],
		},
	},
	{
		id: "duplicate-merge",
		name: "Duplicate entity merge",
		version: "3.0.0",
		description:
			"Find entities that are the same real-world thing and fold duplicates into one canonical record.",
		detail: {
			slug: "duplicate-merge",
			triggers: [scheduleTrigger("0 3 * * *")],
			// A cross-entity Behavior: its source surfaces people rather than events.
			// The model explains findings; the entity-resolution module owns grouping,
			// normalization, auto/review policy, suppression, and merge limits.
			sources: [{ name: "people", query: "@entity:person" }],
			prompt:
				"Review every row in sources.people. Explain likely duplicate groups in analysis_summary and put name-only, alias-only, handle-only, oversized, or otherwise uncertain groups in uncertain_groups with why. Do not call entity tools or emit backlog tasks. After analysis, the deterministic reaction submits only candidate IDs to the server. The person entity type's x-lobu-resolution policy decides which normalized identities auto-merge and which require human review. Without that extension, normalized email and phone matches remain review-only and never auto-merge.\n",
			reaction_script: `export const input = {
	type: "object",
	properties: {
		analysis_summary: { type: "string" },
		uncertain_groups: { type: "array", items: { type: "object" } },
	},
	required: ["analysis_summary", "uncertain_groups"],
	additionalProperties: false,
};

export default async function reaction(ctx, client) {
	const MAX_CANDIDATES = 5000;
	const since = String(ctx.window.window_start).slice(0, 10);
	const until = new Date(new Date(ctx.window.window_end).getTime() - 1).toISOString().slice(0, 10);
	const knowledge = await client.knowledge.read({ watcher_id: ctx.window.watcher_id, since, until });
	const candidates = Array.isArray(knowledge?.sources?.people) ? knowledge.sources.people : [];
	const candidateIds = [...new Set(candidates
		.map((candidate) => candidate?.id)
		.filter((id) => Number.isSafeInteger(id) && id > 0))];
	if (candidateIds.length < 2) return;
	if (candidateIds.length > MAX_CANDIDATES) {
		throw new Error("More than 5000 entities need duplicate discovery; no changes were queued");
	}
	await client.entities.manage({
		action: "resolve_duplicates",
		candidate_entity_ids: candidateIds,
	});
}`,
			reactions_guidance:
				"Explain uncertainty; never decide identity from names, aliases, or handles. The server-side entity type policy is the only merge authority.",
			tags: ["identity", "deduplication", "world-model"],
		},
	},
];
