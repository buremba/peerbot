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
 *   - tweets:        search by query or track a handle (API v2 or extension search)
 *   - my_tweets:     authenticated user's posts and replies (API v2 or extension)
 *   - liked_tweets:  posts the user has liked (API v2 or extension)
 *   - bookmarks:        posts the user has bookmarked (API v2 or extension)
 *   - direct_messages:  1:1 and group DMs (OAuth API; extension fallback on /messages)
 *   - home_feed:        personalized x.com home timeline (extension only — there
 *                    is no public API for the "For you" / "Following" timeline;
 *                    read via content-script scrape because CDP network capture
 *                    blocks the feed from rendering, same as LinkedIn home_feed)
 */

import {
	type ChromeActionDispatcher,
	type ConnectorDefinition,
	type EventAttributionRule,
	type EventAttributionTargetSpec,
	type EntityTraitSpec,
	ConnectorRuntime,
	calculateEngagementScore,
	createHttpClient,
	type EventEnvelope,
	extensionDomScrape,
	extensionNetworkSync,
	HttpStatusError,
	type HttpClient,
	paginateByCursor,
	type SyncContext,
	type SyncResult,
} from "@lobu/connector-sdk";
import { IDENTITY } from "@lobu/connector-sdk/identity-namespaces";

/** Canonical identity namespaces for the X person graph. */
const X_IDENTITY = {
	USER_ID: IDENTITY.X_USER_ID,
	HANDLE: IDENTITY.X_HANDLE,
} as const;

/** OAuth scopes needed per feed for the API path (not used to pause browser-capable feeds). */
const X_OAUTH_FEED_SCOPES: Record<string, readonly string[]> = {
	tweets: ["tweet.read", "users.read"],
	my_tweets: ["tweet.read", "users.read"],
	liked_tweets: ["like.read", "tweet.read", "users.read"],
	bookmarks: ["bookmark.read", "tweet.read", "users.read"],
	direct_messages: ["dm.read", "tweet.read", "users.read"],
};

function normalizeXHandle(raw: string | undefined | null): string | undefined {
	if (!raw) return undefined;
	const trimmed = raw.trim().replace(/^@+/, "").toLowerCase();
	if (!trimmed || !/^[a-z0-9_]{1,15}$/.test(trimmed)) return undefined;
	return trimmed;
}

// ── Types ──────────────────────────────────────────────────────

interface XCheckpoint {
	last_tweet_id?: string;
	last_timestamp?: Date | string;
	last_dm_event_id?: string;
}

interface XTweet {
	id: string;
	text: string;
	username: string;
	authorId?: string;
	authorDisplayName?: string;
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

interface XDmMessage {
	id: string;
	text: string;
	senderId: string;
	senderHandle: string;
	senderName?: string;
	conversationId: string;
	isGroup: boolean;
	fromMe: boolean;
	participantId?: string;
	participantHandle?: string;
	participantName?: string;
	publishedAt: Date;
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

interface XApiDmEventRecord {
	id: string;
	text?: string;
	created_at?: string;
	sender_id?: string;
	dm_conversation_id?: string;
	event_type?: string;
}

interface XApiDmListResponse {
	data?: XApiDmEventRecord[];
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

/**
 * Link tweet-like X events to `person` rows via immutable `x_user_id` + `x_handle`.
 * Match-only by default (like Gmail): identities accrete onto existing contacts,
 * but we do not mint a person per random timeline author.
 */
const X_PERSON_AUTHOR_TARGET: EventAttributionTargetSpec = {
	entityType: "person",
	titlePath: "metadata.author_name",
	identities: [
		{
			namespace: X_IDENTITY.USER_ID,
			eventPath: "metadata.author_id",
			primary: true,
		},
		{ namespace: X_IDENTITY.HANDLE, eventPath: "metadata.author_handle" },
	],
};

const X_PERSON_AUTHOR_TRAITS: Record<string, EntityTraitSpec> = {
	x_handle: {
		eventPath: "metadata.author_handle",
		behavior: "prefer_non_empty",
	},
	x_display_name: {
		eventPath: "metadata.author_name",
		behavior: "prefer_non_empty",
	},
	last_x_interaction_at: {
		eventPath: "occurred_at",
		behavior: "overwrite",
	},
};

/** Mint/link the 1:1 DM counterparty (never the connected account itself). */
const X_PERSON_DM_COUNTERPARTY_TARGET: EventAttributionTargetSpec = {
	entityType: "person",
	createWhen: { path: "metadata.is_group", equals: false },
	titlePath: "metadata.participant_name",
	identities: [
		{
			namespace: X_IDENTITY.USER_ID,
			eventPath: "metadata.participant_id",
			primary: true,
		},
		{
			namespace: X_IDENTITY.HANDLE,
			eventPath: "metadata.participant_handle",
		},
	],
};

const X_PERSON_DM_COUNTERPARTY_TRAITS: Record<string, EntityTraitSpec> = {
	x_handle: {
		eventPath: "metadata.participant_handle",
		behavior: "prefer_non_empty",
	},
	x_display_name: {
		eventPath: "metadata.participant_name",
		behavior: "prefer_non_empty",
	},
	last_x_dm_at: {
		eventPath: "occurred_at",
		behavior: "overwrite",
	},
};

const X_TWEET_AUTHOR_ATTRIBUTIONS: EventAttributionRule[] = [
	{
		role: "authored_by",
		autoCreate: false,
		target: X_PERSON_AUTHOR_TARGET,
		traits: X_PERSON_AUTHOR_TRAITS,
	},
];

const X_DM_COUNTERPARTY_ATTRIBUTIONS: EventAttributionRule[] = [
	{
		role: "authored_by",
		autoCreate: false,
		target: {
			entityType: "person",
			titlePath: "metadata.sender_name",
			identities: [
				{ namespace: X_IDENTITY.USER_ID, eventPath: "metadata.sender_id", primary: true },
				{ namespace: X_IDENTITY.HANDLE, eventPath: "metadata.sender_handle", matchOnly: true },
			],
		},
		traits: {
			x_handle: { eventPath: "metadata.sender_handle", behavior: "prefer_non_empty" },
			display_name: { eventPath: "metadata.sender_name", behavior: "prefer_non_empty" },
		},
	},
	{
		role: "about",
		autoCreate: true,
		target: X_PERSON_DM_COUNTERPARTY_TARGET,
		traits: X_PERSON_DM_COUNTERPARTY_TRAITS,
	},
];

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

	const authorId = tweet.author_id;
	const username =
		usernameById.get(authorId ?? "") ?? defaultUsername ?? "";

	return {
		id: tweet.id,
		text: tweet.text,
		username,
		authorId,
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
	const authorId = userResult?.rest_id ?? userResult?.id;
	const authorDisplayName =
		userResult?.core?.name ?? userResult?.legacy?.name ?? undefined;

	return {
		id: restId,
		text: legacy.full_text,
		username: screenName,
		authorId: authorId ? String(authorId) : undefined,
		authorDisplayName,
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

/**
 * Parse x.com GraphQL timeline responses (profile tweets, likes, bookmarks).
 * Tries the common instruction-array shapes emitted by UserTweets, Likes, and
 * BookmarkTimeline endpoints.
 */
export function parseBrowserTimelineResponse(
	_url: string,
	json: unknown,
): XTweet[] {
	const data = json as any;
	const candidates = [
		data?.data?.user?.result?.timeline_v2?.timeline?.instructions,
		data?.data?.user?.result?.timeline?.timeline?.instructions,
		data?.data?.bookmark_timeline_v2?.timeline?.instructions,
		data?.data?.bookmarks_timeline?.timeline?.instructions,
		data?.data?.viewer?.bookmarks_timeline?.timeline?.instructions,
	];
	for (const instructions of candidates) {
		if (Array.isArray(instructions) && instructions.length > 0) {
			return extractTweetsFromInstructions(instructions);
		}
	}
	return [];
}

const TWEET_FIELDS =
	"author_id,conversation_id,created_at,public_metrics,referenced_tweets";

function tweetToEvent(tweet: XTweet, originType?: string): EventEnvelope {
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
		origin_type: originType ?? (tweet.isReply ? "reply" : "tweet"),
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
			...(tweet.authorId ? { author_id: tweet.authorId } : {}),
			...(tweet.username
				? { author_handle: normalizeXHandle(tweet.username) ?? tweet.username }
				: {}),
			...(tweet.authorDisplayName
				? { author_name: tweet.authorDisplayName }
				: {}),
			...(tweet.conversationId
				? { conversation_id: tweet.conversationId }
				: {}),
		},
	};
}

function dmConversationIsGroup(conversationId: string): boolean {
	return !conversationId.includes("-");
}

function resolveDmCounterparty(
	conversationId: string,
	authUserId: string,
	senderId: string,
	usernameById: Map<string, string>,
	nameById: Map<string, string>,
): {
	participantId?: string;
	participantHandle?: string;
	participantName?: string;
} {
	if (dmConversationIsGroup(conversationId)) {
		return {};
	}

	const parts = conversationId.split("-").filter(Boolean);
	if (parts.length !== 2) {
		return {};
	}

	const participantId = parts.find((id) => id !== authUserId) ?? senderId;
	if (!participantId || participantId === authUserId) {
		return {};
	}

	return {
		participantId,
		participantHandle: usernameById.get(participantId),
		participantName: nameById.get(participantId),
	};
}

function buildDmMessage(
	event: XApiDmEventRecord,
	authUserId: string,
	usernameById: Map<string, string>,
	nameById: Map<string, string>,
): XDmMessage | null {
	if (event.event_type && event.event_type !== "MessageCreate") return null;
	if (!event.id || !event.text || !event.created_at || !event.sender_id) {
		return null;
	}
	if (!event.dm_conversation_id) return null;

	const senderId = event.sender_id;
	const conversationId = event.dm_conversation_id;
	const isGroup = dmConversationIsGroup(conversationId);
	const fromMe = senderId === authUserId;
	const counterparty = resolveDmCounterparty(
		conversationId,
		authUserId,
		senderId,
		usernameById,
		nameById,
	);

	return {
		id: event.id,
		text: event.text,
		senderId,
		senderHandle: usernameById.get(senderId) ?? "",
		senderName: nameById.get(senderId),
		conversationId,
		isGroup,
		fromMe,
		participantId: counterparty.participantId,
		participantHandle: counterparty.participantHandle,
		participantName: counterparty.participantName,
		publishedAt: new Date(event.created_at),
	};
}

function dmToEvent(message: XDmMessage): EventEnvelope {
	return {
		origin_id: message.id,
		payload_text: message.text,
		author_name: message.senderHandle ? `@${message.senderHandle}` : undefined,
		occurred_at: message.publishedAt,
		origin_type: "dm_message",
		origin_parent_id: message.conversationId,
		metadata: {
			sender_id: message.senderId,
			sender_handle: message.senderHandle,
			...(message.senderName ? { sender_name: message.senderName } : {}),
			from_me: message.fromMe,
			is_group: message.isGroup,
			dm_conversation_id: message.conversationId,
			...(message.participantId
				? { participant_id: message.participantId }
				: {}),
			...(message.participantHandle
				? { participant_handle: message.participantHandle }
				: {}),
			...(message.participantName
				? { participant_name: message.participantName }
				: {}),
		},
	};
}

export function finalizeDmSyncResult(
	messages: XDmMessage[],
	checkpoint: XCheckpoint,
	metadata: Record<string, unknown>,
): SyncResult {
	const seenIds = new Set<string>();
	const deduped = messages.filter((message) => {
		if (!message.id || !message.text || seenIds.has(message.id)) return false;
		seenIds.add(message.id);
		if (
			checkpoint.last_dm_event_id &&
			message.id === checkpoint.last_dm_event_id
		) {
			return false;
		}
		return true;
	});

	const events: EventEnvelope[] = deduped.map(dmToEvent);
	events.sort(
		(a, b) =>
			new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(),
	);

	const newestId =
		events.length > 0 ? events[0].origin_id : checkpoint.last_dm_event_id;
	const newCheckpoint: XCheckpoint = {
		...checkpoint,
		last_dm_event_id: newestId,
	};

	return {
		events,
		checkpoint: newCheckpoint as unknown as Record<string, unknown>,
		metadata: {
			items_found: events.length,
			items_skipped: messages.length - deduped.length,
			...metadata,
		},
	};
}

export function finalizeSyncResult(
	tweets: XTweet[],
	checkpoint: XCheckpoint,
	metadata: Record<string, unknown>,
	options?: { originType?: string },
): SyncResult {
	const seenIds = new Set<string>();
	const deduped = tweets.filter((tweet) => {
		if (!tweet.id || !tweet.text || seenIds.has(tweet.id)) return false;
		seenIds.add(tweet.id);
		if (checkpoint.last_tweet_id && tweet.id === checkpoint.last_tweet_id)
			return false;
		return true;
	});

	const events: EventEnvelope[] = deduped.map((tweet) =>
		tweetToEvent(tweet, options?.originType),
	);
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

interface XAuthenticatedUser {
	id: string;
	username: string;
}

function createOAuthHttpClient(accessToken: string): HttpClient {
	return createHttpClient({
		token: accessToken,
		headers: { "Content-Type": "application/json" },
		errorPrefix: "X API",
	});
}

function readMaxPages(config: Record<string, unknown>, cap = 50): number {
	return Math.max(1, Math.min(cap, Number(config.max_scrolls ?? 10) || 10));
}

type XSyncBackend = "oauth_api" | "extension";

function parseGrantedScopes(scope: string | null | undefined): Set<string> {
	if (!scope) return new Set();
	return new Set(
		scope
			.split(/\s+/)
			.map((entry) => entry.trim())
			.filter(Boolean),
	);
}

function hasGrantedScopes(
	granted: Set<string>,
	required: readonly string[] | undefined,
): boolean {
	if (!required || required.length === 0) return true;
	return required.every((entry) => granted.has(entry));
}

function isTruthyConfigFlag(value: unknown): boolean {
	return value === true || value === "true" || value === 1 || value === "1";
}

function readSyncBackendPreference(
	config: Record<string, unknown>,
): XSyncBackend | null {
	if (isTruthyConfigFlag(config.use_extension)) return "extension";
	if (isTruthyConfigFlag(config.use_oauth)) return "oauth_api";
	return null;
}

/**
 * Browser-first: when OAuth exists but the token lacks feed scopes, use the
 * paired extension instead of failing against the API.
 */
function resolveSyncBackend(
	ctx: SyncContext,
	config: Record<string, unknown>,
	requiredScopes: readonly string[] | undefined,
): XSyncBackend {
	const preference = readSyncBackendPreference(config);
	if (preference === "extension") return "extension";
	if (preference === "oauth_api" && ctx.credentials?.accessToken) {
		return "oauth_api";
	}

	const accessToken = ctx.credentials?.accessToken;
	if (!accessToken) return "extension";

	const granted = parseGrantedScopes(ctx.credentials?.scope);
	if (!hasGrantedScopes(granted, requiredScopes)) return "extension";

	return "oauth_api";
}

function isOAuthScopeOrAuthError(error: unknown): boolean {
	return (
		error instanceof HttpStatusError &&
		(error.status === 401 || error.status === 403)
	);
}

/** OAuth lookup failures that should defer to the paired extension on browser-first feeds. */
function isOAuthLookupFallbackError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return (
		error.message.startsWith("Could not resolve X user id for @") ||
		error.message.startsWith("Could not resolve authenticated X user") ||
		error.message === "OAuth access token missing for X connector"
	);
}

function shouldFallbackToExtension(error: unknown): boolean {
	return isOAuthScopeOrAuthError(error) || isOAuthLookupFallbackError(error);
}

async function syncWithOAuthFallback<T extends SyncResult>(
	oauthFn: () => Promise<T>,
	extensionFn: () => Promise<T>,
): Promise<T> {
	try {
		return await oauthFn();
	} catch (error) {
		if (!shouldFallbackToExtension(error)) throw error;
		return extensionFn();
	}
}

/** Browser-first feeds fall back to the extension unless `use_oauth` is set. */
async function syncOAuthWithOptionalFallback<T extends SyncResult>(
	config: Record<string, unknown>,
	oauthFn: () => Promise<T>,
	extensionFn: () => Promise<T>,
): Promise<T> {
	if (isTruthyConfigFlag(config.use_oauth)) return oauthFn();
	return syncWithOAuthFallback(oauthFn, extensionFn);
}

function extractViewerUserId(json: unknown): string | undefined {
	const data = json as Record<string, unknown>;
	const candidates = [
		(data?.data as Record<string, unknown> | undefined)?.viewer_v2,
		(data?.data as Record<string, unknown> | undefined)?.viewer,
		(data?.data as Record<string, unknown> | undefined)?.user_result,
	];
	for (const node of candidates) {
		const result = (node as { user_results?: { result?: { rest_id?: string } } })
			?.user_results?.result;
		if (result?.rest_id) return String(result.rest_id);
	}
	return undefined;
}

function buildBrowserDmMessage(
	messageNode: Record<string, unknown>,
	authUserId: string,
): XDmMessage | null {
	const messageData =
		(messageNode.message_data as Record<string, unknown> | undefined) ??
		(messageNode.legacy as Record<string, unknown> | undefined);
	if (!messageData) return null;

	const id = String(
		messageNode.id ??
			messageNode.message_id ??
			messageData.id ??
			messageData.message_id ??
			"",
	);
	const text = String(messageData.text ?? messageData.full_text ?? "").trim();
	const createdAt = String(
		messageData.time ?? messageData.created_at ?? messageData.timestamp ?? "",
	);
	const senderId = String(
		messageData.sender_id ?? messageNode.sender_id ?? "",
	);
	const conversationId = String(
		messageNode.conversation_id ??
			messageNode.conversationId ??
			messageData.conversation_id ??
			"",
	);
	if (!id || !text || !createdAt || !senderId || !conversationId) return null;

	const senderHandle = String(
		messageData.sender_screen_name ??
			messageData.sender_handle ??
			messageNode.sender_handle ??
			"",
	).replace(/^@+/, "");
	const senderName =
		typeof messageData.sender_name === "string"
			? messageData.sender_name
			: undefined;
	const isGroup = dmConversationIsGroup(conversationId);
	const fromMe = authUserId.length > 0 && senderId === authUserId;
	const usernameById = new Map<string, string>(
		senderHandle ? [[senderId, senderHandle]] : [],
	);
	const nameById = new Map<string, string>(
		senderName ? [[senderId, senderName]] : [],
	);
	const counterparty = resolveDmCounterparty(
		conversationId,
		authUserId,
		senderId,
		usernameById,
		nameById,
	);

	return {
		id,
		text,
		senderId,
		senderHandle,
		senderName,
		conversationId,
		isGroup,
		fromMe,
		participantId: counterparty.participantId,
		participantHandle: counterparty.participantHandle,
		participantName: counterparty.participantName,
		publishedAt: new Date(createdAt),
	};
}

function extractDmMessagesFromNode(
	node: unknown,
	authUserId: string,
	seen: Set<string>,
): XDmMessage[] {
	if (!node || typeof node !== "object") return [];

	const messages: XDmMessage[] = [];
	const record = node as Record<string, unknown>;

	if (record.message_data || record.legacy) {
		const message = buildBrowserDmMessage(record, authUserId);
		if (message && !seen.has(message.id)) {
			seen.add(message.id);
			messages.push(message);
		}
	}

	if (record.message && typeof record.message === "object") {
		messages.push(
			...extractDmMessagesFromNode(record.message, authUserId, seen),
		);
	}

	const content = record.content;
	if (content && typeof content === "object") {
		messages.push(
			...extractDmMessagesFromNode(content, authUserId, seen),
		);
	}

	const entries = record.entries;
	if (Array.isArray(entries)) {
		for (const entry of entries) {
			messages.push(
				...extractDmMessagesFromNode(entry, authUserId, seen),
			);
		}
	}

	const instructions = record.instructions;
	if (Array.isArray(instructions)) {
		for (const instruction of instructions) {
			messages.push(
				...extractDmMessagesFromNode(instruction, authUserId, seen),
			);
		}
	}

	const conversations = record.conversations;
	if (conversations && typeof conversations === "object") {
		for (const conversation of Object.values(conversations)) {
			messages.push(
				...extractDmMessagesFromNode(conversation, authUserId, seen),
			);
		}
	}

	const nestedCandidates = [
		record.data,
		record.timeline,
		record.inbox_initial_state,
		record.inbox_timeline,
		record.user_events,
	];
	for (const candidate of nestedCandidates) {
		messages.push(
			...extractDmMessagesFromNode(candidate, authUserId, seen),
		);
	}

	return messages;
}

/** Parse x.com GraphQL DM inbox / conversation responses. */
export function parseBrowserDmResponse(
	_url: string,
	json: unknown,
	authUserId = "",
): XDmMessage[] {
	const seen = new Set<string>();
	const resolvedAuthUserId = authUserId || extractViewerUserId(json) || "";
	return extractDmMessagesFromNode(json, resolvedAuthUserId, seen);
}

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

async function resolveAuthenticatedUser(
	http: HttpClient,
): Promise<XAuthenticatedUser> {
	const json = await http.get<{ data?: { id?: string; username?: string } }>(
		"https://api.x.com/2/users/me?user.fields=username",
	);
	const id = json.data?.id;
	const username = json.data?.username;
	if (!id || !username) {
		throw new Error("Could not resolve authenticated X user via /2/users/me");
	}
	return { id, username };
}

async function resolveAccountHandle(
	config: Record<string, unknown>,
	http?: HttpClient,
): Promise<string> {
	const configured = normalizeHandle(
		typeof config.account_handle === "string"
			? config.account_handle
			: undefined,
	);
	if (configured) return configured;
	if (!http) {
		throw new Error(
			"account_handle is required when OAuth is unavailable for this feed",
		);
	}
	const user = await resolveAuthenticatedUser(http);
	return user.username;
}

async function paginateTweetEndpoint(
	http: HttpClient,
	buildUrl: (nextToken?: string) => URL,
	maxPages: number,
	defaultUsername?: string,
): Promise<{ tweets: XTweet[]; pageCount: number }> {
	const tweets: XTweet[] = [];
	let pageCount = 0;

	const pages = paginateByCursor<XTweet, string>(
		async (nextToken) => {
			const url = buildUrl(nextToken ?? undefined);
			const json = await http.get<XApiListResponse>(url.toString());
			pageCount += 1;
			return {
				items: parseApiListResponse(json, defaultUsername),
				nextCursor: json.meta?.next_token,
			};
		},
		{ maxPages },
	);

	for await (const items of pages) {
		tweets.push(...items);
	}

	return { tweets, pageCount };
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

	const http = createOAuthHttpClient(accessToken);
	const maxPages = readMaxPages(config);
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
				url.searchParams.set("tweet.fields", TWEET_FIELDS);
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
				url.searchParams.set("tweet.fields", TWEET_FIELDS);
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
	originType?: string;
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

	return finalizeSyncResult(
		result.items,
		checkpoint,
		{
			backend: result.backend,
			api_calls: result.apiCallCount,
			...(args.metadata ?? {}),
		},
		args.originType ? { originType: args.originType } : undefined,
	);
}

async function syncSearchViaExtension(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const searchQuery = buildSearchQuery(config);
	const maxScrolls = readMaxPages(config);
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

async function syncMyTweetsViaOAuthApi(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const accessToken = ctx.credentials?.accessToken;
	if (!accessToken) {
		throw new Error("OAuth access token missing for my_tweets feed");
	}

	const http = createOAuthHttpClient(accessToken);
	const maxPages = readMaxPages(config);
	const authUser = await resolveAuthenticatedUser(http);
	const accountHandle = await resolveAccountHandle(config, http);
	const userId =
		accountHandle === authUser.username
			? authUser.id
			: await resolveUserId(accountHandle, http);

	const { tweets, pageCount } = await paginateTweetEndpoint(
		http,
		(nextToken) => {
			const url = new URL(
				`https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets`,
			);
			url.searchParams.set("max_results", "100");
			url.searchParams.set("tweet.fields", TWEET_FIELDS);
			if (checkpoint.last_tweet_id) {
				url.searchParams.set("since_id", checkpoint.last_tweet_id);
			}
			if (nextToken) {
				url.searchParams.set("pagination_token", nextToken);
			}
			return url;
		},
		maxPages,
		accountHandle,
	);

	return finalizeSyncResult(tweets, checkpoint, {
		backend: "oauth_api",
		api_calls: pageCount,
		account_handle: accountHandle,
		feed: "my_tweets",
	});
}

async function syncMyTweetsViaExtension(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const accountHandle = await resolveAccountHandle(config);
	const maxScrolls = readMaxPages(config);
	const profileUrl = `https://x.com/${encodeURIComponent(accountHandle)}`;

	return syncViaExtension({
		ctx,
		url: profileUrl,
		interceptPatterns: [{ regex: "/i/api/graphql/\\w+/.*UserTweets" }],
		parseResponse: parseBrowserTimelineResponse,
		maxScrolls,
		checkpoint,
		metadata: { account_handle: accountHandle, feed: "my_tweets" },
	});
}

async function syncLikedTweetsViaOAuthApi(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const accessToken = ctx.credentials?.accessToken;
	if (!accessToken) {
		throw new Error("OAuth access token missing for liked_tweets feed");
	}

	const http = createOAuthHttpClient(accessToken);
	const maxPages = readMaxPages(config);
	const authUser = await resolveAuthenticatedUser(http);
	const accountHandle = await resolveAccountHandle(config, http);
	const userId =
		accountHandle === authUser.username
			? authUser.id
			: await resolveUserId(accountHandle, http);

	const { tweets, pageCount } = await paginateTweetEndpoint(
		http,
		(nextToken) => {
			const url = new URL(
				`https://api.x.com/2/users/${encodeURIComponent(userId)}/liked_tweets`,
			);
			url.searchParams.set("max_results", "100");
			url.searchParams.set("tweet.fields", TWEET_FIELDS);
			url.searchParams.set("expansions", "author_id");
			url.searchParams.set("user.fields", "username");
			if (nextToken) {
				url.searchParams.set("pagination_token", nextToken);
			}
			return url;
		},
		maxPages,
	);

	return finalizeSyncResult(tweets, checkpoint, {
		backend: "oauth_api",
		api_calls: pageCount,
		account_handle: accountHandle,
		feed: "liked_tweets",
	}, { originType: "liked_tweet" });
}

async function syncLikedTweetsViaExtension(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const accountHandle = await resolveAccountHandle(config);
	const maxScrolls = readMaxPages(config);
	const likesUrl = `https://x.com/${encodeURIComponent(accountHandle)}/likes`;

	return syncViaExtension({
		ctx,
		url: likesUrl,
		interceptPatterns: [{ regex: "/i/api/graphql/\\w+/.*Like" }],
		parseResponse: parseBrowserTimelineResponse,
		maxScrolls,
		checkpoint,
		metadata: { account_handle: accountHandle, feed: "liked_tweets" },
		originType: "liked_tweet",
	});
}

async function syncBookmarksViaOAuthApi(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const accessToken = ctx.credentials?.accessToken;
	if (!accessToken) {
		throw new Error("OAuth access token missing for bookmarks feed");
	}

	const http = createOAuthHttpClient(accessToken);
	const maxPages = readMaxPages(config);
	const authUser = await resolveAuthenticatedUser(http);

	const { tweets, pageCount } = await paginateTweetEndpoint(
		http,
		(nextToken) => {
			const url = new URL(
				`https://api.x.com/2/users/${encodeURIComponent(authUser.id)}/bookmarks`,
			);
			url.searchParams.set("max_results", "100");
			url.searchParams.set("tweet.fields", TWEET_FIELDS);
			url.searchParams.set("expansions", "author_id");
			url.searchParams.set("user.fields", "username");
			if (nextToken) {
				url.searchParams.set("pagination_token", nextToken);
			}
			return url;
		},
		maxPages,
	);

	return finalizeSyncResult(tweets, checkpoint, {
		backend: "oauth_api",
		api_calls: pageCount,
		feed: "bookmarks",
	}, { originType: "bookmark" });
}

async function syncBookmarksViaExtension(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const maxScrolls = readMaxPages(config);

	return syncViaExtension({
		ctx,
		url: "https://x.com/i/bookmarks",
		interceptPatterns: [{ regex: "/i/api/graphql/\\w+/.*Bookmark" }],
		parseResponse: parseBrowserTimelineResponse,
		maxScrolls,
		checkpoint,
		metadata: { feed: "bookmarks" },
		originType: "bookmark",
	});
}

function parseApiDmListResponse(
	json: XApiDmListResponse,
	authUserId: string,
): XDmMessage[] {
	const users = json.includes?.users ?? [];
	const usernameById = new Map(
		users.map((user) => [user.id, user.username ?? ""]),
	);
	const nameById = new Map(
		users.map((user) => [user.id, user.name ?? ""]),
	);

	return (json.data ?? [])
		.map((event) =>
			buildDmMessage(event, authUserId, usernameById, nameById),
		)
		.filter((message): message is XDmMessage => message !== null);
}

async function syncDirectMessagesViaOAuthApi(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const accessToken = ctx.credentials?.accessToken;
	if (!accessToken) {
		throw new Error(
			"OAuth access token missing for direct_messages feed (requires dm.read)",
		);
	}

	const http = createOAuthHttpClient(accessToken);
	const maxPages = readMaxPages(config);
	const authUser = await resolveAuthenticatedUser(http);
	const messages: XDmMessage[] = [];
	let pageCount = 0;

	const pages = paginateByCursor<XDmMessage, string>(
		async (nextToken) => {
			const url = new URL("https://api.x.com/2/dm_events");
			url.searchParams.set("max_results", "100");
			url.searchParams.set(
				"dm_event.fields",
				"id,text,created_at,sender_id,dm_conversation_id,event_type",
			);
			url.searchParams.set("event_types", "MessageCreate");
			url.searchParams.set("expansions", "sender_id,participant_ids");
			url.searchParams.set("user.fields", "username,name");
			if (nextToken) {
				url.searchParams.set("pagination_token", nextToken);
			}

			const json = await http.get<XApiDmListResponse>(url.toString());
			pageCount += 1;
			return {
				items: parseApiDmListResponse(json, authUser.id),
				nextCursor: json.meta?.next_token,
			};
		},
		{ maxPages },
	);

	for await (const items of pages) {
		messages.push(...items);
	}

	return finalizeDmSyncResult(messages, checkpoint, {
		backend: "oauth_api",
		api_calls: pageCount,
		feed: "direct_messages",
	});
}

async function syncDirectMessagesViaExtension(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const maxScrolls = readMaxPages(config);
	let authUserId =
		typeof config.account_user_id === "string"
			? config.account_user_id.trim()
			: "";

	const result = await extensionNetworkSync<XDmMessage>({
		dispatcher: requireExtensionDispatcher(ctx),
		config: {
			interceptPatterns: [
				{ regex: "/i/api/graphql/\\w+/.*DM" },
				{ regex: "/i/api/graphql/\\w+/.*Dm" },
				{ regex: "/i/api/graphql/\\w+/.*Message" },
				{ regex: "/i/api/graphql/\\w+/.*Inbox" },
			],
			allowedOrigins: X_ALLOWED_ORIGINS,
			maxScrolls,
			scrollDelayMs: 2000,
			responseTimeoutMs: 5000,
		},
		url: "https://x.com/messages",
		parseResponse: (_url, json) => {
			if (!authUserId) {
				authUserId = extractViewerUserId(json) ?? authUserId;
			}
			return parseBrowserDmResponse(_url, json, authUserId);
		},
		checkAuth: (currentUrl) =>
			!currentUrl.includes("/login") && !currentUrl.includes("/i/flow/login"),
	});

	return finalizeDmSyncResult(result.items, checkpoint, {
		backend: result.backend,
		api_calls: result.apiCallCount,
		feed: "direct_messages",
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

const backendPreferenceProperties = {
	use_extension: {
		type: "boolean",
		default: false,
		description:
			"Force the paired Chrome extension even when OAuth is available.",
	},
	use_oauth: {
		type: "boolean",
		default: false,
		description:
			"Force the X API even when scopes are missing (will fail unless re-authorized).",
	},
} as const;

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
		...backendPreferenceProperties,
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

const accountTimelineConfigSchema = {
	type: "object",
	properties: {
		account_handle: {
			type: "string",
			minLength: 1,
			description:
				'Optional X handle (e.g. "buremba"). Defaults to the authenticated account when OAuth is available.',
		},
		max_scrolls: {
			type: "integer",
			minimum: 1,
			maximum: 50,
			default: 10,
			description:
				"Maximum pagination iterations (default: 10, API pages or browser scrolls)",
		},
		...backendPreferenceProperties,
	},
};

const bookmarksConfigSchema = {
	type: "object",
	properties: {
		account_handle: {
			type: "string",
			minLength: 1,
			description:
				'Optional X handle (e.g. "buremba") for DM counterparty resolution when the viewer id is unavailable.',
		},
		account_user_id: {
			type: "string",
			minLength: 1,
			description:
				"Optional numeric X user id for DM from_me / counterparty resolution on the extension path.",
		},
		max_scrolls: {
			type: "integer",
			minimum: 1,
			maximum: 50,
			default: 10,
			description:
				"Maximum pagination iterations (default: 10, API pages or browser scrolls)",
		},
		...backendPreferenceProperties,
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
		author_id: { type: "string", description: "X numeric user id" },
		author_handle: { type: "string", description: "X @handle without @" },
		author_name: { type: "string", description: "Display name" },
	},
};

const dmMetadataSchema = {
	type: "object",
	properties: {
		sender_id: { type: "string" },
		sender_handle: { type: "string" },
		sender_name: { type: "string" },
		participant_id: { type: "string" },
		participant_handle: { type: "string" },
		participant_name: { type: "string" },
		from_me: { type: "boolean" },
		is_group: { type: "boolean" },
		dm_conversation_id: { type: "string" },
	},
};

// ── Connector ──────────────────────────────────────────────────

export default class XConnector extends ConnectorRuntime {
	readonly definition: ConnectorDefinition = {
		key: "x",
		name: "X (Twitter)",
		description:
			"Fetches tweets, likes, bookmarks, and DMs via the X API v2 or the paired Owletto Chrome extension. Links authors and DM counterparts into the person identity graph.",
		version: "3.3.2",
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
						"dm.read",
					],
					loginScopes: [
						"users.read",
						"tweet.read",
						"like.read",
						"bookmark.read",
						"dm.read",
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
				description:
					"Search and sync tweets matching a query or a specific account handle.",
				configSchema: searchConfigSchema,
				eventKinds: {
					tweet: {
						description: "A tweet (original post)",
						metadataSchema: engagementMetadataSchema,
						attributions: X_TWEET_AUTHOR_ATTRIBUTIONS,
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
						attributions: X_TWEET_AUTHOR_ATTRIBUTIONS,
					},
				},
			},
			my_tweets: {
				key: "my_tweets",
				name: "My Posts",
				description:
					"Posts and replies authored by the connected account. Uses the X API when OAuth is available, otherwise the paired Chrome extension.",
				configSchema: accountTimelineConfigSchema,
				eventKinds: {
					tweet: {
						description: "An original post by the connected account",
						metadataSchema: engagementMetadataSchema,
						attributions: X_TWEET_AUTHOR_ATTRIBUTIONS,
					},
					reply: {
						description: "A reply posted by the connected account",
						metadataSchema: {
							...engagementMetadataSchema,
							properties: {
								...engagementMetadataSchema.properties,
								conversation_id: { type: "string" },
							},
						},
						attributions: X_TWEET_AUTHOR_ATTRIBUTIONS,
					},
				},
			},
			liked_tweets: {
				key: "liked_tweets",
				name: "Liked Posts",
				description:
					"Posts the connected account has liked. Uses the X API when OAuth is available, otherwise the paired Chrome extension.",
				configSchema: accountTimelineConfigSchema,
				eventKinds: {
					liked_tweet: {
						description: "A post liked by the connected account",
						metadataSchema: engagementMetadataSchema,
						attributions: X_TWEET_AUTHOR_ATTRIBUTIONS,
					},
				},
			},
			bookmarks: {
				key: "bookmarks",
				name: "Bookmarks",
				description:
					"Posts bookmarked by the connected account. Uses the X API when OAuth is available, otherwise the paired Chrome extension.",
				configSchema: bookmarksConfigSchema,
				eventKinds: {
					bookmark: {
						description: "A post bookmarked by the connected account",
						metadataSchema: engagementMetadataSchema,
						attributions: X_TWEET_AUTHOR_ATTRIBUTIONS,
					},
				},
			},
			direct_messages: {
				key: "direct_messages",
				name: "Direct Messages",
				description:
					"Direct message events across all conversations. Uses the X API when dm.read is granted, otherwise the paired Chrome extension on /messages. Auto-creates person entities for 1:1 counterparts.",
				configSchema: bookmarksConfigSchema,
				eventKinds: {
					dm_message: {
						description: "A direct message in a 1:1 or group conversation",
						metadataSchema: dmMetadataSchema,
						attributions: X_DM_COUNTERPARTY_ATTRIBUTIONS,
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
						attributions: X_TWEET_AUTHOR_ATTRIBUTIONS,
					},
				},
			},
		},
	};

	async sync(ctx: SyncContext): Promise<SyncResult> {
		const config = ctx.config as Record<string, unknown>;
		const checkpoint = (ctx.checkpoint ?? {}) as XCheckpoint;
		const feedKey = ctx.feedKey ?? "tweets";
		const oauthScopes = X_OAUTH_FEED_SCOPES[feedKey];

		// The home timeline has no public API — it is always served by the
		// extension, regardless of whether an OAuth token is present.
		if (feedKey === "home_feed") {
			return syncHomeFeedViaDomScrape(ctx, config, checkpoint);
		}

		if (feedKey === "my_tweets") {
			if (
				resolveSyncBackend(ctx, config, oauthScopes) === "oauth_api"
			) {
				return syncOAuthWithOptionalFallback(
					config,
					() => syncMyTweetsViaOAuthApi(ctx, config, checkpoint),
					() => syncMyTweetsViaExtension(ctx, config, checkpoint),
				);
			}
			return syncMyTweetsViaExtension(ctx, config, checkpoint);
		}

		if (feedKey === "liked_tweets") {
			if (
				resolveSyncBackend(ctx, config, oauthScopes) === "oauth_api"
			) {
				return syncOAuthWithOptionalFallback(
					config,
					() => syncLikedTweetsViaOAuthApi(ctx, config, checkpoint),
					() => syncLikedTweetsViaExtension(ctx, config, checkpoint),
				);
			}
			return syncLikedTweetsViaExtension(ctx, config, checkpoint);
		}

		if (feedKey === "bookmarks") {
			if (
				resolveSyncBackend(ctx, config, oauthScopes) === "oauth_api"
			) {
				return syncOAuthWithOptionalFallback(
					config,
					() => syncBookmarksViaOAuthApi(ctx, config, checkpoint),
					() => syncBookmarksViaExtension(ctx, config, checkpoint),
				);
			}
			return syncBookmarksViaExtension(ctx, config, checkpoint);
		}

		if (feedKey === "direct_messages") {
			if (
				resolveSyncBackend(ctx, config, oauthScopes) === "oauth_api"
			) {
				return syncOAuthWithOptionalFallback(
					config,
					() => syncDirectMessagesViaOAuthApi(ctx, config, checkpoint),
					() => syncDirectMessagesViaExtension(ctx, config, checkpoint),
				);
			}
			return syncDirectMessagesViaExtension(ctx, config, checkpoint);
		}

		// `tweets` feed: prefer the official API when scopes are sufficient,
		// otherwise the extension's signed-in search.
		if (
			resolveSyncBackend(ctx, config, oauthScopes) === "oauth_api"
		) {
			return syncOAuthWithOptionalFallback(
				config,
				() => syncViaOAuthApi(ctx, config, checkpoint),
				() => syncSearchViaExtension(ctx, config, checkpoint),
			);
		}

		return syncSearchViaExtension(ctx, config, checkpoint);
	}
}
