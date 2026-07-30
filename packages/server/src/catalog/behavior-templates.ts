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
		// Platform remediation for hard-paused feeds. Lobu writes lifecycle
		// events (semantic_type=change, metadata.extra.reason=feed.auto_paused).
		// This template schedules hourly and SQL-sources those events so one
		// Behavior covers every connector without per-connector event triggers.
		// Install via "From catalog" / manage_behaviors — not auto-created.
		id: "feed-auto-pause",
		name: "Feed auto-pause helper",
		version: "1.1.0",
		description:
			"Hourly check for feeds Lobu hard-paused after consecutive sync failures. Sources recent feed.auto_paused lifecycle events (all connectors) and notifies admins with re-auth / device / config next steps.",
		detail: {
			slug: "feed-auto-pause",
			triggers: [scheduleTrigger("0 * * * *")],
			// Explicit SQL: default Behavior sources exclude semantic_type=change.
			// Bounded by recency (last 25h, one hour of overlap with the hourly
			// schedule) so long-paused feeds stop being re-notified forever, with
			// no hard row LIMIT — a burst larger than a cap would otherwise stay
			// invisible once the window advances. This template is advisory
			// notification, not the delivery guarantee: the durable path is the
			// per-episode audit event plus retryPendingFeedAutoPausedSignals.
			sources: [
				{
					name: "auto_paused",
					query:
						"SELECT id, title, origin_id, connection_id, feed_id, connector_key, feed_key, metadata, occurred_at, created_at FROM events WHERE semantic_type = 'change' AND metadata->'extra'->>'reason' = 'feed.auto_paused' AND created_at >= NOW() - interval '25 hours' ORDER BY occurred_at DESC",
				},
			],
			prompt:
				"Review sources.auto_paused — each row is a feed Lobu hard-paused after consecutive failures. metadata.extra has last_error, consecutive_failures, connection_id, connector_key.\n\nFor each distinct feed that still needs attention (dedupe by feed_id / origin_id), decide the most useful next step for an org admin:\n1. Auth/session/scopes expired — re-authenticate the connection.\n2. worker_claim_timeout / device offline — open the paired device / Owletto.\n3. Config/missing path — explain what to fix; leave the feed paused until then.\n4. Otherwise summarize and point at Connections.\n\nIf sources.auto_paused is empty, do nothing (no notification).\nKeep it short. Prefer client.notifications.send to admins; do not unpause feeds automatically.\n",
			notification_channel: "notification",
			notification_priority: "high",
			tags: ["platform", "feed-health"],
		},
	},
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
	const knowledge = await client.knowledge.read({ behavior_id: ctx.window.behavior_id, since, until });
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
