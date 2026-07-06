import { type Static, Type } from "@sinclair/typebox";

const PaginationFields = {
  limit: Type.Optional(
    Type.Number({ description: "Page size (default: 100)", default: 100 })
  ),
  offset: Type.Optional(
    Type.Number({ description: "Pagination offset (default: 0)", default: 0 })
  ),
};

// ============================================
// Schema
// ============================================

export const ListFeedsAction = Type.Object({
  action: Type.Literal("list_feeds", {
    description: "Paginated list of feeds with filters.",
  }),
  connection_id: Type.Optional(
    Type.Number({ description: "Filter by connection ID" })
  ),
  feed_ids: Type.Optional(
    Type.Array(Type.Integer({ minimum: 1 }), {
      description: "Filter to specific feed IDs",
    })
  ),
  entity_id: Type.Optional(
    Type.Number({ description: "Filter by linked entity ID" })
  ),
  status: Type.Optional(
    Type.String({ description: "Filter by status: active, paused, error" })
  ),
  ...PaginationFields,
});

// One read action for any feed kind. A collected/virtual feed returns its
// metadata + recent sync runs; a streaming (chat-channel) feed has no sync runs
// — its content is the live transcript in `channel_messages` — so it returns
// that instead, read through the same primitive read_conversation uses. The
// caller never has to know the kind up front; the response carries it.
export const ReadFeedAction = Type.Object({
  action: Type.Literal("read_feed", {
    description:
      "Read one feed (metadata + recent runs, or live transcript for streaming feeds).",
  }),
  feed_id: Type.Number({ description: "Feed ID" }),
  limit: Type.Optional(
    Type.Number({
      description: "Max transcript messages for a streaming feed (default 50)",
    })
  ),
});

export const ReadFeedsAction = Type.Object({
  action: Type.Literal("read_feeds", {
    description:
      "Read several feeds in parallel. Each feed returns independently as { ok, result } or { ok:false, error }.",
  }),
  feed_ids: Type.Array(Type.Integer({ minimum: 1 }), {
    minItems: 1,
    maxItems: 10,
    description: "Feed IDs to read in parallel (max 10).",
  }),
  limit: Type.Optional(
    Type.Number({
      description:
        "Per-feed row/message limit for live feed kinds (default 50)",
    })
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description:
        "Per-feed timeout in milliseconds (default 10000, max 30000).",
      minimum: 1000,
      maximum: 30000,
    })
  ),
});

export const CreateFeedAction = Type.Object({
  action: Type.Literal("create_feed", {
    description: "Create a feed on a connection.",
  }),
  connection_id: Type.Number({
    description: "Connection ID this feed belongs to",
  }),
  feed_key: Type.String({
    description: "Feed key from connector definition (e.g. threads)",
  }),
  display_name: Type.Optional(
    Type.String({ description: "Human-readable name for this feed" })
  ),
  entity_ids: Type.Optional(
    Type.Array(Type.Number(), { description: "Entity IDs to tag events with" })
  ),
  config: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: "Feed-specific configuration",
    })
  ),
  schedule: Type.Optional(
    Type.String({
      description: "Cron expression for sync schedule (default: every 6 hours)",
    })
  ),
  virtual: Type.Optional(
    Type.Boolean({
      description:
        "When true, create a VIRTUAL feed (kind=virtual): read LIVE via the connector query()/search() pushdown at request time, never synced — sync-lifecycle columns stay NULL. Optional config.query sets a default scope; agents narrow via query_sql search_term (connector interprets it).",
    })
  ),
});

export const UpdateFeedAction = Type.Object({
  action: Type.Literal("update_feed", {
    description: "Patch a feed (status, config, schedule, repair agent).",
  }),
  feed_id: Type.Number({ description: "Feed ID" }),
  status: Type.Optional(Type.String({ description: "active, paused, error" })),
  display_name: Type.Optional(Type.String()),
  entity_ids: Type.Optional(Type.Array(Type.Number())),
  config: Type.Optional(Type.Record(Type.String(), Type.Any())),
  replace_config: Type.Optional(
    Type.Boolean({
      description:
        "When true and `config` is provided, replace the stored feed config with exactly that object (declarative apply); when false/omitted, merge into the existing config (default).",
    })
  ),
  schedule: Type.Optional(
    Type.String({ description: "Cron expression for sync schedule" })
  ),
  repair_agent_id: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        "Per-feed repair agent override. Null clears the override and falls back to the connector default.",
    })
  ),
});

export const DeleteFeedAction = Type.Object({
  action: Type.Literal("delete_feed", {
    description: "Soft-delete a feed and cancel its active runs.",
  }),
  feed_id: Type.Number({ description: "Feed ID" }),
});

export const TriggerFeedAction = Type.Object({
  action: Type.Literal("trigger_feed", {
    description: "Trigger an immediate sync run for a collected feed.",
  }),
  feed_id: Type.Number({ description: "Feed ID to trigger sync for" }),
});

// ============================================
// Result Types
// ============================================

/**
 * Result of `manage_feeds` — discriminated union (on `action`, plus an error
 * variant). TypeBox-first: `Static<>` derives the TS type from the same schema
 * exposed as the tool's `outputSchema`. Feed rows are wide, join-driven
 * snapshots (no stable contract), so they're honestly `Record<string, unknown>`.
 */
export const ManageFeedsResultSchema = Type.Union([
  Type.Object({ error: Type.String() }),
  Type.Object({
    action: Type.Literal("list_feeds"),
    feeds: Type.Array(Type.Record(Type.String(), Type.Unknown())),
    total: Type.Integer(),
    limit: Type.Integer(),
    offset: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal("read_feed"),
    kind: Type.String(),
    feed: Type.Record(Type.String(), Type.Unknown()),
    recent_runs: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  }),
  Type.Object({
    action: Type.Literal("read_feed"),
    kind: Type.Literal("streaming"),
    feed: Type.Record(Type.String(), Type.Unknown()),
    messages: Type.Array(
      Type.Object({
        timestamp: Type.String(),
        user: Type.String(),
        text: Type.String(),
        isBot: Type.Boolean(),
      })
    ),
  }),
  Type.Object({
    action: Type.Literal("read_feed"),
    kind: Type.Literal("virtual"),
    feed: Type.Record(Type.String(), Type.Unknown()),
    rows: Type.Array(Type.Record(Type.String(), Type.Unknown())),
    columns: Type.Array(
      Type.Object({ name: Type.String(), type: Type.String() })
    ),
    total: Type.Optional(Type.Integer()),
  }),
  Type.Object({
    action: Type.Literal("read_feeds"),
    results: Type.Array(
      Type.Object({
        feed_id: Type.Integer(),
        ok: Type.Boolean(),
        result: Type.Optional(Type.Unknown()),
        error: Type.Optional(Type.String()),
      })
    ),
    failures: Type.Integer(),
    timeout_ms: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal("create_feed"),
    feed: Type.Record(Type.String(), Type.Unknown()),
  }),
  Type.Object({
    action: Type.Literal("update_feed"),
    feed: Type.Record(Type.String(), Type.Unknown()),
  }),
  Type.Object({
    action: Type.Literal("delete_feed"),
    deleted: Type.Literal(true),
    feed_id: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal("trigger_feed"),
    triggered: Type.Literal(true),
    run_id: Type.Integer(),
    feed_id: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal("trigger_feed"),
    message: Type.String(),
  }),
]);
export type ManageFeedsResult = Static<typeof ManageFeedsResultSchema>;

export const ManageFeedsSchema = Type.Union([
  ListFeedsAction,
  ReadFeedAction,
  ReadFeedsAction,
  CreateFeedAction,
  UpdateFeedAction,
  DeleteFeedAction,
  TriggerFeedAction,
]);

export type ManageFeedsArgs = Static<typeof ManageFeedsSchema>;
