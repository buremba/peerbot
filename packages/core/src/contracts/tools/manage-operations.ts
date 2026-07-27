import { type Static, Type } from "@sinclair/typebox";

const PaginationFields = {
  limit: Type.Optional(
    Type.Number({ description: "Page size (default: 100)", default: 100 })
  ),
  offset: Type.Optional(
    Type.Number({ description: "Pagination offset (default: 0)", default: 0 })
  ),
};

export const BackendLiteral = Type.Union(
  [
    Type.Literal("local_action"),
    Type.Literal("mcp_tool"),
    Type.Literal("http_operation"),
  ],
  { description: "Filter by operation backend type" }
);

export const KindLiteral = Type.Union(
  [Type.Literal("read"), Type.Literal("write")],
  { description: "Filter by operation kind (read/write)" }
);

export const ListAvailableAction = Type.Object({
  action: Type.Literal("list_available", {
    description:
      "Discover connector operations (capabilities) across bundled, custom, and device connectors, with per-operation connection readiness. Returns a PUBLIC DTO (no backend_config). Capabilities stay discoverable even with no connection; use the readiness + next_action fields to drive discover → connect/setup → poll → execute.",
  }),
  connector_key: Type.Optional(
    Type.String({ description: "Filter by connector key" })
  ),
  connection_id: Type.Optional(
    Type.Number({ description: "Filter by connection ID" })
  ),
  entity_id: Type.Optional(Type.Number({ description: "Filter by entity ID" })),
  kind: Type.Optional(KindLiteral),
  backend: Type.Optional(BackendLiteral),
  query: Type.Optional(
    Type.String({
      description:
        "Data-driven search over connector name/key, operation name/key, description, and input-schema property names/terms. A query like 'github create issue' returns matching capabilities across every installed connector (including ones with no connection yet).",
    })
  ),
  include_disconnected: Type.Optional(
    Type.Boolean({
      default: true,
      description:
        "Include capabilities whose connector has NO ready connection (default true). Set false to list only executable operations.",
    })
  ),
  include_input_schema: Type.Optional(
    Type.Boolean({
      default: true,
      description: "Include input schema in response",
    })
  ),
  include_output_schema: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Include output schema in response",
    })
  ),
  // Shared with list_runs — same limit/offset defaults + descriptions, and a
  // future PaginationFields edit reaches both actions instead of silently
  // skipping this hand-inlined copy.
  ...PaginationFields,
});

export const ExecuteAction = Type.Object({
  action: Type.Literal("execute", {
    description:
      "Execute an operation; may queue for approval / device / inline.",
  }),
  connection_id: Type.Number({ description: "Connection ID to execute on" }),
  operation_key: Type.String({ description: "Connector-local operation key" }),
  input: Type.Optional(
    Type.Record(Type.String(), Type.Any(), { description: "Operation input" })
  ),
  behavior_source: Type.Optional(
    Type.Object({
      behavior_id: Type.Number(),
      window_id: Type.Number(),
    })
  ),
});

/**
 * Run types excluded from `list_runs` when the caller does not name run types
 * explicitly. Every chat reply AND every non-terminal streaming delta is
 * persisted as a `runs` row with run_type='chat_message' (the thread_response
 * queue lane), so an unfiltered list buries real operational history under
 * tens of thousands of streaming fragments (#2051). Pass
 * `run_types: ['chat_message']` to get the low-level trace view.
 */
export const LIST_RUNS_DEFAULT_EXCLUDED_RUN_TYPES = ["chat_message"] as const;

export const ListRunsAction = Type.Object({
  action: Type.Literal("list_runs", {
    description:
      "Paginated operational run list with keyset cursor support. Chat-message transport runs (complete replies + streaming deltas, run_type='chat_message') are excluded unless explicitly requested via run_types.",
  }),
  connection_id: Type.Optional(
    Type.Number({ description: "Filter by connection ID" })
  ),
  connection_ids: Type.Optional(
    Type.Array(Type.Number({ description: "Filter by connection IDs" }))
  ),
  feed_ids: Type.Optional(
    Type.Array(Type.Number({ description: "Filter by feed IDs" }))
  ),
  device_worker_id: Type.Optional(
    Type.String({ description: "Filter by device worker ID" })
  ),
  connector_key: Type.Optional(
    Type.String({ description: "Filter by connector key (e.g. 'github')" })
  ),
  operation_key: Type.Optional(
    Type.String({ description: "Filter by operation key" })
  ),
  status: Type.Optional(Type.String({ description: "Filter by run status" })),
  approval_status: Type.Optional(
    Type.String({ description: "Filter by approval status" })
  ),
  /**
   * Filter by run_type. Omit to list every OPERATIONAL run type (sync, action,
   * behavior, auth, …) — chat-message transport runs are excluded by default
   * (see LIST_RUNS_DEFAULT_EXCLUDED_RUN_TYPES); name 'chat_message' explicitly
   * to inspect that low-level trace lane.
   */
  run_types: Type.Optional(
    Type.Array(Type.String({ description: "Filter by run types" }))
  ),
  created_after: Type.Optional(
    Type.String({
      description:
        "Only runs created at or after this ISO 8601 timestamp (inclusive)",
    })
  ),
  created_before: Type.Optional(
    Type.String({
      description:
        "Only runs created before this ISO 8601 timestamp (exclusive)",
    })
  ),
  /** Filter behavior runs by behavior id(s). */
  behavior_ids: Type.Optional(
    Type.Array(Type.Number({ description: "Filter by persisted Behavior IDs" }))
  ),
  /** Keyset cursor: return runs ordered before (before_created_at, before_id). */
  before_id: Type.Optional(
    Type.Number({ description: "Keyset cursor: return runs before this ID" })
  ),
  before_created_at: Type.Optional(
    Type.String({
      description: "Keyset cursor: return runs before this timestamp",
    })
  ),
  ...PaginationFields,
});

export const GetRunAction = Type.Object({
  action: Type.Literal("get_run", {
    description: "Fetch one connector action or internal approval run.",
  }),
  run_id: Type.Number(),
});

/**
 * Unified workspace attention feed for Home UI + agent context.
 * Member-readable (same tier as list_runs). Optionally collapses adjacent
 * same-connection/same-status runs; always returns deep-links (`href`).
 */
export const ListActivityAction = Type.Object({
  action: Type.Literal("list_activity", {
    description:
      "Org attention feed: notifications + recent user-facing runs (Behavior/sync/action/internal), with optional adjacent aggregation and deep-links for the UI and agent context.",
  }),
  limit: Type.Optional(
    Type.Integer({
      description: "Max cards after aggregation (default 24, max 50)",
      default: 24,
      minimum: 1,
      maximum: 50,
    })
  ),
  /** Include notifications (default true when user is authenticated). */
  include_notifications: Type.Optional(Type.Boolean({ default: true })),
  /** Include runs (default true). */
  include_runs: Type.Optional(Type.Boolean({ default: true })),
  /**
   * Collapse adjacent same-connection (or behavior) runs that share status.
   * Failures never merge with successes. Default true.
   */
  aggregate: Type.Optional(Type.Boolean({ default: true })),
  /** Restrict run kinds: behavior | sync | action | notification (default all). */
  kinds: Type.Optional(Type.Array(Type.String())),
  /**
   * Scope the feed to a single agent: only that agent's Behavior runs are
   * returned and notifications are excluded (they are org/user-scoped, not
   * per-agent). Omit for the org-wide feed (Home).
   */
  agent_id: Type.Optional(
    Type.String({ description: "Scope activity to a single agent's runs" })
  ),
});

export const ApproveAction = Type.Object({
  action: Type.Literal("approve", {
    description:
      "Approve a pending run (also handles agent + entity_field_change gates).",
  }),
  run_id: Type.Number(),
  input: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

export const RejectAction = Type.Object({
  action: Type.Literal("reject", {
    description: "Reject a pending run.",
  }),
  run_id: Type.Number(),
  reason: Type.Optional(Type.String()),
});

/**
 * Explicit scope for a batch decision over queued connector-operation approvals
 * (`run_type='action'`), the lane that accumulates when nobody decides.
 *
 * At least one narrowing filter is REQUIRED — there is deliberately no
 * "decide everything pending" shape. Batch APPROVE executes queued side effects
 * en masse, so the caller must name what they are approving; an unscoped sweep
 * would let one click fire every queued write in the org.
 */
export const ApprovalBatchScope = Type.Object(
  {
    connection_id: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Only approvals queued against this connection.",
      })
    ),
    connector_key: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Only approvals for this connector (e.g. 'github').",
      })
    ),
    action_key: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Only approvals for this operation key.",
      })
    ),
    behavior_id: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Only approvals queued by this Behavior.",
      })
    ),
    older_than_days: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Only approvals queued more than this many days ago. Narrows further; never widens.",
      })
    ),
  },
  {
    description:
      "Scope filters for a connector-approval batch. At least one of connection_id / connector_key / action_key / behavior_id is required.",
  }
);

export const ApproveBatchAction = Type.Object({
  action: Type.Literal("approve_batch", {
    description:
      "Approve many pending approvals at once. Either scope by window_id (a Behavior run's proposals) or by `scope` (queued connector operations). Exactly one of the two is required — there is no unscoped approve-everything.",
  }),
  window_id: Type.Optional(Type.Number()),
  scope: Type.Optional(ApprovalBatchScope),
  run_ids: Type.Optional(
    Type.Array(Type.Integer({ minimum: 1 }), {
      minItems: 1,
      maxItems: 5000,
      uniqueItems: true,
      description:
        "Exact proposal run IDs shown to the reviewer. The batch fails closed if the pending set changed.",
    })
  ),
});

export const RejectBatchAction = Type.Object({
  action: Type.Literal("reject_batch", {
    description:
      "Reject many pending approvals at once. Either scope by window_id (a Behavior run's proposals — the reason is fed back so the agent revises) or by `scope` (queued connector operations). Exactly one of the two is required.",
  }),
  window_id: Type.Optional(Type.Number()),
  scope: Type.Optional(ApprovalBatchScope),
  run_ids: Type.Optional(
    Type.Array(Type.Integer({ minimum: 1 }), {
      minItems: 1,
      maxItems: 5000,
      uniqueItems: true,
      description:
        "Exact proposal run IDs shown to the reviewer. The batch fails closed if the pending set changed.",
    })
  ),
  reason: Type.Optional(Type.String()),
});

/**
 * Result of `manage_operations` — discriminated union (on `action`/`status`,
 * plus an error variant). TypeBox-first: `Static<>` derives the TS type from
 * the same schema exposed as the tool's `outputSchema`. Operation/run rows are
 * wide snapshots, so they're honestly `Record<string, unknown>`.
 */
export const ManageOperationsResultSchema = Type.Union([
  Type.Object({ error: Type.String() }),
  Type.Object({
    action: Type.Literal("list_available"),
    // AvailableOperation is a typed descriptor; modeled as unknown so the
    // handler's typed array satisfies the schema without forcing an index
    // signature onto the interface.
    operations: Type.Array(Type.Unknown()),
    total: Type.Integer(),
    limit: Type.Integer(),
    offset: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal("execute"),
    run_id: Type.Integer(),
    event_id: Type.Optional(Type.Integer()),
    approval_url: Type.Optional(Type.String()),
    status: Type.Literal("pending_approval"),
    message: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("execute"),
    run_id: Type.Integer(),
    status: Type.Literal("completed"),
    // A connector/device operation's `action_output` is arbitrary JSON — it can
    // be an array or a scalar, not just an object. Declaring `output` as an
    // object-only Record made a non-object body fail structuredContent
    // validation (no variant matched), turning a SUCCESSFUL run into a client
    // error. `Type.Unknown()` accepts any JSON shape the run actually produced.
    output: Type.Unknown(),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
  Type.Object({
    action: Type.Literal("execute"),
    run_id: Type.Integer(),
    status: Type.Literal("failed"),
    error_message: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("execute"),
    run_id: Type.Integer(),
    status: Type.Literal("timeout"),
    error_message: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("list_runs"),
    runs: Type.Array(Type.Record(Type.String(), Type.Unknown())),
    total: Type.Integer(),
    limit: Type.Integer(),
    offset: Type.Integer(),
    has_more: Type.Boolean(),
  }),
  Type.Object({
    action: Type.Literal("get_run"),
    run: Type.Record(Type.String(), Type.Unknown()),
  }),
  Type.Object({
    action: Type.Literal("list_activity"),
    items: Type.Array(
      Type.Object({
        id: Type.String(),
        kind: Type.String(),
        title: Type.String(),
        body: Type.Union([Type.String(), Type.Null()]),
        at: Type.String(),
        status: Type.Union([Type.String(), Type.Null()]),
        count: Type.Integer(),
        href: Type.Union([Type.String(), Type.Null()]),
        unread: Type.Optional(Type.Boolean()),
        notification_id: Type.Optional(Type.Integer()),
        run_id: Type.Optional(Type.Integer()),
        /**
         * Live approval state of the run behind an approval notification,
         * passed through verbatim from the run's approval_status (e.g.
         * 'pending', 'approved', 'rejected', 'expired', 'auto'). Not a fixed
         * enum — treat any value not explicitly handled as non-actionable.
         */
        approval_status: Type.Optional(Type.String()),
        /** This approval supports one-click inline approve/reject. */
        approval_inline: Type.Optional(Type.Boolean()),
        member_run_ids: Type.Optional(Type.Array(Type.Integer())),
        connection_id: Type.Optional(Type.Integer()),
        behavior_id: Type.Optional(Type.Integer()),
      })
    ),
    total: Type.Integer(),
    limit: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal("approve"),
    approved: Type.Literal(true),
    run_id: Type.Integer(),
    event_id: Type.Optional(Type.Integer()),
    message: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("reject"),
    rejected: Type.Literal(true),
    run_id: Type.Integer(),
    event_id: Type.Optional(Type.Integer()),
  }),
  Type.Object({
    action: Type.Literal("approve_batch"),
    /** Present when the batch was scoped by window (Behavior proposals). */
    window_id: Type.Optional(Type.Integer()),
    approved_count: Type.Integer(),
    failed_count: Type.Integer(),
    run_ids: Type.Array(Type.Integer()),
    message: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("reject_batch"),
    /** Present when the batch was scoped by window (Behavior proposals). */
    window_id: Type.Optional(Type.Integer()),
    rejected_count: Type.Integer(),
    run_ids: Type.Array(Type.Integer()),
    message: Type.String(),
  }),
]);
export type ManageOperationsResult = Static<
  typeof ManageOperationsResultSchema
>;

export const ManageOperationsSchema = Type.Union([
  ListAvailableAction,
  ExecuteAction,
  ListRunsAction,
  GetRunAction,
  ListActivityAction,
  ApproveAction,
  RejectAction,
  ApproveBatchAction,
  RejectBatchAction,
]);

export type ManageOperationsArgs = Static<typeof ManageOperationsSchema>;
