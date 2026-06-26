/**
 * The feed model vocabulary — shared seam for the feed-enumeration and the
 * read-side (`FeedReader`) registry. See `docs/plans/feeds-and-connections-model.md`.
 *
 * A connection is a *queryable source*; a feed is a *view* over it, generated on
 * the fly at access time (materialization is an optimization, not the model).
 * A feed is described by two ORTHOGONAL axes — do NOT collapse them into one enum:
 *   - source kind: WHERE the bytes live;
 *   - read lens:   HOW the caller queries them.
 */

/** Axis 1 — where a feed's data lives. */
export type FeedSourceKind =
  /** Live chat transcript in `channel_messages` (Slack/Telegram channels & DMs). */
  | "chat-channel"
  /** External source queried live via the connector `query()` — nothing copied. */
  | "virtual-live-dataset"
  /** Synced rows materialized into `events` (the classic data feed = `feeds` row). */
  | "collected";

/** Axis 2 — how a feed is read. Independent of the source kind. */
export type FeedLensKind =
  /** Fuzzy / keyword retrieval — `search_memory`. */
  | "recall"
  /** Aggregation → `metric_series` — `query_metric`. */
  | "metric"
  /** Scoped SQL via `QUERYABLE_SCHEMA` → `buildScopedQuery` CTEs — `query_sql`. */
  | "raw-sql";

/**
 * The uniform descriptor for a feed under a connection, across all source kinds.
 * Enumeration (the connection rail / `listConnectionFeeds`) produces these; the
 * read-side registry consumes the `sourceKind` to dispatch a lens.
 *
 * `connectionId` is intentionally a string: chat-channel feeds belong to an
 * `agent_connections` row (text id), while collected/virtual feeds belong to a
 * `connections` row (bigint id, stringified). The two tables are distinct
 * namespaces — callers must already know which connection they are listing.
 */
export interface FeedSpec {
  /** Stable id within its connection: `channel_id` for chat-channel, `feed_key` for collected/virtual. */
  id: string;
  sourceKind: FeedSourceKind;
  /** Owning connection id (text for chat-channel, stringified bigint otherwise). */
  connectionId: string;
  /** Human label (channel name once resolved; falls back to the raw id). */
  label: string;
  status: "active" | "paused" | "error";
  /** ISO timestamp of the latest activity, or null when the feed has none yet. */
  lastActivityAt: string | null;
  /** Routed agent — chat-channel feeds only (decorated from `agent_channel_bindings`). */
  targetAgentId?: string | null;
  /** Cheap activity count for the rail (chat-channel = message count). */
  itemCount?: number;
}
