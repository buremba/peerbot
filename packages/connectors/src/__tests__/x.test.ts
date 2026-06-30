import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

// Stub @lobu/connector-sdk (it pulls in playwright) so the connector imports
// without the browser stack. Shared superset — see connector-sdk.mock.ts.
mock.module("@lobu/connector-sdk", connectorSdkMock);

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let parseBrowserSearchResponse: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let extractTweetsFromInstructions: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let finalizeSyncResult: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let buildHomeFeedTweets: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let parseUsernameFromStatusPath: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let isHomeFeedNoise: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let XConnector: any;

beforeAll(async () => {
	const mod = await import("../x");
	parseBrowserSearchResponse = mod.parseBrowserSearchResponse;
	extractTweetsFromInstructions = mod.extractTweetsFromInstructions;
	finalizeSyncResult = mod.finalizeSyncResult;
	buildHomeFeedTweets = mod.buildHomeFeedTweets;
	parseUsernameFromStatusPath = mod.parseUsernameFromStatusPath;
	isHomeFeedNoise = mod.isHomeFeedNoise;
	XConnector = mod.default;
});

// A tweet_results.result node in x.com's GraphQL shape. `restId`/`legacy` is
// what every timeline emits; `core.user_results.result` carries the author.
function tweetResult(
	restId: string,
	screenName: string,
	text: string,
	extra: Record<string, unknown> = {},
) {
	return {
		__typename: "Tweet",
		rest_id: restId,
		core: { user_results: { result: { core: { screen_name: screenName } } } },
		legacy: {
			id_str: restId,
			full_text: text,
			created_at: "Wed Jun 04 12:00:00 +0000 2025",
			favorite_count: 5,
			retweet_count: 1,
			reply_count: 2,
			quote_count: 0,
			conversation_id_str: restId,
			...extra,
		},
	};
}

function wrapSearchInstructions(instructions: unknown[]) {
	return {
		data: {
			search_by_raw_query: { search_timeline: { timeline: { instructions } } },
		},
	};
}

describe("extractTweetsFromInstructions", () => {
	test("reads tweet items from TimelineAddEntries", () => {
		const instructions = [
			{
				entries: [
					{
						entryId: "tweet-100",
						content: {
							itemContent: {
								tweet_results: {
									result: tweetResult("100", "alice", "hello world"),
								},
							},
						},
					},
					{
						entryId: "tweet-101",
						content: {
							itemContent: {
								tweet_results: { result: tweetResult("101", "bob", "second") },
							},
						},
					},
					// A cursor entry — must be ignored, not crash.
					{
						entryId: "cursor-top-abc",
						content: { entryType: "TimelineTimelineCursor" },
					},
				],
			},
		];

		const tweets = extractTweetsFromInstructions(instructions);
		expect(tweets).toHaveLength(2);
		expect(tweets[0]).toMatchObject({
			id: "100",
			username: "alice",
			text: "hello world",
			promoted: false,
		});
		expect(tweets[1]).toMatchObject({ id: "101", username: "bob" });
	});

	test("drops promoted tweets (entryId prefix AND promotedMetadata)", () => {
		const instructions = [
			{
				entries: [
					{
						entryId: "promoted-tweet-200",
						content: {
							itemContent: {
								tweet_results: {
									result: tweetResult("200", "adbrand", "buy now"),
								},
							},
						},
					},
					{
						entryId: "tweet-201",
						content: {
							itemContent: {
								tweet_results: {
									result: {
										...tweetResult("201", "realbrand", "genuine"),
										promotedMetadata: { advertiser: "x" },
									},
								},
							},
						},
					},
					{
						entryId: "tweet-202",
						content: {
							itemContent: {
								tweet_results: {
									result: tweetResult("202", "carol", "keep me"),
								},
							},
						},
					},
				],
			},
		];

		const tweets = extractTweetsFromInstructions(instructions);
		expect(tweets.map((t: any) => t.id)).toEqual(["202"]);
	});

	test("unwraps TweetWithVisibilityResults and conversation modules", () => {
		const instructions = [
			{
				entries: [
					{
						// A visibility-limited tweet nests the real node under .tweet.
						entryId: "tweet-300",
						content: {
							itemContent: {
								tweet_results: {
									result: {
										__typename: "TweetWithVisibilityResults",
										tweet: tweetResult("300", "dave", "limited"),
									},
								},
							},
						},
					},
					{
						// A conversation thread module: root + one threaded reply.
						entryId: "conversationthread-400",
						content: {
							items: [
								{
									item: {
										itemContent: {
											tweet_results: {
												result: tweetResult("400", "eve", "root"),
											},
										},
									},
								},
								{
									item: {
										itemContent: {
											tweet_results: {
												result: tweetResult("401", "frank", "reply"),
											},
										},
									},
								},
							],
						},
					},
				],
			},
		];

		const tweets = extractTweetsFromInstructions(instructions);
		expect(tweets.map((t: any) => t.id).sort()).toEqual(["300", "400", "401"]);
	});
});

describe("parseBrowserSearchResponse", () => {
	test("reads search_by_raw_query instructions", () => {
		const json = wrapSearchInstructions([
			{
				entries: [
					{
						entryId: "tweet-1",
						content: {
							itemContent: {
								tweet_results: {
									result: tweetResult("1", "alice", "search hit"),
								},
							},
						},
					},
				],
			},
		]);
		const tweets = parseBrowserSearchResponse("https://x.com/search?q=x", json);
		expect(tweets).toHaveLength(1);
		expect(tweets[0]).toMatchObject({
			id: "1",
			username: "alice",
			text: "search hit",
		});
	});

	test("returns [] for an unrelated response shape", () => {
		expect(parseBrowserSearchResponse("https://x.com/", { data: {} })).toEqual(
			[],
		);
	});
});

describe("finalizeSyncResult", () => {
	test("dedupes by id, sorts newest-first, advances checkpoint to newest", () => {
		const tweets = [
			{
				id: "3",
				text: "c",
				username: "a",
				publishedAt: new Date("2025-06-03T00:00:00Z"),
			},
			{
				id: "1",
				text: "a",
				username: "a",
				publishedAt: new Date("2025-06-01T00:00:00Z"),
			},
			{
				id: "3",
				text: "c-dupe",
				username: "a",
				publishedAt: new Date("2025-06-03T00:00:00Z"),
			},
			{
				id: "2",
				text: "b",
				username: "a",
				publishedAt: new Date("2025-06-02T00:00:00Z"),
			},
		];
		const res = finalizeSyncResult(tweets as any, {}, { backend: "extension" });

		expect(res.events.map((e: any) => e.origin_id)).toEqual(["3", "2", "1"]);
		expect(res.checkpoint).toMatchObject({ last_tweet_id: "3" });
		expect(res.metadata).toMatchObject({
			items_found: 3,
			items_skipped: 1,
			backend: "extension",
		});
	});

	test("drops the tweet equal to the checkpoint boundary", () => {
		const tweets = [
			{
				id: "5",
				text: "seen",
				username: "a",
				publishedAt: new Date("2025-06-05T00:00:00Z"),
			},
		];
		const res = finalizeSyncResult(tweets as any, { last_tweet_id: "5" }, {});
		expect(res.events).toHaveLength(0);
		expect(res.checkpoint.last_tweet_id).toBe("5");
	});

	test("preserves prior checkpoint when nothing new was emitted", () => {
		const res = finalizeSyncResult(
			[],
			{ last_tweet_id: "7", last_timestamp: "old" },
			{},
		);
		expect(res.checkpoint).toMatchObject({
			last_tweet_id: "7",
			last_timestamp: "old",
		});
	});
});

describe("parseUsernameFromStatusPath", () => {
	test("extracts handle from a status permalink", () => {
		expect(parseUsernameFromStatusPath("/alice/status/100")).toBe("alice");
		expect(parseUsernameFromStatusPath("https://x.com/bob/status/200")).toBe(
			"bob",
		);
		expect(parseUsernameFromStatusPath("")).toBe("");
	});
});

describe("isHomeFeedNoise", () => {
	test("drops empty, short, and promoted rows", () => {
		expect(isHomeFeedNoise("")).toBe(true);
		expect(isHomeFeedNoise("hi")).toBe(true);
		expect(
			isHomeFeedNoise("Promoted · buy this thing now with extra words"),
		).toBe(true);
		expect(
			isHomeFeedNoise("A genuine tweet with enough body to pass the filter"),
		).toBe(false);
	});
});

describe("buildHomeFeedTweets", () => {
	test("maps cs_scrape rows to tweets with ids and usernames", () => {
		const tweets = buildHomeFeedTweets([
			{
				id: "100",
				body: "hello from the home timeline",
				status_path: "/alice/status/100",
				published_at: "2026-06-30T18:41:53.000Z",
			},
			{
				id: "101",
				body: "Promoted · skip me",
				status_path: "/ad/status/101",
			},
		]);
		expect(tweets).toHaveLength(1);
		expect(tweets[0]).toMatchObject({
			id: "100",
			text: "hello from the home timeline",
			username: "alice",
		});
	});
});

describe("XConnector definition", () => {
	test("declares both the search feed and the extension-only home timeline feed", () => {
		const def = new XConnector().definition;
		expect(def.key).toBe("x");
		expect(Object.keys(def.feeds).sort()).toEqual(["home_feed", "tweets"]);
		expect(def.feeds.home_feed.description).toMatch(/home timeline/i);
		// Extension is the browser fallback method (no public API for the timeline).
		const browserMethod = def.authSchema.methods.find(
			(m: any) => m.type === "browser",
		);
		expect(browserMethod).toBeDefined();
	});
});

describe("XConnector home_feed", () => {
	test("declares a home_feed feed with no required search fields", () => {
		const def = new XConnector().definition;
		expect(def.feeds.home_feed).toBeDefined();
		expect(def.feeds.home_feed.configSchema.required).toBeUndefined();
	});

	test("syncHomeFeed dispatches cs_scrape and maps rows to events", async () => {
		const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
		const dispatcher = {
			dispatch: async (action: string, input: Record<string, unknown>) => {
				calls.push({ action, input });
				return {
					tab_id: 1,
					cs_scrape: true,
					result: {
						loggedIn: true,
						rows: [
							{
								id: "111",
								body: "first tweet on my timeline",
								status_path: "/alice/status/111",
								published_at: "2026-06-30T12:00:00.000Z",
							},
							{
								id: "222",
								body: "second tweet on my timeline",
								status_path: "/bob/status/222",
								published_at: "2026-06-30T11:00:00.000Z",
							},
						],
					},
				};
			},
		};

		const connector = new XConnector();
		const ctx = {
			feedKey: "home_feed",
			config: { max_scrolls: 4 },
			checkpoint: {},
			sessionState: { chrome_dispatcher: dispatcher },
		};
		const res = await connector.sync(ctx);

		expect(calls).toHaveLength(1);
		expect(calls[0].action).toBe("navigate");
		expect(calls[0].input.cs_scrape).toBe(true);
		expect(calls[0].input.persistent).toBe(true);
		expect(calls[0].input.url).toBe("https://x.com/home");
		expect(
			(calls[0].input.scrape_config as { scroll: { max: number } }).scroll.max,
		).toBe(4);

		expect(res.events).toHaveLength(2);
		expect(res.events[0].origin_id).toBe("111");
		expect(res.events[1].origin_id).toBe("222");
		expect(res.metadata.backend).toBe("extension-cs-scrape");
	});

	test("throws a clear error when not logged into X", async () => {
		const dispatcher = {
			dispatch: async () => ({ result: { loggedIn: false, rows: [] } }),
		};
		const connector = new XConnector();
		const ctx = {
			feedKey: "home_feed",
			config: {},
			checkpoint: {},
			sessionState: { chrome_dispatcher: dispatcher },
		};
		await expect(connector.sync(ctx)).rejects.toThrow(/Not logged into X/);
	});
});
