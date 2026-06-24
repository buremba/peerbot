import type { CatalogEntry } from "./types";

/**
 * Bundled default watcher templates served by the global catalog
 * (`GET /catalog?kinds=watchers`) when `LOBU_CATALOG_URIS` is unset. Each
 * entry's `detail` mirrors the watcher create-form fields (snake_case) so the
 * "From catalog" picker can prefill the form directly — the same prefill shape
 * the "Clone existing" path uses.
 *
 * Templates stay entity-agnostic (no `sources` SQL, no entity binding): the
 * user picks the entity and schedule in the form. Override or replace these by
 * pointing `LOBU_CATALOG_URIS` at your own `watchers.json` manifest (env wins
 * outright — there is no merge with these defaults).
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
				"Review the activity in this window and produce a concise summary of what matters most. Call out anything notable, surprising, or worth acting on.\n",
			extraction_schema: {
				type: "object",
				required: ["summary", "highlights"],
				properties: {
					summary: {
						type: "string",
						description: "Short narrative summary of the window.",
					},
					highlights: {
						type: "array",
						items: { type: "string" },
						description: "Bullet-point list of the most important items.",
					},
				},
				additionalProperties: false,
			},
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
				"Analyze the overall sentiment of the activity in this window. Classify it, score it, and explain the main drivers behind the sentiment.\n",
			extraction_schema: {
				type: "object",
				required: ["sentiment", "score", "drivers"],
				properties: {
					sentiment: {
						type: "string",
						enum: ["positive", "neutral", "negative"],
						description: "Overall sentiment classification.",
					},
					score: {
						type: "number",
						description: "Sentiment score from -1 (negative) to 1 (positive).",
					},
					drivers: {
						type: "array",
						items: { type: "string" },
						description: "Key factors driving the sentiment.",
					},
				},
				additionalProperties: false,
			},
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
				"Inspect the activity in this window for anomalies, risks, or anything that deviates from the norm. Assess the risk level and recommend whether action is needed.\n",
			extraction_schema: {
				type: "object",
				required: ["risk_level", "anomalies", "recommended_action"],
				properties: {
					risk_level: {
						type: "string",
						enum: ["low", "medium", "high"],
						description: "Overall risk level for this window.",
					},
					anomalies: {
						type: "array",
						items: { type: "string" },
						description: "Specific anomalies or risks detected.",
					},
					recommended_action: {
						type: "string",
						description: "What, if anything, should be done about it.",
					},
				},
				additionalProperties: false,
			},
			reactions_guidance:
				"Only alert when risk_level is high, or medium with a concrete recommended_action. Keep low-risk windows silent.",
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
				"Extract every actionable task, follow-up, or commitment mentioned in this window. Capture who owns it and any due date if stated.\n",
			extraction_schema: {
				type: "object",
				required: ["action_items"],
				properties: {
					action_items: {
						type: "array",
						items: {
							type: "object",
							required: ["title"],
							properties: {
								title: {
									type: "string",
									description: "The action to take.",
								},
								owner: {
									type: "string",
									description: "Who is responsible, if known.",
								},
								due: {
									type: "string",
									description: "Due date or timeframe, if stated.",
								},
							},
							additionalProperties: false,
						},
					},
				},
				additionalProperties: false,
			},
			tags: ["tasks", "action-items"],
		},
	},
];
