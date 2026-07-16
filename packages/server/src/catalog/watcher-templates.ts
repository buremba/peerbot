import type { CatalogEntry } from "./types";

/**
 * Bundled default watcher templates served by the global catalog
 * (`GET /catalog?kinds=watchers`) when `LOBU_CATALOG_URIS` is unset. Each
 * entry's `detail` mirrors the watcher create-form fields (snake_case) so the
 * "From catalog" picker can prefill the form directly — the same prefill shape
 * the "Clone existing" path uses.
 *
 * Most templates are entity-agnostic, so the user picks the entity and schedule
 * in the form. Specialized templates may include portable `@` sources and a
 * reaction script; an exported reaction input schema then governs extraction.
 * Override or replace these by pointing `LOBU_CATALOG_URIS` at your own
 * `watchers.json` manifest (env wins outright — there is no merge with these
 * defaults).
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
	{
		id: "duplicate-merge",
		name: "Duplicate entity merge",
		version: "2.0.0",
		description:
			"Find entities that are the same real-world thing and fold duplicates into one canonical record.",
		detail: {
			slug: "duplicate-merge",
			schedule: "0 3 * * *",
			// A cross-entity watcher: its source surfaces people rather than events.
			// The model explains ambiguous cases; the reaction deterministically groups
			// exact shared identity values. Groups beyond the merge API or reaction SDK
			// limits are left unapplied for the model to flag for manual review.
			sources: [{ name: "people", query: "@entity:person" }],
			prompt:
				"Review every row in sources.people. Explain exact shared email or phone groups in analysis_summary. Put name-only, alias-only, or handle-only matches, identity components larger than 26 people, and sources with more than 199 mergeable components in uncertain_groups with why. Aliases and handles lack connector namespaces here, so they are not automatic merge evidence. Do not call entity tools or emit backlog tasks. The deterministic reaction independently creates one pending human approval for every exact email or phone component of at most 26 people. It fails before queuing approvals when more than 199 components need merging, and no merge happens before approval.\n",
			reaction_script: `export const input = {
	type: "object",
	properties: {
		analysis_summary: { type: "string" },
		uncertain_groups: { type: "array", items: { type: "object" } },
	},
	required: ["analysis_summary", "uncertain_groups"],
	additionalProperties: false,
};

const MAX_MERGE_COMPONENTS = 199;

function asValues(value) {
	if (value == null) return [];
	return Array.isArray(value) ? value : [value];
}

function normalizeIdentity(kind, value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (kind === "phone") {
		if (!/^[+()0-9 .-]+$/.test(trimmed)) return null;
		const digits = trimmed.replace(/[^0-9]/g, "");
		return digits.length >= 7 && digits.length <= 15 ? digits : null;
	}
	const email = trimmed.toLowerCase();
	const at = email.indexOf("@");
	if (email.length > 512 || at <= 0 || at === email.length - 1) return null;
	if (email.indexOf("@", at + 1) !== -1 || /\\s/.test(email)) return null;
	return email.slice(at + 1).includes(".") ? email : null;
}

function entityIdentities(entity) {
	const metadata = entity && typeof entity.metadata === "object" && entity.metadata
		? entity.metadata
		: {};
	const identities = new Map();
	const add = (kind, value) => {
		const identifier = normalizeIdentity(kind, value);
		if (identifier) identities.set(kind + ":" + identifier, { kind, identifier });
	};
	for (const value of [...asValues(metadata.email), ...asValues(metadata.emails)]) add("email", value);
	for (const value of [...asValues(metadata.phone), ...asValues(metadata.phones)]) add("phone", value);
	return [...identities.values()];
}

function populatedFieldCount(entity) {
	const metadata = entity && typeof entity.metadata === "object" && entity.metadata
		? entity.metadata
		: {};
	return Object.values(metadata).filter((value) => {
		if (value == null || value === "") return false;
		return !Array.isArray(value) || value.length > 0;
	}).length;
}

export default async function reaction(ctx, client) {
	const since = String(ctx.window.window_start).slice(0, 10);
	const until = new Date(new Date(ctx.window.window_end).getTime() - 1).toISOString().slice(0, 10);
	const knowledge = await client.knowledge.read({ watcher_id: ctx.window.watcher_id, since, until });
	const candidates = Array.isArray(knowledge?.sources?.people) ? knowledge.sources.people : [];
	const entities = new Map();
	const parent = new Map();
	const ownersByIdentity = new Map();
	const find = (id) => {
		let root = parent.get(id);
		while (root !== parent.get(root)) root = parent.get(root);
		let current = id;
		while (parent.get(current) !== root) {
			const next = parent.get(current);
			parent.set(current, root);
			current = next;
		}
		return root;
	};
	const union = (left, right) => {
		const leftRoot = find(left);
		const rightRoot = find(right);
		if (leftRoot === rightRoot) return false;
		parent.set(Math.max(leftRoot, rightRoot), Math.min(leftRoot, rightRoot));
		return true;
	};

	for (const candidate of candidates) {
		const id = Number(candidate?.id);
		if (!Number.isInteger(id)) continue;
		entities.set(id, candidate);
		parent.set(id, id);
	}
	for (const [id, entity] of entities) {
		for (const identity of entityIdentities(entity)) {
			const key = identity.kind + ":" + identity.identifier;
			const owners = ownersByIdentity.get(key) ?? new Set();
			owners.add(id);
			ownersByIdentity.set(key, owners);
		}
	}
	const evidenceIdentityKeys = [];
	for (const key of [...ownersByIdentity.keys()].sort()) {
		const owners = [...ownersByIdentity.get(key)].sort((left, right) => left - right);
		if (owners.length < 2) continue;
		// A spanning set proves the component while staying within the API's
		// 25-item evidence limit for a 26-entity merge.
		let connectsEntities = false;
		for (let index = 1; index < owners.length; index += 1) {
			if (union(owners[0], owners[index])) connectsEntities = true;
		}
		if (connectsEntities) evidenceIdentityKeys.push(key);
	}

	const components = new Map();
	for (const [id, entity] of entities) {
		const root = find(id);
		const component = components.get(root) ?? [];
		component.push(entity);
		components.set(root, component);
	}
	const orderedComponents = [...components.values()]
		.filter((component) => component.length > 1 && component.length <= 26)
		.sort((left, right) => Math.min(...left.map((row) => Number(row.id))) - Math.min(...right.map((row) => Number(row.id))));
	// knowledge.read consumes one of the sandbox's 200 SDK calls. Check before
	// writes so exceeding the remaining budget cannot leave partial approvals.
	if (orderedComponents.length > MAX_MERGE_COMPONENTS) {
		throw new Error("More than 199 identity components need merging; no approvals were queued");
	}

	for (const component of orderedComponents) {
		const componentRoot = find(Number(component[0].id));
		const evidence = [];
		for (const key of evidenceIdentityKeys) {
			const owner = ownersByIdentity.get(key).values().next().value;
			if (find(owner) !== componentRoot) continue;
			const separator = key.indexOf(":");
			evidence.push({ kind: key.slice(0, separator), identifier: key.slice(separator + 1) });
		}
		const ranked = [...component].sort((left, right) => {
			const completeness = populatedFieldCount(right) - populatedFieldCount(left);
			return completeness || Number(left.id) - Number(right.id);
		});
		await client.entities.manage({
			action: "merge",
			winner_entity_id: Number(ranked[0].id),
			duplicate_entity_ids: ranked.slice(1).map((entity) => Number(entity.id)),
			merge_evidence: evidence,
		});
	}
}`,
			reactions_guidance:
				"Treat only exact shared email or phone values as merge evidence. Report aliases, handles, names, and every other possible match as uncertain rather than guessing.",
			tags: ["identity", "deduplication", "world-model"],
		},
	},
];
