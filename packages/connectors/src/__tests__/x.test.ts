import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

// Stub @lobu/connector-sdk (it pulls in playwright) so the connector imports
// without the browser stack. Shared superset — see connector-sdk.mock.ts.
mock.module("@lobu/connector-sdk", connectorSdkMock);

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let parseBrowserSearchResponse: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let parseBrowserTimelineResponse: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let extractTweetsFromInstructions: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let finalizeSyncResult: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let finalizeDmSyncResult: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let buildHomeFeedTweets: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let parseUsernameFromStatusPath: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let isHomeFeedNoise: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let parseBrowserDmResponse: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let XConnector: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let normalizeXPostUrl: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let isReplySubmitLabel: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let isXAuthWall: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let prepareXReply: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let truncateHandoffReason: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let buildInjectHandoffBannerExpression: any;

beforeAll(async () => {
	const mod = await import("../x");
	parseBrowserSearchResponse = mod.parseBrowserSearchResponse;
	parseBrowserTimelineResponse = mod.parseBrowserTimelineResponse;
	parseBrowserDmResponse = mod.parseBrowserDmResponse;
	extractTweetsFromInstructions = mod.extractTweetsFromInstructions;
	finalizeSyncResult = mod.finalizeSyncResult;
	finalizeDmSyncResult = mod.finalizeDmSyncResult;
	buildHomeFeedTweets = mod.buildHomeFeedTweets;
	parseUsernameFromStatusPath = mod.parseUsernameFromStatusPath;
	isHomeFeedNoise = mod.isHomeFeedNoise;
	XConnector = mod.default;
	normalizeXPostUrl = mod.normalizeXPostUrl;
	isReplySubmitLabel = mod.isReplySubmitLabel;
	isXAuthWall = mod.isXAuthWall;
	prepareXReply = mod.prepareXReply;
	truncateHandoffReason = mod.truncateHandoffReason;
	buildInjectHandoffBannerExpression = mod.buildInjectHandoffBannerExpression;
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

describe("parseBrowserTimelineResponse", () => {
	test("reads profile and bookmark timeline instructions", () => {
		const instructions = [
			{
				entries: [
					{
						entryId: "tweet-9",
						content: {
							itemContent: {
								tweet_results: {
									result: tweetResult("9", "alice", "profile tweet"),
								},
							},
						},
					},
				],
			},
		];

		const profile = parseBrowserTimelineResponse("https://x.com/alice", {
			data: { user: { result: { timeline_v2: { timeline: { instructions } } } } },
		});
		expect(profile).toHaveLength(1);
		expect(profile[0]).toMatchObject({ id: "9", username: "alice" });

		const bookmarks = parseBrowserTimelineResponse("https://x.com/i/bookmarks", {
			data: { bookmark_timeline_v2: { timeline: { instructions } } },
		});
		expect(bookmarks).toHaveLength(1);
		expect(bookmarks[0].text).toBe("profile tweet");
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

	test("can stamp a custom origin_type for liked posts and bookmarks", () => {
		const tweets = [
			{
				id: "9",
				text: "liked",
				username: "alice",
				publishedAt: new Date("2025-06-01T00:00:00Z"),
			},
		];
		const liked = finalizeSyncResult(tweets as any, {}, {}, {
			originType: "liked_tweet",
		});
		expect(liked.events[0].origin_type).toBe("liked_tweet");

		const bookmarked = finalizeSyncResult(tweets as any, {}, {}, {
			originType: "bookmark",
		});
		expect(bookmarked.events[0].origin_type).toBe("bookmark");
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
	test("declares search, account, and extension-only home timeline feeds", () => {
		const def = new XConnector().definition;
		expect(def.key).toBe("x");
		expect(Object.keys(def.feeds).sort()).toEqual([
			"bookmarks",
			"direct_messages",
			"home_feed",
			"liked_tweets",
			"my_tweets",
			"tweets",
		]);
		expect(def.feeds.direct_messages.requiredScopes).toBeUndefined();
		expect(
			def.feeds.tweets.eventKinds.tweet.attributions?.[0]?.target.identities?.map(
				(i: { namespace: string }) => i.namespace,
			),
		).toEqual(["x_user_id", "x_handle"]);
		expect(def.feeds.tweets.eventKinds.tweet.attributions?.[0]).toMatchObject({
			role: "authored_by",
			target: { entityType: "person" },
		});
		expect(def.feeds.direct_messages.eventKinds.dm_message.attributions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "authored_by" }),
				expect.objectContaining({ role: "about" }),
			]),
		);
		expect(def.feeds.liked_tweets.requiredScopes).toBeUndefined();
		expect(def.feeds.bookmarks.requiredScopes).toBeUndefined();
		expect(def.feeds.home_feed.description).toMatch(/home timeline/i);
		// Extension is the browser fallback method (no public API for the timeline).
		const browserMethod = def.authSchema.methods.find(
			(m: any) => m.type === "browser",
		);
		expect(browserMethod).toBeDefined();
	});
});

describe("parseBrowserDmResponse", () => {
	test("extracts DM messages from inbox timeline entries", () => {
		const messages = parseBrowserDmResponse("https://x.com/messages", {
			data: {
				viewer_v2: {
					user_results: { result: { rest_id: "999" } },
				},
				user_events: {
					timeline: {
						instructions: [
							{
								entries: [
									{
										content: {
											message: {
												id: "dm-1",
												conversation_id: "111-999",
												message_data: {
													text: "hey there",
													time: "Wed Jun 04 12:00:00 +0000 2025",
													sender_id: "111",
													sender_screen_name: "alice",
													sender_name: "Alice",
												},
											},
										},
									},
								],
							},
						],
					},
				},
			},
		});

		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			id: "dm-1",
			text: "hey there",
			senderId: "111",
			senderHandle: "alice",
			fromMe: false,
			participantId: "111",
			participantHandle: "alice",
		});
	});
});

describe("XConnector browser-first routing", () => {
	test("uses extension for bookmarks when OAuth lacks bookmark.read", async () => {
		const calls: Array<{ action: string; input: Record<string, unknown> }> =
			[];
		const dispatcher = {
			dispatch: async (action: string, input: Record<string, unknown>) => {
				calls.push({ action, input });
				return {
					result: {
						responses: [
							{
								body: JSON.stringify({
									data: {
										bookmark_timeline_v2: {
											timeline: { instructions: [] },
										},
									},
								}),
							},
						],
					},
				};
			},
		};

		const connector = new XConnector();
		const res = await connector.sync({
			feedKey: "bookmarks",
			config: {},
			checkpoint: {},
			credentials: {
				provider: "twitter",
				accessToken: "token-without-bookmark-scope",
				scope: "users.read tweet.read offline.access",
			},
			entityIds: [],
			sessionState: { chrome_dispatcher: dispatcher },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].input.url).toBe("https://x.com/i/bookmarks");
		expect(res.metadata.backend).toBe("extension-network");
	});

	test("honors use_extension even when OAuth scopes are sufficient", async () => {
		const calls: Array<{ action: string; input: Record<string, unknown> }> =
			[];
		const dispatcher = {
			dispatch: async (action: string, input: Record<string, unknown>) => {
				calls.push({ action, input });
				return { result: { responses: [] } };
			},
		};

		const connector = new XConnector();
		await connector.sync({
			feedKey: "my_tweets",
			config: { use_extension: "true", account_handle: "buremba" },
			checkpoint: {},
			credentials: {
				provider: "twitter",
				accessToken: "token-with-full-scope",
				scope: "users.read tweet.read offline.access",
			},
			entityIds: [],
			sessionState: { chrome_dispatcher: dispatcher },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].input.url).toBe("https://x.com/buremba");
	});

	test("uses extension for direct_messages when OAuth lacks dm.read", async () => {
		const calls: Array<{ action: string; input: Record<string, unknown> }> =
			[];
		const dispatcher = {
			dispatch: async (action: string, input: Record<string, unknown>) => {
				calls.push({ action, input });
				return { result: { responses: [] } };
			},
		};

		const connector = new XConnector();
		await connector.sync({
			feedKey: "direct_messages",
			config: {},
			checkpoint: {},
			credentials: {
				provider: "twitter",
				accessToken: "token-without-dm-scope",
				scope: "users.read tweet.read offline.access",
			},
			entityIds: [],
			sessionState: { chrome_dispatcher: dispatcher },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].input.url).toBe("https://x.com/messages");
	});
});

describe("finalizeDmSyncResult", () => {
	test("emits dm_message events with participant metadata", () => {
		const res = finalizeDmSyncResult(
			[
				{
					id: "9001",
					text: "hey there",
					senderId: "111",
					senderHandle: "alice",
					conversationId: "111-222",
					isGroup: false,
					fromMe: false,
					participantId: "111",
					participantHandle: "alice",
					participantName: "Alice",
					publishedAt: new Date("2025-06-01T00:00:00Z"),
				},
			],
			{},
			{ backend: "oauth_api" },
		);
		expect(res.events).toHaveLength(1);
		expect(res.events[0].origin_type).toBe("dm_message");
		expect(res.events[0].metadata).toMatchObject({
			participant_id: "111",
			participant_handle: "alice",
			from_me: false,
			is_group: false,
		});
		expect(res.checkpoint.last_dm_event_id).toBe("9001");
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
		expect(calls[0].input.persistent).toBe(false);
		expect(calls[0].input.focus).toBe(false);
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

	test("home_feed configSchema accepts min_scrolls + max_scrolls", () => {
		const props = new XConnector().definition.feeds.home_feed.configSchema
			.properties as Record<string, { type?: string }>;
		expect(props.max_scrolls?.type).toBe("integer");
		expect(props.min_scrolls?.type).toBe("integer");
	});

	test("home_feed configSchema accepts use_existing_tab", () => {
		const props = new XConnector().definition.feeds.home_feed.configSchema
			.properties as Record<string, { type?: string }>;
		expect(props.use_existing_tab?.type).toBe("boolean");
	});

	test("use_existing_tab passes existing_tab_match and reports the existing-tab backend", async () => {
		const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
		const dispatcher = {
			dispatch: async (action: string, input: Record<string, unknown>) => {
				calls.push({ action, input });
				return {
					tab_id: 1,
					cs_scrape: true,
					existing_tab: true,
					result: {
						loggedIn: true,
						rows: [
							{
								id: "111",
								body: "first tweet on my timeline",
								status_path: "/alice/status/111",
								published_at: "2026-06-30T12:00:00.000Z",
							},
						],
					},
				};
			},
		};

		const connector = new XConnector();
		const res = await connector.sync({
			feedKey: "home_feed",
			config: { max_scrolls: 4, use_existing_tab: true },
			checkpoint: {},
			sessionState: { chrome_dispatcher: dispatcher },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].input.existing_tab_match).toBe("x.com/home");
		expect(res.events).toHaveLength(1);
		expect(res.metadata.backend).toBe("extension-cs-scrape-existing-tab");
	});

	test("without use_existing_tab no existing_tab_match is sent and backend stays extension-cs-scrape", async () => {
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
						],
					},
				};
			},
		};

		const connector = new XConnector();
		const res = await connector.sync({
			feedKey: "home_feed",
			config: { max_scrolls: 4 },
			checkpoint: {},
			sessionState: { chrome_dispatcher: dispatcher },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].input.existing_tab_match).toBeUndefined();
		expect(res.metadata.backend).toBe("extension-cs-scrape");
	});

	test("min_scrolls/max_scrolls pick a scroll budget in range each run", async () => {
		const scrollMaxes: number[] = [];
		const dispatcher = {
			dispatch: async (_action: string, input: Record<string, unknown>) => {
				scrollMaxes.push(
					(input.scrape_config as { scroll: { max: number } }).scroll.max,
				);
				return {
					tab_id: 1,
					cs_scrape: true,
					result: { loggedIn: true, rows: [] },
				};
			},
		};
		const connector = new XConnector();
		const realRandom = Math.random;
		// Force mid-range pick: min + floor(0.5 * (max-min+1)) = 8 + floor(2.5) = 10
		Math.random = () => 0.5;
		try {
			await connector.sync({
				feedKey: "home_feed",
				config: { min_scrolls: 8, max_scrolls: 12 },
				checkpoint: {},
				sessionState: { chrome_dispatcher: dispatcher },
			});
		} finally {
			Math.random = realRandom;
		}
		expect(scrollMaxes).toEqual([10]);
	});

	test("omitting min_scrolls keeps a fixed max_scrolls budget", async () => {
		const scrollMaxes: number[] = [];
		const dispatcher = {
			dispatch: async (_action: string, input: Record<string, unknown>) => {
				scrollMaxes.push(
					(input.scrape_config as { scroll: { max: number } }).scroll.max,
				);
				return {
					tab_id: 1,
					cs_scrape: true,
					result: { loggedIn: true, rows: [] },
				};
			},
		};
		const connector = new XConnector();
		await connector.sync({
			feedKey: "home_feed",
			config: { max_scrolls: 7 },
			checkpoint: {},
			sessionState: { chrome_dispatcher: dispatcher },
		});
		expect(scrollMaxes).toEqual([7]);
	});
});

// ── prepare_reply ───────────────────────────────────────────────
//
// X ignores ?text= on every intent/compose URL, so typing into the composer is
// the only handoff that exists. These tests pin the two properties that matter:
// the draft lands verbatim, and nothing ever submits it.

/** A dispatcher that plays back a healthy x.com post page. */
function stagingDispatcher(
	overrides: {
		composerName?: string;
		stagedText?: string;
		currentUrl?: string;
		submitEnabled?: boolean;
		a11ySnapshots?: readonly [
			{ refId: number; documentEpoch: number },
			...Array<{ refId: number; documentEpoch: number }>,
		];
	} = {},
) {
	const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
	let typedText = "";
	let treeReadCount = 0;
	const dispatcher = {
		dispatch: async (action: string, input: Record<string, unknown>) => {
			calls.push({ action, input });
			switch (action) {
				case "navigate":
					return {
						tab_id: 42,
						current_url: overrides.currentUrl ?? (input.url as string),
					};
				case "wait_for_selector":
					return { found: true };
				case "get_accessibility_tree": {
					const snapshots =
						overrides.a11ySnapshots ??
						([{ refId: 36, documentEpoch: 3 }] as const);
					const snapshot =
						snapshots[Math.min(treeReadCount, snapshots.length - 1)];
					treeReadCount += 1;
					return {
						document_epoch: snapshot.documentEpoch,
						tree: [
							{ ref_id: 29, role: "button", name: "5 Replies. Reply" },
							{
								ref_id: snapshot.refId,
								role: "textbox",
								name: overrides.composerName ?? "Post text",
							},
						],
					};
				}
				case "type_ref":
					typedText = input.text as string;
					return { ok: true };
				case "evaluate":
					return {
						value: {
							staged_text: overrides.stagedText ?? typedText,
							submit_enabled: overrides.submitEnabled ?? true,
						},
					};
				default:
					return { ok: true };
			}
		},
	};
	return { dispatcher, calls };
}

describe("normalizeXPostUrl", () => {
	test("accepts a bare numeric tweet id (the origin_id on X events)", () => {
		expect(normalizeXPostUrl("2083959735481716957")).toBe(
			"https://x.com/i/web/status/2083959735481716957",
		);
	});

	test("preserves the handle from a canonical permalink", () => {
		expect(
			normalizeXPostUrl("https://x.com/boristane/status/2083959735481716957"),
		).toBe("https://x.com/boristane/status/2083959735481716957");
	});

	test("rewrites twitter.com to x.com", () => {
		expect(
			normalizeXPostUrl("https://twitter.com/paulg/status/2083929305630089297"),
		).toBe("https://x.com/paulg/status/2083929305630089297");
	});

	test("rejects a non-status URL rather than navigating somewhere arbitrary", () => {
		expect(normalizeXPostUrl("https://x.com/home")).toBeNull();
		expect(normalizeXPostUrl("https://evil.example/status/123456")).toBeNull();
		expect(normalizeXPostUrl("")).toBeNull();
	});
});

describe("isXAuthWall", () => {
	test("matches the pages X bounces a signed-out session to", () => {
		for (const url of [
			"https://x.com/login",
			"https://x.com/i/flow/login",
			"https://x.com/i/flow/login?redirect_after_login=%2Fhome",
			"https://x.com/i/flow/signup",
			"https://x.com/account/access",
		]) {
			expect(isXAuthWall(url)).toBe(true);
		}
	});

	// @LoginRadius is a real account. A substring test reads its permalink as an
	// auth wall and kills the run on a signed-in page.
	test("does not mistake a handle that starts with 'login' for the login page", () => {
		expect(isXAuthWall("https://x.com/LoginRadius/status/2083959735481716957")).toBe(
			false,
		);
		expect(isXAuthWall("https://x.com/LoginRadius")).toBe(false);
		expect(isXAuthWall("https://x.com/i/web/status/2083959735481716957")).toBe(
			false,
		);
		expect(isXAuthWall(undefined)).toBe(false);
	});
});

describe("isReplySubmitLabel", () => {
	test("matches the controls that would publish", () => {
		for (const label of ["Reply", "Post", "Post all", "Tweet", "send"]) {
			expect(isReplySubmitLabel(label)).toBe(true);
		}
	});

	test("does not match the composer or unrelated chrome", () => {
		for (const label of ["Post text", "5 Replies. Reply", "Reply to thread", ""]) {
			expect(isReplySubmitLabel(label)).toBe(false);
		}
	});
});

describe("prepare_reply action contract", () => {
	test("pins the connector version for catalog upgrades", () => {
		expect(new XConnector().definition.version).toBe("3.12.1");
	});

	// This is a deliberate design decision, not an oversight. Publishing is
	// guarded by X's own Reply button, which a human must click and this action
	// cannot. A Lobu approval gate would only guard "fills the open page",
	// while forcing the user to approve a draft before seeing it in context —
	// which defeats the whole review-and-iterate workflow. Do not flip this back
	// without re-reading the comment at the definition site.
	test("does not require Lobu approval — the user-opened page is the approval", () => {
		const action = new XConnector().definition.actions.prepare_reply;
		expect(action.requiresApproval).toBe(false);
		expect(action.kind).toBe("write");
	});

	test("accepts either tweet_url or tweet_id, and always a body", () => {
		const schema = new XConnector().definition.actions.prepare_reply.inputSchema;
		expect(schema.required).toEqual(["body"]);
		expect(schema.anyOf).toEqual([
			{ required: ["tweet_url"] },
			{ required: ["tweet_id"] },
		]);
		// No maxLength: X's weighted count makes a code-unit cap wrong.
		expect(schema.properties.body.maxLength).toBeUndefined();
		// The composer does not reliably paint in a background tab, so staging
		// cannot offer an option that makes the action fail before it can type.
		expect(schema.properties.focus).toBeUndefined();
	});
});

describe("prepareXReply", () => {
	test("stages the draft verbatim and never submits", async () => {
		const { dispatcher, calls } = stagingDispatcher();
		const body =
			"nintendo didn't lose because they had principles — they bet on cartridges";

		const result = await prepareXReply(dispatcher, {
			tweetUrl: "2083959735481716957",
			body,
		});

		expect(result.prepared).toBe(true);
		expect(result.submitted).toBe(false);
		expect(result.staged_text).toBe(body);
		expect(result.tweet_url).toBe(
			"https://x.com/i/web/status/2083959735481716957",
		);

		const typed = calls.find((c) => c.action === "type_ref");
		expect(typed?.input.text).toBe(body);
		expect(typed?.input.ref).toEqual({ ref_id: 36, document_epoch: 3 });

		// The only click is the one that focuses the composer.
		const clicks = calls.filter((c) => c.action === "click_ref");
		expect(clicks).toHaveLength(1);
		expect(clicks[0].input.ref).toEqual({ ref_id: 36, document_epoch: 3 });
		// The guard token is stripped before reaching the extension.
		expect(clicks[0].input.allowed_click).toBeUndefined();
		// The composer click is origin-guarded like every other dispatch here —
		// X is an SPA and can navigate away between the wait and the click.
		expect(clicks[0].input.allowed_origins).toEqual([
			"x.com",
			"*.x.com",
			"twitter.com",
			"*.twitter.com",
		]);
	});

	// X normalizes the composer content, so an NFD draft reads back as NFC. That
	// is the same text, not a staging failure.
	test("accepts a draft that X re-composes to NFC", async () => {
		const body = "cafe\u0301 chess \u1E9B\u0323";
		const { dispatcher } = stagingDispatcher({
			stagedText: body.normalize("NFC"),
		});

		const result = await prepareXReply(dispatcher, {
			tweetUrl: "2083959735481716957",
			body,
		});

		expect(result.prepared).toBe(true);
		expect(result.submitted).toBe(false);
	});

	test("errors instead of typing when no textbox is on the page", async () => {
		const { dispatcher } = stagingDispatcher();
		await expect(
			prepareXReply(
				{
					dispatch: async (action, input) => {
						if (action === "get_accessibility_tree") {
							return { document_epoch: 1, tree: [] };
						}
						return dispatcher.dispatch(action, input);
					},
				},
				{ tweetUrl: "2083959735481716957", body: "hi" },
			),
		).rejects.toThrow(/could not locate the reply composer/);
	});

	// X re-renders the timeline in place, so a ref captured before a render can
	// go stale between get_accessibility_tree and click_ref. The action must
	// re-extract and retry the click once instead of failing on a transient race.
	test("retries once when the composer click hits a stale a11y ref", async () => {
		const { dispatcher, calls } = stagingDispatcher({
			a11ySnapshots: [
				{ refId: 36, documentEpoch: 3 },
				{ refId: 47, documentEpoch: 4 },
			],
		});
		let clickAttempts = 0;
		const result = await prepareXReply(
			{
				dispatch: async (action, input) => {
					if (action === "click_ref") {
						clickAttempts += 1;
						if (clickAttempts === 1) {
							throw new Error("click_ref: stale ref (epoch 3)");
						}
					}
					return dispatcher.dispatch(action, input);
				},
			},
			{ tweetUrl: "2083959735481716957", body: "hi" },
		);

		expect(result.prepared).toBe(true);
		expect(clickAttempts).toBe(2);
		const trees = calls.filter((c) => c.action === "get_accessibility_tree");
		expect(trees).toHaveLength(2);
		const clicks = calls.filter((c) => c.action === "click_ref");
		expect(clicks).toHaveLength(1);
		const typed = calls.find((c) => c.action === "type_ref");
		expect(typed?.input.ref).toEqual({ ref_id: 47, document_epoch: 4 });
	});

	test("retries the focus and type once when typing hits a stale a11y ref", async () => {
		const { dispatcher, calls } = stagingDispatcher({
			a11ySnapshots: [
				{ refId: 36, documentEpoch: 3 },
				{ refId: 47, documentEpoch: 4 },
			],
		});
		let typeAttempts = 0;
		const result = await prepareXReply(
			{
				dispatch: async (action, input) => {
					if (action === "type_ref") {
						typeAttempts += 1;
						if (typeAttempts === 1) {
							throw new Error("type_ref: stale ref (epoch 3)");
						}
					}
					return dispatcher.dispatch(action, input);
				},
			},
			{ tweetUrl: "2083959735481716957", body: "hi" },
		);

		expect(result.prepared).toBe(true);
		expect(typeAttempts).toBe(2);
		expect(
			calls.filter((c) => c.action === "get_accessibility_tree"),
		).toHaveLength(2);
		expect(calls.filter((c) => c.action === "click_ref")).toHaveLength(2);
		const typed = calls.find((c) => c.action === "type_ref");
		expect(typed?.input.ref).toEqual({ ref_id: 47, document_epoch: 4 });
	});

	test("fails when the composer click stays stale across the retry", async () => {
		const { dispatcher } = stagingDispatcher();
		await expect(
			prepareXReply(
				{
					dispatch: async (action, input) => {
						if (action === "click_ref") {
							throw new Error("click_ref: stale ref (epoch 3)");
						}
						return dispatcher.dispatch(action, input);
					},
				},
				{ tweetUrl: "2083959735481716957", body: "hi" },
			),
		).rejects.toThrow(/stale ref/);
	});

	test("refuses when the located node is a submit control", async () => {
		const { dispatcher } = stagingDispatcher({ composerName: "Reply" });
		await expect(
			prepareXReply(dispatcher, {
				tweetUrl: "2083959735481716957",
				body: "hi",
			}),
		).rejects.toThrow(/refusing to click/);
	});

	test("fails loudly when the composer content does not match the draft", async () => {
		const { dispatcher } = stagingDispatcher({ stagedText: "half a dr" });
		await expect(
			prepareXReply(dispatcher, {
				tweetUrl: "2083959735481716957",
				body: "half a draft that got truncated",
			}),
		).rejects.toThrow(/does not match the draft/);
	});

	// X counts a URL as 23 characters however long it really is, and NFC-
	// normalizes first. A raw code-unit cap here would refuse to stage drafts X
	// accepts, so there is deliberately no pre-flight length check.
	test("stages a URL-bearing draft that exceeds 280 code units", async () => {
		const { dispatcher } = stagingDispatcher();
		const url = `https://example.com/${"path/".repeat(60)}`;
		const body = `worth a read ${url}`;
		expect(body.length).toBeGreaterThan(280);

		const result = await prepareXReply(dispatcher, {
			tweetUrl: "2083959735481716957",
			body,
		});

		expect(result.prepared).toBe(true);
		expect(result.staged_text).toBe(body);
		expect(result.submit_blocked).toBe(false);
	});

	test("stages a CJK draft rather than guessing at weighted length", async () => {
		const { dispatcher } = stagingDispatcher();
		// 200 CJK characters weigh 400 to X but are only 200 code units — the
		// mirror image of the URL case, and equally not ours to adjudicate.
		const body = "検".repeat(200);

		const result = await prepareXReply(dispatcher, {
			tweetUrl: "2083959735481716957",
			body,
		});

		expect(result.prepared).toBe(true);
		expect(result.staged_text).toBe(body);
	});

	test("reports X's own refusal via submit_blocked instead of guessing", async () => {
		const { dispatcher } = stagingDispatcher({ submitEnabled: false });

		const result = await prepareXReply(dispatcher, {
			tweetUrl: "2083959735481716957",
			body: "a draft X will not accept as written",
		});

		// Still staged — the human is looking at the tab and can trim it there.
		expect(result.prepared).toBe(true);
		expect(result.submit_blocked).toBe(true);
		expect(result.message).toMatch(/Reply disabled/);
	});

	test("still rejects an empty body without touching the browser", async () => {
		const { dispatcher, calls } = stagingDispatcher();
		await expect(
			prepareXReply(dispatcher, { tweetUrl: "2083959735481716957", body: "   " }),
		).rejects.toThrow(/must be non-empty/);
		expect(calls).toHaveLength(0);
	});

	// The a11y walker keeps only in-viewport nodes, and one image in the post is
	// enough to push X's reply composer past the fold (measured: innerHeight
	// 779, composer top 830). The extraction then finds no textbox and the run
	// dies claiming the composer does not exist, on a page that plainly has one.
	test("scrolls the composer into view BEFORE reading the accessibility tree", async () => {
		const { dispatcher, calls } = stagingDispatcher();
		await prepareXReply(dispatcher, {
			tweetUrl: "2083959735481716957",
			body: "hi",
		});
		const scrollIdx = calls.findIndex(
			(c) =>
				c.action === "evaluate" &&
				String(c.input.expression).includes("scrollIntoView"),
		);
		const treeIdx = calls.findIndex(
			(c) => c.action === "get_accessibility_tree",
		);
		expect(scrollIdx).toBeGreaterThanOrEqual(0);
		// Ordering is the whole point: scrolling after the snapshot fixes nothing.
		expect(scrollIdx).toBeLessThan(treeIdx);
		expect(String(calls[scrollIdx]?.input.expression)).toContain(
			"tweetTextarea_0",
		);
	});

	test("reports the auth wall instead of typing into a logged-out page", async () => {
		const { dispatcher } = stagingDispatcher({
			currentUrl: "https://x.com/i/flow/login",
		});
		await expect(
			prepareXReply(dispatcher, {
				tweetUrl: "2083959735481716957",
				body: "hi",
			}),
		).rejects.toThrow(/Not logged into X/);
	});
});

describe("prepare_reply page activation", () => {
	test("requires the exact user-opened page instead of selecting a browser", async () => {
		const { dispatcher, calls } = stagingDispatcher();

		await prepareXReply(dispatcher, {
			tweetUrl: "2083959735481716957",
			body: "staged only after I visit the post",
		});

		const navigate = calls.find((call) => call.action === "navigate");
		expect(navigate?.input.require_page_activation).toBe(true);
		expect(navigate?.input).not.toHaveProperty("open_in_new_tab");
		expect(navigate?.input).not.toHaveProperty("target_browser_connection_id");
	});

	test("never leaks the internal allowed_click guard token to the extension", async () => {
		const { dispatcher, calls } = stagingDispatcher();

		await prepareXReply(dispatcher, {
			tweetUrl: "2083959735481716957",
			body: "check the click payload",
		});

		const click = calls.find((c) => c.action === "click_ref");
		expect(click).toBeDefined();
		// allowed_click is the internal guard token and must still be stripped.
		expect(click?.input).not.toHaveProperty("allowed_click");
	});
});

// A draft with no reason attached is just text in a box — the "why" is most of
// what you need to accept, edit or bin it. linkedin.prepare_comment already
// injects this banner; X did not.
describe("prepare_reply handoff banner", () => {
	test("injects the reason above the composer", async () => {
		const { dispatcher, calls } = stagingDispatcher();

		const result = await prepareXReply(dispatcher, {
			tweetUrl: "2083959735481716957",
			body: "a draft",
			reason: "he is asking exactly the question your event-sourcing post answers",
		});

		const banner = calls.find(
			(c) =>
				c.action === "evaluate" &&
				String(c.input.expression).includes("lobu-handoff-banner"),
		);
		expect(banner).toBeDefined();
		expect(String(banner?.input.expression)).toContain(
			"event-sourcing post answers",
		);
		expect(result.reason_preview).toContain("event-sourcing");
	});

	test("banner:false suppresses injection entirely", async () => {
		const { dispatcher, calls } = stagingDispatcher();

		const result = await prepareXReply(dispatcher, {
			tweetUrl: "2083959735481716957",
			body: "a draft",
			reason: "some reason",
			banner: false,
		});

		expect(
			calls.some((c) =>
				String(c.input.expression ?? "").includes("lobu-handoff-banner"),
			),
		).toBe(false);
		expect(result.banner_shown).toBe(false);
	});

	test("a failed banner never fails the staged draft", async () => {
		const { dispatcher } = stagingDispatcher();
		const inner = dispatcher.dispatch;
		dispatcher.dispatch = async (
			action: string,
			input: Record<string, unknown>,
		) => {
			if (
				action === "evaluate" &&
				String(input.expression).includes("lobu-handoff-banner")
			) {
				throw new Error("X re-rendered the composer");
			}
			return inner(action, input);
		};

		const result = await prepareXReply(dispatcher, {
			tweetUrl: "2083959735481716957",
			body: "a draft",
			reason: "some reason",
		});

		expect(result.prepared).toBe(true);
		expect(result.banner_shown).toBe(false);
	});

	test("truncates a long reason so the banner cannot swallow the page", () => {
		const long = "x".repeat(400);
		const out = truncateHandoffReason(long);
		expect(out).toHaveLength(120);
		expect(out.endsWith("…")).toBe(true);
		expect(truncateHandoffReason("   ")).toBeUndefined();
		expect(truncateHandoffReason(null)).toBeUndefined();
	});

	test("escapes the reason as a JS literal — an apostrophe must not break the script", () => {
		const expr = buildInjectHandoffBannerExpression({
			reason: `it's a "quoted" </script> case`,
		});
		// JSON.stringify is what makes this safe; assert the raw text never
		// lands unescaped in the emitted source.
		expect(expr).toContain(JSON.stringify(`it's a "quoted" </script> case`));
	});

	test("keeps the context visible until the user dismisses it", () => {
		const expr = buildInjectHandoffBannerExpression({ reason: "read this later" });
		expect(expr).not.toContain("setTimeout");
		expect(expr).toContain("root.remove()");
	});
});
