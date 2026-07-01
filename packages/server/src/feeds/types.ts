// Shape returned by GET /api/v1/connections/{id}/feeds. A projection of the
// `feeds` table into the camelCase the frontend consumes.

export type FeedKind = "collected" | "streaming" | "virtual";
export type FeedStatus = "active" | "paused" | "error";

export interface FeedSpec {
	/** `feeds.id`, stringified (bigint). */
	id: string;
	/** `feeds.feed_key` — for a streaming (chat) feed this is the channel id. */
	feedKey: string;
	kind: FeedKind;
	connectionId: string;
	/** `display_name`, falling back to `feed_key`. */
	label: string;
	status: FeedStatus;
	virtual: boolean;
	/** ISO timestamp of the last sync, or null. */
	lastSyncAt: string | null;
	itemsCollected: number;
	/** For a streaming feed, the agent bound to its channel (if any). */
	targetAgentId?: string | null;
}
