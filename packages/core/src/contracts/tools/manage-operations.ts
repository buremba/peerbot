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
    description: "List connector/MCP/HTTP operations available for execution.",
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
  watcher_source: Type.Optional(
    Type.Object({
      watcher_id: Type.Number(),
      window_id: Type.Number(),
    })
  ),
});

export const ListRunsAction = Type.Object({
  action: Type.Literal("list_runs", {
    description: "Paginated run list with keyset cursor support.",
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
  operation_key: Type.Optional(
    Type.String({ description: "Filter by operation key" })
  ),
  status: Type.Optional(Type.String({ description: "Filter by run status" })),
  approval_status: Type.Optional(
    Type.String({ description: "Filter by approval status" })
  ),
  /** Filter by run_type. Omit to list every run type (sync, action, auth, …). */
  run_types: Type.Optional(
    Type.Array(Type.String({ description: "Filter by run types" }))
  ),
  /** Filter watcher runs by watcher id(s). */
  watcher_ids: Type.Optional(
    Type.Array(Type.Number({ description: "Filter by watcher IDs" }))
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
    description: "Fetch one action run.",
  }),
  run_id: Type.Number(),
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

export const ApproveBatchAction = Type.Object({
  action: Type.Literal("approve_batch", {
    description:
      "Approve every pending proposal a watcher run produced, in one go. Groups by the run's window.",
  }),
  window_id: Type.Number(),
});

export const RejectBatchAction = Type.Object({
  action: Type.Literal("reject_batch", {
    description:
      "Reject every pending proposal a watcher run produced. The reason is fed back to the agent so it can revise its proposals (the conversational revision loop).",
  }),
  window_id: Type.Number(),
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
    window_id: Type.Integer(),
    approved_count: Type.Integer(),
    failed_count: Type.Integer(),
    run_ids: Type.Array(Type.Integer()),
    message: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("reject_batch"),
    window_id: Type.Integer(),
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
  ApproveAction,
  RejectAction,
  ApproveBatchAction,
  RejectBatchAction,
]);

export type ManageOperationsArgs = Static<typeof ManageOperationsSchema>;
