import { describe, expect, it } from "bun:test";
import {
	extractSourcesFromPromptTokens,
	mergePromptSources,
	parseWatcherSourceRef,
	validateWatcherSourceRef,
	watcherSourceKindForRef,
} from "../../watchers/source-refs";

/** Mirror of owletto's sqlRefPath: encode the query, additionally escaping the
 *  sub-delims encodeURIComponent leaves raw ( ) ' ! * ~ so the token parses. */
function sqlRefPath(query: string): string {
	return `#sql=${encodeURIComponent(query).replace(
		/[()'!*~]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	)}`;
}

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

describe("extractSourcesFromPromptTokens", () => {
	it("derives @mode:id sources from feed/connection/connector/metric tokens", () => {
		const prompt =
			"summarize @[feed:issues:GitHub Issues](/o/x) and " +
			"@[connection:7:Slack](/o/y) and @[metric:company.churn:Churn](/o/z)";
		expect(extractSourcesFromPromptTokens(prompt)).toEqual([
			{ name: "github_issues", query: "@feed:issues" },
			{ name: "slack", query: "@connection:7" },
			{ name: "churn", query: "@metric:company.churn" },
		]);
	});

	it("excludes entity tokens (scope, not source)", () => {
		const prompt =
			"for @[entity:42:Spotify](/o/company/spotify) watch @[feed:k:Feed](/o/x)";
		expect(extractSourcesFromPromptTokens(prompt)).toEqual([
			{ name: "feed", query: "@feed:k" },
		]);
	});

	it("recovers a sql token's raw query from its inline #sql= path", () => {
		const query = "SELECT id FROM events WHERE ts > now() - interval '7 days'";
		const prompt = `run @[sql:recent:Recent events](${sqlRefPath(query)})`;
		expect(extractSourcesFromPromptTokens(prompt)).toEqual([
			{ name: "recent_events", query },
		]);
	});

	it("de-dupes by query and makes duplicate names unique", () => {
		const prompt =
			"@[feed:k1:Issues](/o/a) @[feed:k1:Issues again](/o/a) " +
			"@[feed:k2:Issues](/o/b)";
		const out = extractSourcesFromPromptTokens(prompt);
		expect(out).toEqual([
			{ name: "issues", query: "@feed:k1" },
			{ name: "issues_2", query: "@feed:k2" },
		]);
	});

	it("returns [] for a prompt with no source tokens", () => {
		expect(extractSourcesFromPromptTokens("just plain instructions")).toEqual(
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
