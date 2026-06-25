import type { CatalogEntry } from "./types";

/**
 * Bundled default watcher templates served by the global catalog
 * (`GET /catalog?kinds=watchers`) when `LOBU_CATALOG_URIS` is unset. Each
 * entry's `detail` mirrors the watcher create-form fields (snake_case) so the
 * "From catalog" picker can prefill the form directly — the same prefill shape
 * the "Clone existing" path uses.
 *
 * Templates stay entity-agnostic (no `sources` SQL, no entity binding): the
 * user picks the entity and schedule in the form. Output structure is governed
 * by the bound entity type (render + schema derive from it — see lobu#1533), so
 * templates express the desired output shape in the prompt rather than via an
 * inline extraction schema. Override or replace these by pointing
 * `LOBU_CATALOG_URIS` at your own `watchers.json` manifest (env wins outright —
 * there is no merge with these defaults).
 */
export const WATCHER_CATALOG_TEMPLATES: CatalogEntry[] = [
	{
		id: "daily-summary",
		name: "Daily summary",
		version: "1.0.0",
		description:
			"Summarize the most important activity in each window into a short digest.",
		detail: {
			slug: "daily-summary",
			schedule: "0 8 * * *",
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
			schedule: "0 */6 * * *",
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
			schedule: "0 */4 * * *",
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
			schedule: "0 18 * * *",
			prompt:
				"Extract every actionable task, follow-up, or commitment mentioned in this window. Capture who owns it and any due date if stated.\n\nReturn a list of action items, each with a title and — when known — an owner and a due date or timeframe.\n",
			tags: ["tasks", "action-items"],
		},
	},
];
