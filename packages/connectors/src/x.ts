/**
 * X (Twitter) Connector
 *
 * Supports two auth modes:
 * - OAuth 2.0 user context against the X API v2 (preferred when a token is
 *   available — the ToS-compliant path).
 * - The paired Owletto Chrome extension (fallback). Mirrors the LinkedIn
 *   connector: we attach the CDP Network domain in the user's signed-in
 *   x.com tab via the extension's `chrome.*` action dispatcher, drive scroll
 *   pagination, and parse the GraphQL responses the page emits. No Playwright,
 *   no cookie cache, no `--remote-debugging-port` plumbing.
 *
 * Auth is implicit on the extension path: the user is already signed into
 * x.com in the paired Chrome. There is no fallback path — if no online
 * Owletto extension is reachable in the connection's org, the sync fails fast
 * with a clear "no paired Owletto extension" error.
 *
 * Feeds:
 *   - tweets:   search by query or track a handle (API v2 or extension search)
 *   - home_feed: your personalized x.com home timeline (extension only — there
 *                is no public API for the "For you" / "Following" timeline;
 *                read via content-script scrape because CDP network capture
 *                blocks the feed from rendering, same as LinkedIn home_feed)
 */

import {
	type ChromeActionDispatcher,
	type ConnectorDefinition,
	ConnectorRuntime,
	calculateEngagementScore,
	createHttpClient,
	type EventEnvelope,
	extensionDomScrape,
	extensionNetworkSync,
	type HttpClient,
	paginateByCursor,
	type SyncContext,
	type SyncResult,
} from "@lobu/connector-sdk";

// ── Types ──────────────────────────────────────────────────────

interface XCheckpoint {
	last_tweet_id?: string;
	last_timestamp?: Date | string;
}

interface XTweet {
	id: string;
	text: string;
	username: string;
	likes: number;
	retweets: number;
	replies: number;
	quotes: number;
	publishedAt: Date;
	isRetweet: boolean;
	isReply: boolean;
	isQuote: boolean;
	conversationId?: string;
	inReplyToId?: string;
	/** True for promoted/ad tweets — dropped before emit, like LinkedIn's "Promoted" filter. */
	promoted?: boolean;
}

interface XApiTweetRecord {
	id: string;
	text?: string;
	author_id?: string;
	created_at?: string;
	conversation_id?: string;
	public_metrics?: {
		like_count?: number;
		retweet_count?: number;
		reply_count?: number;
		quote_count?: number;
	};
	referenced_tweets?: Array<{ type?: string; id?: string }>;
}

interface XApiUserRecord {
	id: string;
	username?: string;
	name?: string;
}

interface XApiListResponse {
	data?: XApiTweetRecord[];
	includes?: {
		users?: XApiUserRecord[];
	};
	meta?: {
		next_token?: string;
		result_count?: number;
	};
	errors?: Array<{ detail?: string; message?: string }>;
}

/** x.com origins the dispatched chrome actions are allowed to touch. */
const X_ALLOWED_ORIGINS = ["x.com", "*.x.com", "twitter.com", "*.twitter.com"];

// ── Home-feed content-script scrape contract ────────────────────
//
// The personalized home timeline is the ONE feed that can't be read via
// network capture: attaching the CDP debugger stops the feed from rendering,
// so the GraphQL responses never arrive. Instead we drive the extension's
// `cs_scrape` op (a content script, no debugger) with a declarative selector
// config defined here.

/** A row produced by the extension's cs_scrape from HOME_FEED_SCRAPE_CONFIG. */
interface HomeFeedRow {
	id?: string;
	body?: string;
	author?: string;
	status_path?: string;
	published_at?: string;
}

/**
 * Selectors for the virtualized x.com/home DOM. These live here, not in the
 * extension — the scrape engine is site-agnostic.
 */
const HOME_FEED_SCRAPE_CONFIG = {
	scroll: { max: 8, stall: 3, waitMs: 1500 },
	loggedOutWhen: { pathRegex: "/(login|i/flow/login)\\b" },
	rowSelector: 'article[data-testid="tweet"]',
	id: {
		source: "field",
		field: "status_path",
		regex: "/status/(\\d+)",
		group: 1,
	},
	requireFields: ["body", "status_path"],
	fields: {
		body: { selector: '[data-testid="tweetText"]', take: "text" },
		author: {
			selector: '[data-testid="User-Name"]',
			take: "text",
			firstLine: true,
		},
		status_path: {
			selector: 'a[href*="/status/"]',
			take: "attr",
			attr: "href",
		},
		published_at: {
			selector: "time[datetime]",
			take: "attr",
			attr: "datetime",
		},
	},
} as const;

/** Pull @handle from a status permalink like `/alice/status/123`. */
export function parseUsernameFromStatusPath(statusPath: string): string {
	if (!statusPath) return "";
	const match = statusPath.match(/\/([^/]+)\/status\//);
	return match?.[1] ?? "";
}

/**
 * The home feed mixes in ads and suggestion noise. Drop them before emitting.
 */
export function isHomeFeedNoise(body: string): boolean {
	if (!body || body.trim().length < 5) return true;
	if (/\bPromoted\b/i.test(body.slice(0, 80))) return true;
	return false;
}

/** Map cs_scrape home-feed rows to XTweet objects for finalizeSyncResult. */
export function buildHomeFeedTweets(rows: HomeFeedRow[]): XTweet[] {
	const seen = new Set<string>();
	const tweets: XTweet[] = [];
	for (const row of rows) {
		if (!row?.id || !row.body || seen.has(row.id)) continue;
		if (isHomeFeedNoise(row.body)) continue;
		seen.add(row.id);
		const username =
			parseUsernameFromStatusPath(row.status_path ?? "") ||
			(row.author ?? "").replace(/^@+/, "").trim();
		const publishedAt = row.published_at
			? new Date(row.published_at)
			: new Date();
		tweets.push({
			id: row.id,
			text: row.body,
			username,
			likes: 0,
			retweets: 0,
			replies: 0,
			quotes: 0,
			publishedAt,
			isRetweet: false,
			isReply: false,
			isQuote: false,
		});
	}
	return tweets;
}

// ── Helpers ────────────────────────────────────────────────────

function normalizeHandle(input: string | undefined): string | null {
	if (!input) return null;
	const trimmed = input.trim().replace(/^@+/, "");
	if (!trimmed) return null;
	const match = trimmed.match(/^[A-Za-z0-9_]{1,15}/);
	return match?.[0] ?? null;
}

function buildSearchQuery(config: Record<string, unknown>): string {
	const explicitSearchQuery =
		typeof config.search_query === "string" ? config.search_query.trim() : "";
	if (explicitSearchQuery.length > 0) {
		return explicitSearchQuery;
	}

	const accountHandle = normalizeHandle(
		typeof config.account_handle === "string"
			? config.account_handle
			: undefined,
	);
	if (!accountHandle) {
		throw new Error("search_query or account_handle is required");
	}

	return `from:${accountHandle}`;
}

function buildApiTweet(
	tweet: XApiTweetRecord,
	usernameById: Map<string, string>,
	defaultUsername?: string,
): XTweet | null {
	if (!tweet.id || !tweet.text || !tweet.created_at) return null;

	const referenced = tweet.referenced_tweets ?? [];
	const publicMetrics = tweet.public_metrics ?? {};
	const inReplyToId = referenced.find((ref) => ref.type === "replied_to")?.id;

	return {
		id: tweet.id,
		text: tweet.text,
		username: usernameById.get(tweet.author_id ?? "") ?? defaultUsername ?? "",
		likes: publicMetrics.like_count ?? 0,
		retweets: publicMetrics.retweet_count ?? 0,
		replies: publicMetrics.reply_count ?? 0,
		quotes: publicMetrics.quote_count ?? 0,
		publishedAt: new Date(tweet.created_at),
		isRetweet: referenced.some((ref) => ref.type === "retweeted"),
		isReply: Boolean(inReplyToId),
		isQuote: referenced.some((ref) => ref.type === "quoted"),
		conversationId: tweet.conversation_id,
		inReplyToId,
	};
}

function parseApiListResponse(
	json: XApiListResponse,
	defaultUsername?: string,
): XTweet[] {
	const users = json.includes?.users ?? [];
	const usernameById = new Map(
		users.map((user) => [user.id, user.username ?? ""]),
	);

	return (json.data ?? [])
		.map((tweet) => buildApiTweet(tweet, usernameById, defaultUsername))
		.filter((tweet): tweet is XTweet => tweet !== null);
}

/**
 * Extract one tweet from an x.com GraphQL `tweet_results.result` object.
 * Shared by the search and home-timeline parsers so both handle the same edge
 * cases: `TweetWithVisibilityResults` (limits on a tweet → nested `.tweet`),
 * the legacy/core nesting, and promoted-tweet detection.
 */
function extractTweetFromGraphqlResult(result: any): XTweet | null {
	if (!result || typeof result !== "object") return null;

	// TweetWithVisibilityResults wraps the real tweet under `.tweet`.
	const tweetNode =
		result.__typename === "TweetWithVisibilityResults" ? result.tweet : result;
	const legacy = tweetNode?.legacy ?? result.legacy;
	if (!legacy?.full_text) return null;

	const restId = legacy.id_str ?? tweetNode?.rest_id ?? result.rest_id;
	if (!restId) return null;

	const userResult =
		tweetNode?.core?.user_results?.result ?? result.core?.user_results?.result;
	const screenName =
		userResult?.core?.screen_name ?? userResult?.legacy?.screen_name ?? "";

	return {
		id: restId,
		text: legacy.full_text,
		username: screenName,
		likes: legacy.favorite_count ?? 0,
		retweets: legacy.retweet_count ?? 0,
		replies: legacy.reply_count ?? 0,
		quotes: legacy.quote_count ?? 0,
		publishedAt: new Date(legacy.created_at),
		isRetweet: !!legacy.retweeted_status_result,
		isReply: !!legacy.in_reply_to_status_id_str,
		isQuote: !!legacy.is_quote_status,
		conversationId: legacy.conversation_id_str,
		inReplyToId: legacy.in_reply_to_status_id_str,
		promoted: Boolean(result.promotedMetadata ?? tweetNode?.promotedMetadata),
	};
}

/**
 * Iterate the `instructions[].entries[]` shape shared by x.com's GraphQL
 * timelines (search + home). Entries may be tweet items, conversation modules
 * (a root + its threaded replies), or cursors — we only want tweet items, and
 * recurse one level into module items. Promoted entries are dropped.
 */
export function extractTweetsFromInstructions(instructions: any[]): XTweet[] {
	const tweets: XTweet[] = [];
	if (!Array.isArray(instructions)) return tweets;

	for (const instruction of instructions) {
		const entries = instruction.entries ?? instruction.moduleItems ?? [];
		for (const entry of entries) {
			// Skip promoted entries by entryId prefix (promoted-tweet-…, promotedTweet-…).
			const entryId: string = entry?.entryId ?? "";
			if (/^promoted/i.test(entryId)) continue;

			// A single tweet item.
			const itemResult =
				entry?.content?.itemContent?.tweet_results?.result ??
				entry?.item?.itemContent?.tweet_results?.result;
			if (itemResult) {
				const tweet = extractTweetFromGraphqlResult(itemResult);
				if (tweet && !tweet.promoted) tweets.push(tweet);
				continue;
			}

			// A conversation module: a root tweet + threaded replies, each under
			// its own `item.itemContent.tweet_results.result`.
			const moduleItems = entry?.content?.items ?? entry?.items ?? [];
			if (Array.isArray(moduleItems)) {
				for (const modItem of moduleItems) {
					const modResult =
						modItem?.item?.itemContent?.tweet_results?.result ??
						modItem?.itemContent?.tweet_results?.result;
					const tweet = modResult && extractTweetFromGraphqlResult(modResult);
					if (tweet && !tweet.promoted) tweets.push(tweet);
				}
			}
		}
	}

	return tweets;
}

/** Parse x.com GraphQL SearchTimeline responses. */
export function parseBrowserSearchResponse(
	_url: string,
	json: unknown,
): XTweet[] {
	const data = json as any;
	const instructions =
		data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ??
		[];
	return extractTweetsFromInstructions(instructions);
}

function tweetToEvent(tweet: XTweet): EventEnvelope {
	const engagementData = {
		reply_count: tweet.replies,
		upvotes: tweet.likes,
		score: tweet.retweets * 2 + tweet.likes,
	};

	return {
		origin_id: tweet.id,
		payload_text: tweet.text,
		author_name: tweet.username ? `@${tweet.username}` : undefined,
		occurred_at: tweet.publishedAt,
		origin_type: tweet.isReply ? "reply" : "tweet",
		score: calculateEngagementScore("x", engagementData),
		source_url: `https://x.com/${tweet.username || "i"}/status/${tweet.id}`,
		origin_parent_id: tweet.inReplyToId || undefined,
		metadata: {
			...engagementData,
			retweet_count: tweet.retweets,
			quote_count: tweet.quotes,
			is_retweet: tweet.isRetweet,
			is_reply: tweet.isReply,
			is_quote: tweet.isQuote,
			...(tweet.conversationId
				? { conversation_id: tweet.conversationId }
				: {}),
		},
	};
}

export function finalizeSyncResult(
	tweets: XTweet[],
	checkpoint: XCheckpoint,
	metadata: Record<string, unknown>,
): SyncResult {
	const seenIds = new Set<string>();
	const deduped = tweets.filter((tweet) => {
		if (!tweet.id || !tweet.text || seenIds.has(tweet.id)) return false;
		seenIds.add(tweet.id);
		if (checkpoint.last_tweet_id && tweet.id === checkpoint.last_tweet_id)
			return false;
		return true;
	});

	const events: EventEnvelope[] = deduped.map(tweetToEvent);
	events.sort(
		(a, b) =>
			new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(),
	);

	const newestTweetId =
		events.length > 0 ? events[0].origin_id : checkpoint.last_tweet_id;
	const newCheckpoint: XCheckpoint = {
		last_tweet_id: newestTweetId,
		last_timestamp:
			events.length > 0 ? events[0].occurred_at : checkpoint.last_timestamp,
	};

	return {
		events,
		checkpoint: newCheckpoint as unknown as Record<string, unknown>,
		metadata: {
			items_found: events.length,
			items_skipped: tweets.length - deduped.length,
			...metadata,
		},
	};
}

// ── Extension dispatcher ───────────────────────────────────────
//
// Pulled from sessionState — the connector-worker subprocess splices a live
// `chrome_dispatcher` onto every sync's sessionState; the dispatcher's
// `dispatch()` rides an IPC channel up to the gateway's
// /api/workers/dispatch-chrome-action bridge and out to the paired Owletto
// extension. When no extension is online in the connection's org, the bridge
// returns `failed` and the dispatcher throws — we surface that verbatim.
function requireExtensionDispatcher(ctx: SyncContext): ChromeActionDispatcher {
	const handle = (
		ctx.sessionState as Record<string, unknown> | null | undefined
	)?.chrome_dispatcher as ChromeActionDispatcher | undefined;
	if (!handle || typeof handle.dispatch !== "function") {
		throw new Error(
			"X connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState — re-run on a connector-worker that has the dispatcher bridge.",
		);
	}
	return handle;
}

// ── Sync paths ─────────────────────────────────────────────────

async function resolveUserId(
	handle: string,
	http: HttpClient,
): Promise<string> {
	const url = new URL(
		`https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}`,
	);
	const json = await http.get<{ data?: { id?: string } }>(url.toString());
	const userId = json.data?.id;
	if (!userId) {
		throw new Error(`Could not resolve X user id for @${handle}`);
	}
	return userId;
}

async function syncViaOAuthApi(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const accessToken = ctx.credentials?.accessToken;
	if (!accessToken) {
		throw new Error("OAuth access token missing for X connector");
	}

	const http = createHttpClient({
		token: accessToken,
		headers: { "Content-Type": "application/json" },
		errorPrefix: "X API",
	});

	const maxPages = Math.max(
		1,
		Math.min(50, Number(config.max_scrolls ?? 10) || 10),
	);
	const accountHandle = normalizeHandle(
		typeof config.account_handle === "string"
			? config.account_handle
			: undefined,
	);
	const explicitSearchQuery =
		typeof config.search_query === "string" ? config.search_query.trim() : "";

	const tweets: XTweet[] = [];
	let pageCount = 0;

	if (explicitSearchQuery.length === 0 && accountHandle) {
		const userId = await resolveUserId(accountHandle, http);

		const pages = paginateByCursor<XTweet, string>(
			async (nextToken) => {
				const url = new URL(
					`https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets`,
				);
				url.searchParams.set("max_results", "100");
				url.searchParams.set(
					"tweet.fields",
					"author_id,conversation_id,created_at,public_metrics,referenced_tweets",
				);
				if (checkpoint.last_tweet_id) {
					url.searchParams.set("since_id", checkpoint.last_tweet_id);
				}
				if (nextToken) {
					url.searchParams.set("pagination_token", nextToken);
				}

				const json = await http.get<XApiListResponse>(url.toString());
				pageCount += 1;
				return {
					items: parseApiListResponse(json, accountHandle),
					nextCursor: json.meta?.next_token,
				};
			},
			{ maxPages },
		);

		for await (const items of pages) {
			tweets.push(...items);
		}
	} else {
		const searchQuery = buildSearchQuery(config);

		const pages = paginateByCursor<XTweet, string>(
			async (nextToken) => {
				const url = new URL("https://api.x.com/2/tweets/search/recent");
				url.searchParams.set("query", searchQuery);
				url.searchParams.set("max_results", "100");
				url.searchParams.set(
					"tweet.fields",
					"author_id,conversation_id,created_at,public_metrics,referenced_tweets",
				);
				url.searchParams.set("expansions", "author_id");
				url.searchParams.set("user.fields", "username");
				if (checkpoint.last_tweet_id) {
					url.searchParams.set("since_id", checkpoint.last_tweet_id);
				}
				if (nextToken) {
					url.searchParams.set("next_token", nextToken);
				}

				const json = await http.get<XApiListResponse>(url.toString());
				pageCount += 1;
				return {
					items: parseApiListResponse(json),
					nextCursor: json.meta?.next_token,
				};
			},
			{ maxPages },
		);

		for await (const items of pages) {
			tweets.push(...items);
		}
	}

	return finalizeSyncResult(tweets, checkpoint, {
		backend: "oauth_api",
		api_calls: pageCount,
	});
}

/**
 * Drive the paired extension's network intercept for x.com search, parsing
 * intercepted GraphQL SearchTimeline responses.
 */
async function syncViaExtension(args: {
	ctx: SyncContext;
	url: string;
	interceptPatterns: { regex: string; flags?: string }[];
	parseResponse: (url: string, json: unknown) => XTweet[];
	maxScrolls: number;
	checkpoint: XCheckpoint;
	/** Extra metadata to fold into the result (e.g. which timeline tab). */
	metadata?: Record<string, unknown>;
}): Promise<SyncResult> {
	const { ctx, url, interceptPatterns, parseResponse, maxScrolls, checkpoint } =
		args;
	const result = await extensionNetworkSync<XTweet>({
		dispatcher: requireExtensionDispatcher(ctx),
		config: {
			interceptPatterns,
			allowedOrigins: X_ALLOWED_ORIGINS,
			maxScrolls,
			scrollDelayMs: 2000,
			responseTimeoutMs: 5000,
		},
		url,
		parseResponse,
		checkAuth: (currentUrl) =>
			!currentUrl.includes("/login") && !currentUrl.includes("/i/flow/login"),
	});

	return finalizeSyncResult(result.items, checkpoint, {
		backend: result.backend,
		api_calls: result.apiCallCount,
		...(args.metadata ?? {}),
	});
}

async function syncSearchViaExtension(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const searchQuery = buildSearchQuery(config);
	const maxScrolls = Math.max(
		1,
		Math.min(50, Number(config.max_scrolls ?? 10) || 10),
	);
	const searchFilter = (config.search_filter as string) ?? "live";
	const searchUrl = `https://x.com/search?q=${encodeURIComponent(searchQuery)}&src=typed_query&f=${searchFilter}`;

	return syncViaExtension({
		ctx,
		url: searchUrl,
		interceptPatterns: [{ regex: "/i/api/graphql/\\w+/.*Search" }],
		parseResponse: parseBrowserSearchResponse,
		maxScrolls,
		checkpoint,
		metadata: { search_query: searchQuery, search_filter: searchFilter },
	});
}

/**
 * Personalized home timeline via the extension's content-script scrape.
 * Network capture can't read it (the CDP debugger stops the feed rendering).
 */
async function syncHomeFeedViaDomScrape(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const maxScrolls = Math.max(
		1,
		Math.min(30, Number(config.max_scrolls ?? 10) || 10),
	);
	const { items: rows, loggedIn } = await extensionDomScrape<HomeFeedRow>({
		dispatcher: requireExtensionDispatcher(ctx),
		url: "https://x.com/home",
		config: {
			...HOME_FEED_SCRAPE_CONFIG,
			scroll: { ...HOME_FEED_SCRAPE_CONFIG.scroll, max: maxScrolls },
		},
		parseRows: (raw) => raw as HomeFeedRow[],
		allowedOrigins: X_ALLOWED_ORIGINS,
	});

	if (!loggedIn) {
		throw new Error(
			"Not logged into X. The home timeline could not be read — sign in to x.com in the focused Owletto window, then re-run the sync.",
		);
	}

	const tweets = buildHomeFeedTweets(rows);
	return finalizeSyncResult(tweets, checkpoint, {
		backend: "extension-cs-scrape",
		items_scraped: rows.length,
		timeline: "home",
	});
}

// ── Config schemas ─────────────────────────────────────────────

const searchConfigSchema = {
	type: "object",
	anyOf: [{ required: ["search_query"] }, { required: ["account_handle"] }],
	properties: {
		search_query: {
			type: "string",
			minLength: 1,
			description:
				'Search query for tweets (e.g., "nodejs", "#programming", "from:user")',
		},
		account_handle: {
			type: "string",
			minLength: 1,
			description:
				'Optional X handle to track directly (e.g. "openai" or "@openai"). Used when search_query is omitted.',
		},
		search_filter: {
			type: "string",
			enum: ["live", "top"],
			default: "live",
			description:
				'Search tab: "live" for Latest (chronological), "top" for Top (popular/algorithmic)',
		},
		max_scrolls: {
			type: "integer",
			minimum: 1,
			maximum: 50,
			default: 10,
			description:
				"Maximum pagination iterations (default: 10, API pages or browser scrolls)",
		},
	},
};

const homeFeedConfigSchema = {
	type: "object",
	properties: {
		max_scrolls: {
			type: "integer",
			minimum: 1,
			maximum: 30,
			default: 10,
			description:
				"Maximum scroll iterations for the home timeline (default: 10)",
		},
	},
};

const engagementMetadataSchema = {
	type: "object",
	properties: {
		reply_count: { type: "number" },
		upvotes: { type: "number", description: "Likes" },
		score: { type: "number" },
		retweet_count: { type: "number" },
		quote_count: { type: "number" },
		is_retweet: { type: "boolean" },
		is_reply: { type: "boolean" },
		is_quote: { type: "boolean" },
	},
};

// ── Connector ──────────────────────────────────────────────────

export default class XConnector extends ConnectorRuntime {
	readonly definition: ConnectorDefinition = {
		key: "x",
		name: "X (Twitter)",
		description:
			"Fetches tweets via the X API v2 or the paired Owletto Chrome extension. Includes a home-timeline feed scraped from your signed-in x.com session.",
		version: "3.0.0",
		faviconDomain: "x.com",
		authSchema: {
			methods: [
				{
					type: "oauth",
					provider: "twitter",
					requiredScopes: ["tweet.read", "users.read", "offline.access"],
					optionalScopes: [
						"users.email",
						"follows.read",
						"like.read",
						"bookmark.read",
					],
					loginScopes: [
						"users.read",
						"tweet.read",
						"offline.access",
						"users.email",
					],
					authorizationUrl: "https://x.com/i/oauth2/authorize",
					tokenUrl: "https://api.x.com/2/oauth2/token",
					userinfoUrl: "https://api.x.com/2/users/me?user.fields=username",
					tokenEndpointAuthMethod: "client_secret_basic",
					usePkce: true,
					clientIdKey: "TWITTER_CLIENT_ID",
					clientSecretKey: "TWITTER_CLIENT_SECRET",
					description:
						"Preferred auth mode. Uses the X OAuth 2.0 API for server-side syncs and login.",
					setupInstructions:
						"Create an X OAuth 2.0 app, add {{redirect_uri}} as the callback URL, then paste the client ID and client secret below.",
					loginProvisioning: {
						autoCreateConnection: true,
					},
				},
				{
					type: "browser",
					capture: "cdp",
					requiredDomains: ["x.com", ".x.com"],
					description:
						"Fallback for browser-based scraping via the paired Owletto Chrome extension when API access is unavailable. Rides the user’s signed-in x.com session; required for the home-timeline feed (no public API exists for it).",
				},
			],
		},
		feeds: {
			tweets: {
				key: "tweets",
				name: "Tweets",
				requiredScopes: ["tweet.read", "users.read"],
				description:
					"Search and sync tweets matching a query or a specific account handle.",
				configSchema: searchConfigSchema,
				eventKinds: {
					tweet: {
						description: "A tweet (original post)",
						metadataSchema: engagementMetadataSchema,
					},
					reply: {
						description: "A reply to a tweet",
						metadataSchema: {
							...engagementMetadataSchema,
							properties: {
								...engagementMetadataSchema.properties,
								conversation_id: { type: "string" },
							},
						},
					},
				},
			},
			home_feed: {
				key: "home_feed",
				name: "Home Timeline",
				description:
					"Your personalized x.com home timeline (For you + Following). Extension-only via content-script scrape — there is no public API for the home timeline.",
				configSchema: homeFeedConfigSchema,
				eventKinds: {
					tweet: {
						description: "A tweet from your personalized home timeline",
						metadataSchema: engagementMetadataSchema,
					},
				},
			},
		},
	};

	async sync(ctx: SyncContext): Promise<SyncResult> {
		const config = ctx.config as Record<string, unknown>;
		const checkpoint = (ctx.checkpoint ?? {}) as XCheckpoint;
		const feedKey = ctx.feedKey ?? "tweets";

		// The home timeline has no public API — it is always served by the
		// extension, regardless of whether an OAuth token is present.
		if (feedKey === "home_feed") {
			return syncHomeFeedViaDomScrape(ctx, config, checkpoint);
		}

		// `tweets` feed: prefer the official API when we have a token, fall back
		// to the extension's signed-in search otherwise.
		if (ctx.credentials?.accessToken) {
			return syncViaOAuthApi(ctx, config, checkpoint);
		}

		return syncSearchViaExtension(ctx, config, checkpoint);
	}
}
