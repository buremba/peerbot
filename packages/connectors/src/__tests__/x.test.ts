import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';

// Stub @lobu/connector-sdk (it pulls in playwright) so the connector imports
// without the browser stack. Shared superset — see connector-sdk.mock.ts.
mock.module('@lobu/connector-sdk', connectorSdkMock);

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let parseBrowserSearchResponse: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let parseBrowserTimelineResponse: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let extractTweetsFromInstructions: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let finalizeSyncResult: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let XConnector: any;

beforeAll(async () => {
	const mod = await import('../x');
	parseBrowserSearchResponse = mod.parseBrowserSearchResponse;
	parseBrowserTimelineResponse = mod.parseBrowserTimelineResponse;
	extractTweetsFromInstructions = mod.extractTweetsFromInstructions;
	finalizeSyncResult = mod.finalizeSyncResult;
	XConnector = mod.default;
});

// A tweet_results.result node in x.com's GraphQL shape. `restId`/`legacy` is
// what every timeline emits; `core.user_results.result` carries the author.
function tweetResult(restId: string, screenName: string, text: string, extra: Record<string, unknown> = {}) {
	return {
		__typename: 'Tweet',
		rest_id: restId,
		core: { user_results: { result: { core: { screen_name: screenName } } } },
		legacy: {
			id_str: restId,
			full_text: text,
			created_at: 'Wed Jun 04 12:00:00 +0000 2025',
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
	return { data: { search_by_raw_query: { search_timeline: { timeline: { instructions } } } } };
}

function wrapHomeInstructions(instructions: unknown[]) {
	return { data: { home: { home_timeline_urt: { instructions } } } };
}

describe('extractTweetsFromInstructions', () => {
	test('reads tweet items from TimelineAddEntries', () => {
		const instructions = [
			{
				entries: [
					{
						entryId: 'tweet-100',
						content: { itemContent: { tweet_results: { result: tweetResult('100', 'alice', 'hello world') } } },
					},
					{
						entryId: 'tweet-101',
						content: { itemContent: { tweet_results: { result: tweetResult('101', 'bob', 'second') } } },
					},
					// A cursor entry — must be ignored, not crash.
					{ entryId: 'cursor-top-abc', content: { entryType: 'TimelineTimelineCursor' } },
				],
			},
		];

		const tweets = extractTweetsFromInstructions(instructions);
		expect(tweets).toHaveLength(2);
		expect(tweets[0]).toMatchObject({ id: '100', username: 'alice', text: 'hello world', promoted: false });
		expect(tweets[1]).toMatchObject({ id: '101', username: 'bob' });
	});

	test('drops promoted tweets (entryId prefix AND promotedMetadata)', () => {
		const instructions = [
			{
				entries: [
					{
						entryId: 'promoted-tweet-200',
						content: { itemContent: { tweet_results: { result: tweetResult('200', 'adbrand', 'buy now') } } },
					},
					{
						entryId: 'tweet-201',
						content: { itemContent: { tweet_results: { result: { ...tweetResult('201', 'realbrand', 'genuine'), promotedMetadata: { advertiser: 'x' } } } } },
					},
					{
						entryId: 'tweet-202',
						content: { itemContent: { tweet_results: { result: tweetResult('202', 'carol', 'keep me') } } },
					},
				],
			},
		];

		const tweets = extractTweetsFromInstructions(instructions);
		expect(tweets.map((t: any) => t.id)).toEqual(['202']);
	});

	test('unwraps TweetWithVisibilityResults and conversation modules', () => {
		const instructions = [
			{
				entries: [
					{
						// A visibility-limited tweet nests the real node under .tweet.
						entryId: 'tweet-300',
						content: { itemContent: { tweet_results: { result: { __typename: 'TweetWithVisibilityResults', tweet: tweetResult('300', 'dave', 'limited') } } } },
					},
					{
						// A conversation thread module: root + one threaded reply.
						entryId: 'conversationthread-400',
						content: {
							items: [
								{ item: { itemContent: { tweet_results: { result: tweetResult('400', 'eve', 'root') } } } },
								{ item: { itemContent: { tweet_results: { result: tweetResult('401', 'frank', 'reply') } } } },
							],
						},
					},
				],
			},
		];

		const tweets = extractTweetsFromInstructions(instructions);
		expect(tweets.map((t: any) => t.id).sort()).toEqual(['300', '400', '401']);
	});
});

describe('parseBrowserSearchResponse', () => {
	test('reads search_by_raw_query instructions', () => {
		const json = wrapSearchInstructions([
			{ entries: [{ entryId: 'tweet-1', content: { itemContent: { tweet_results: { result: tweetResult('1', 'alice', 'search hit') } } } }] },
		]);
		const tweets = parseBrowserSearchResponse('https://x.com/search?q=x', json);
		expect(tweets).toHaveLength(1);
		expect(tweets[0]).toMatchObject({ id: '1', username: 'alice', text: 'search hit' });
	});

	test('returns [] for an unrelated response shape', () => {
		expect(parseBrowserSearchResponse('https://x.com/', { data: {} })).toEqual([]);
	});
});

describe('parseBrowserTimelineResponse', () => {
	test('reads home_timeline_urt instructions', () => {
		const json = wrapHomeInstructions([
			{ entries: [{ entryId: 'tweet-9', content: { itemContent: { tweet_results: { result: tweetResult('9', 'home', 'on my timeline') } } } }] },
		]);
		const tweets = parseBrowserTimelineResponse('https://x.com/home', json);
		expect(tweets).toHaveLength(1);
		expect(tweets[0]).toMatchObject({ id: '9', username: 'home' });
	});

	test('returns [] for a search-shaped response', () => {
		const json = wrapSearchInstructions([
			{ entries: [{ entryId: 'tweet-1', content: { itemContent: { tweet_results: { result: tweetResult('1', 'a', 'x') } } } }] },
		]);
		// Home parser must NOT accidentally read search responses (different path).
		expect(parseBrowserTimelineResponse('https://x.com/home', json)).toEqual([]);
	});
});

describe('finalizeSyncResult', () => {
	test('dedupes by id, sorts newest-first, advances checkpoint to newest', () => {
		const tweets = [
			{ id: '3', text: 'c', username: 'a', publishedAt: new Date('2025-06-03T00:00:00Z') },
			{ id: '1', text: 'a', username: 'a', publishedAt: new Date('2025-06-01T00:00:00Z') },
			{ id: '3', text: 'c-dupe', username: 'a', publishedAt: new Date('2025-06-03T00:00:00Z') },
			{ id: '2', text: 'b', username: 'a', publishedAt: new Date('2025-06-02T00:00:00Z') },
		];
		const res = finalizeSyncResult(tweets as any, {}, { backend: 'extension' });

		expect(res.events.map((e: any) => e.origin_id)).toEqual(['3', '2', '1']);
		expect(res.checkpoint).toMatchObject({ last_tweet_id: '3' });
		expect(res.metadata).toMatchObject({ items_found: 3, items_skipped: 1, backend: 'extension' });
	});

	test('drops the tweet equal to the checkpoint boundary', () => {
		const tweets = [{ id: '5', text: 'seen', username: 'a', publishedAt: new Date('2025-06-05T00:00:00Z') }];
		const res = finalizeSyncResult(tweets as any, { last_tweet_id: '5' }, {});
		expect(res.events).toHaveLength(0);
		expect(res.checkpoint.last_tweet_id).toBe('5');
	});

	test('preserves prior checkpoint when nothing new was emitted', () => {
		const res = finalizeSyncResult([], { last_tweet_id: '7', last_timestamp: 'old' }, {});
		expect(res.checkpoint).toMatchObject({ last_tweet_id: '7', last_timestamp: 'old' });
	});
});

describe('XConnector definition', () => {
	test('declares both the search feed and the extension-only home timeline feed', () => {
		const def = new XConnector().definition;
		expect(def.key).toBe('x');
		expect(Object.keys(def.feeds).sort()).toEqual(['home_feed', 'tweets']);
		expect(def.feeds.home_feed.description).toMatch(/home timeline/i);
		// Extension is the browser fallback method (no public API for the timeline).
		const browserMethod = def.authSchema.methods.find((m: any) => m.type === 'browser');
		expect(browserMethod).toBeDefined();
	});
});
