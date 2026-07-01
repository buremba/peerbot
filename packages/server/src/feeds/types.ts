/**
 * The feed model vocabulary. A feed is a row in the `feeds` table, owned by a
 * connection (`feeds.connection_id` → `connections.id`). Every data source under
 * a connection is one of three kinds, discriminated by `feeds.kind`:
 *   - collected: synced rows materialized into `events` (classic data feed).
 *   - streaming: a bound chat channel; content is the live `channel_messages`
 *     transcript, never synced (`ensureStreamingChannelFeed`).
 *   - virtual:   read live via the connector `query()` at access time (also
 *     carries `feeds.virtual = true`; the scheduler skips it).
 */

/** `feeds.kind` — the source discriminator. */
export type FeedKind = "collected" | "streaming" | "virtual";

/**
 * The uniform descriptor for a feed under a connection, across all kinds.
 * Enumeration (`listConnectionFeeds`, the connection rail) produces these
 * directly from the `feeds` table.
 */
export interface FeedSpec {
  /** `feeds.id`, stringified. */
  id: string;
  /** `feeds.feed_key` — the channel id for a streaming feed, else the source key. */
  feedKey: string;
  kind: FeedKind;
  /** Owning connection id (`connections.id`, stringified). */
  connectionId: string;
  /** Human label (`feeds.display_name`; falls back to the feed key). */
  label: string;
  status: "active" | "paused" | "error";
  /** True for a live-query (virtual) feed. */
  virtual: boolean;
  /** ISO timestamp of the last sync, or null (streaming feeds are never synced). */
  lastSyncAt: string | null;
  /** Rows collected so far (0 for streaming/virtual). */
  itemsCollected: number;
  /** Routed agent — streaming feeds only (the agent that bound the channel). */
  targetAgentId?: string | null;
}
