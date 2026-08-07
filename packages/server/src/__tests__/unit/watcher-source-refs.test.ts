import { sqlRefPath } from "@lobu/core/refs";
import { describe, expect, it } from "bun:test";
import {
	behaviorSourcesFromPrompt,
	mergePromptSources,
	normalizeWatcherSources,
	parseWatcherSourceRef,
	validateWatcherSourceRef,
	watcherSourceKindForRef,
} from "../../watchers/source-refs";

// `sqlRefPath` is imported, not re-implemented. This file used to carry its own
// copy of the encoder "mirroring owletto" — a fourth transcription of the same
// codec, and one that could drift from the thing under test without failing.

describe("watcher source refs", () => {
	it("parses event-backed refs", () => {
		expect(parseWatcherSourceRef("@feed:support")).toEqual({
			type: "feed",
			value: "support",
		});
		expect(parseWatcherSourceRef("@connection:gmail")).toEqual({
			type: "connection",
			value: "gmail",
		});
		expect(parseWatcherSourceRef("@connector:slack")).toEqual({
			type: "connector",
			value: "slack",
		});
		expect(parseWatcherSourceRef("@channel:#support")).toEqual({
			type: "channel",
			value: "#support",
		});
	});

	it("parses entity and metric refs as context sources", () => {
		const entity = parseWatcherSourceRef("@entity:customer");
		const metric = parseWatcherSourceRef("@metric:customer.retention");

		expect(entity).toEqual({ type: "entity", value: "customer" });
		expect(metric).toEqual({
			type: "metric",
			entityType: "customer",
			measure: "retention",
		});
		expect(watcherSourceKindForRef(entity)).toBe("entity");
		expect(watcherSourceKindForRef(metric)).toBe("metric");
	});

	it("leaves raw SQL alone", () => {
		expect(parseWatcherSourceRef("SELECT id FROM events")).toBeNull();
		expect(validateWatcherSourceRef("content", "SELECT id FROM events")).toBeNull();
	});

	it("rejects unsupported or unsafe refs", () => {
		expect(() => parseWatcherSourceRef("@metric:customer")).toThrow(/metric/i);
		expect(() => parseWatcherSourceRef("@entity:bad.slug")).toThrow(/slug/i);
		expect(() => parseWatcherSourceRef("@feed:support';DROP")).toThrow(
			/unsupported characters/i,
		);
		expect(() => validateWatcherSourceRef("x", "@unknown:y")).toThrow(
			/unsupported/i,
		);
	});
});

describe("behaviorSourcesFromPrompt", () => {
	it("derives @mode:id sources from feed/connection/connector/metric tokens", () => {
		const prompt =
			"summarize @[feed:issues:GitHub Issues](/o/x) and " +
			"@[connection:7:Slack](/o/y) and @[metric:company.churn:Churn](/o/z)";
		expect(behaviorSourcesFromPrompt(prompt)).toEqual([
			{ name: "github_issues", query: "@feed:issues" },
			{ name: "slack", query: "@connection:7" },
			{ name: "churn", query: "@metric:company.churn" },
		]);
	});

	it("derives an @entity: source from an entity_type token", () => {
		// The underscore in the kind is the load-bearing part: PROMPT_REF_TOKEN's
		// kind group must allow it, or this token does not match at all and the
		// source silently vanishes instead of erroring.
		const prompt = "review @[entity_type:company:Companies](/o/company)";
		expect(behaviorSourcesFromPrompt(prompt)).toEqual([
			{ name: "companies", query: "@entity:company" },
		]);
	});

	it("keeps entity_type (a type) and entity (an instance) apart", () => {
		// Both would compile through mode `entity`, but only the type slug is a
		// legal `@entity:` value — an instance id there would resolve to nothing.
		const prompt =
			"for @[entity:42:Spotify](/o/company/spotify) review " +
			"@[entity_type:company:Companies](/o/company)";
		expect(behaviorSourcesFromPrompt(prompt)).toEqual([
			{ name: "companies", query: "@entity:company" },
		]);
	});

	it("excludes entity tokens (scope, not source)", () => {
		const prompt =
			"for @[entity:42:Spotify](/o/company/spotify) watch @[feed:k:Feed](/o/x)";
		expect(behaviorSourcesFromPrompt(prompt)).toEqual([
			{ name: "feed", query: "@feed:k" },
		]);
	});

	it("recovers a sql token's raw query from its inline #sql= path", () => {
		const query = "SELECT id FROM events WHERE ts > now() - interval '7 days'";
		const prompt = `run @[sql:recent:Recent events](${sqlRefPath(query)})`;
		expect(behaviorSourcesFromPrompt(prompt)).toEqual([
			{ name: "recent_events", query },
		]);
	});

	it("de-dupes by query and makes duplicate names unique", () => {
		const prompt =
			"@[feed:k1:Issues](/o/a) @[feed:k1:Issues again](/o/a) " +
			"@[feed:k2:Issues](/o/b)";
		const out = behaviorSourcesFromPrompt(prompt);
		expect(out).toEqual([
			{ name: "issues", query: "@feed:k1" },
			{ name: "issues_2", query: "@feed:k2" },
		]);
	});

	it("returns [] for a prompt with no source tokens", () => {
		expect(behaviorSourcesFromPrompt("just plain instructions")).toEqual(
			[],
		);
	});
});

describe("mergePromptSources", () => {
	it("keeps explicit sources and appends prompt sources, de-duping by query", () => {
		const explicit = [{ name: "content", query: "@feed:issues" }];
		const fromPrompt = [
			{ name: "issues", query: "@feed:issues" }, // dupe query → dropped
			{ name: "slack", query: "@connection:7" },
		];
		expect(mergePromptSources(explicit, fromPrompt)).toEqual([
			{ name: "content", query: "@feed:issues" },
			{ name: "slack", query: "@connection:7" },
		]);
	});

	it("suffixes a prompt source whose name collides with an explicit one", () => {
		const explicit = [{ name: "slack", query: "@feed:a" }];
		const fromPrompt = [{ name: "slack", query: "@connection:7" }];
		expect(mergePromptSources(explicit, fromPrompt)).toEqual([
			{ name: "slack", query: "@feed:a" },
			{ name: "slack_2", query: "@connection:7" },
		]);
	});
});

describe("normalizeWatcherSources source.context classification", () => {
	// A no-ref SQL source never touches the DB in normalizeWatcherSources, so a
	// stub sql client is enough — it must not be called for these cases.
	const sql = (() => {
		throw new Error("sql should not be called for no-ref SQL sources");
	}) as never;

	it("classifies a plain SQL source as event content (id must be an events.id)", async () => {
		const [normalized] = await normalizeWatcherSources(sql, "org", [
			{ name: "window", query: "SELECT id FROM events WHERE 1=0" },
		]);
		expect(normalized.kind).toBe("event");
	});

	it("classifies a context:true SQL source as entity context (no events FK)", async () => {
		const [normalized] = await normalizeWatcherSources(sql, "org", [
			{
				name: "candidates",
				query: "SELECT id, name FROM entities WHERE entity_type='person'",
				context: true,
			},
		]);
		// kind:'entity' means its rows reach the agent but are excluded from the
		// window's content_ids (see behavior-mode allContent), so the entity `id`
		// never hits the watcher_window_events → events(id) foreign key.
		expect(normalized.kind).toBe("entity");
	});

	it("context:false stays event content", async () => {
		const [normalized] = await normalizeWatcherSources(sql, "org", [
			{ name: "window", query: "SELECT id FROM events", context: false },
		]);
		expect(normalized.kind).toBe("event");
	});
});
