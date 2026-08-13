/**
 * Worker ⇄ gateway HTTP protocol contract (TypeBox).
 *
 * Single source of truth for the device/connector-worker job protocol:
 * `POST /api/workers/poll`, `/api/workers/complete`, `/complete-action`,
 * `/complete-embeddings`, `/complete-behavior`, `/emit-auth-artifact`,
 * `/poll-auth-signal`, `/stream`, and the chrome-action dispatch.
 *
 * Before this module the wire shapes were typed twice with no compiler link:
 *   - the SERVER, inline as `c.req.json<{…}>()` in `worker-api/*` handlers, and
 *   - the WORKER, as hand-written interfaces in
 *     `connector-worker/src/daemon/client.ts`.
 * A field added on one side and missed on the other was a silent protocol
 * mismatch. Both sides now derive their COMPILE-TIME types from the schemas here
 * (the worker re-exports the `Static<>` types; the server annotates its
 * `c.req.json<T>()` bodies with them), so the type checker enforces agreement.
 * These are TypeBox schemas, so a future pass can also validate request bodies
 * against them at runtime — this change only wires the shared types, not
 * runtime validation.
 *
 * INVARIANT — Workers never receive real credentials (see AGENTS.md). The
 * `credentials` / `connection_credentials` on `PollResponse` carry only
 * placeholders / proxied grants the gateway chose to expose; this contract does
 * not change that boundary, it only types what already crosses it.
 */

import { type Static, Type } from "@sinclair/typebox";

// Wire mirror of connector-sdk's ConnectorBehaviorSignalDraftSchema. Core is
// deliberately dependency-free from connector-sdk; both the worker and gateway
// compile against this schema at the HTTP boundary.
const ConnectorBehaviorSignalDraftSchema = Type.Object(
  {
    event_type: Type.String({ minLength: 1, maxLength: 100 }),
    updated_event_type: Type.Optional(
      Type.String({ minLength: 1, maxLength: 100 })
    ),
    resource_type: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    resource_ref: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    label: Type.String({ minLength: 1, maxLength: 300 }),
    input_text: Type.String({ maxLength: 32_000 }),
    url: Type.Optional(Type.String({ maxLength: 2_000 })),
    occurred_at: Type.Optional(Type.String({ maxLength: 64 })),
    attributes: Type.Optional(
      Type.Record(
        Type.String({ maxLength: 100 }),
        Type.Union([
          Type.String({ maxLength: 1_000 }),
          Type.Number(),
          Type.Boolean(),
          Type.Null(),
        ])
      )
    ),
  },
  { additionalProperties: false }
);

/** Run kinds the poller can hand back. */
export const RunTypeSchema = Type.Union([
  Type.Literal("sync"),
  Type.Literal("action"),
  Type.Literal("behavior"),
  Type.Literal("embed_backfill"),
  Type.Literal("auth"),
]);

/** Categorized subprocess exit reason on the failed-run path. */
export const WorkerExitReasonSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("error_message"),
  Type.Literal("timeout"),
  Type.Literal("oom"),
  Type.Literal("crash"),
]);

/**
 * Diagnostic fields the subprocess executor attaches on the failed-run path.
 * The worker redacts `output_tail` before sending; the backend stores it as-is.
 * Shared by `/complete` and `/complete-auth`.
 */
export const WorkerExitDiagnosticsSchema = Type.Object({
  output_tail: Type.Optional(Type.String()),
  exit_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  exit_signal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  exit_reason: Type.Optional(WorkerExitReasonSchema),
});

/** OAuth grant the gateway hands a worker for a run (placeholder/proxied). */
export const OAuthCredentialsSchema = Type.Object({
  accessToken: Type.String(),
  provider: Type.String(),
  refreshToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  expiresAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  scope: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

// ── poll ────────────────────────────────────────────────────────────────────

/** `POST /api/workers/poll` request body. */
export const PollRequestSchema = Type.Object({
  worker_id: Type.String(),
  capabilities: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
  platform: Type.Optional(Type.String()),
  app_version: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  connector_manifests: Type.Optional(Type.Unknown()),
});

/** `POST /api/workers/poll` response body (a claimed run, or a poll-again). */
export const PollResponseSchema = Type.Object({
  next_poll_seconds: Type.Optional(Type.Number()),
  page_activations: Type.Optional(
    Type.Array(
      Type.Object({
        run_id: Type.Integer(),
        urls: Type.Array(Type.String()),
      })
    )
  ),
  run_id: Type.Optional(Type.Integer()),
  run_type: Type.Optional(RunTypeSchema),
  auth_profile_id: Type.Optional(Type.Integer()),
  previous_credentials: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  connector_key: Type.Optional(Type.String()),
  feed_key: Type.Optional(Type.String()),
  config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  db_egress_policy: Type.Optional(
    Type.Union([Type.Literal("block-private"), Type.Literal("allow-private")])
  ),
  /**
   * Operator-configured exact hosts (comma-separated) exempt from the private-IP
   * range check under `block-private` — e.g. a Tailscale/CGNAT DB. Travels the
   * same gateway-authoritative channel as `db_egress_policy` and REPLACES any
   * worker-local list. Never exempts metadata/link-local/multicast.
   */
  db_egress_allow_hosts: Type.Optional(Type.String()),
  checkpoint: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  entity_ids: Type.Optional(Type.Array(Type.Integer())),
  credentials: Type.Optional(Type.Union([OAuthCredentialsSchema, Type.Null()])),
  connection_credentials: Type.Optional(
    Type.Record(Type.String(), Type.Unknown())
  ),
  connection_id: Type.Optional(Type.Integer()),
  feed_id: Type.Optional(Type.Integer()),
  compiled_code: Type.Optional(Type.String()),
  nix_packages: Type.Optional(Type.Array(Type.String())),
  session_state: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  connector_version: Type.Optional(Type.String()),
  action_key: Type.Optional(Type.String()),
  action_input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  entity: Type.Optional(
    Type.Object({
      id: Type.Integer(),
      name: Type.String(),
      entity_type: Type.String(),
      metadata: Type.Record(Type.String(), Type.Unknown()),
    })
  ),
});

export const ActivatePageRequestSchema = Type.Object({
  worker_id: Type.String({ minLength: 1 }),
  run_id: Type.Integer({ minimum: 1 }),
  tab_id: Type.Integer({ minimum: 0 }),
  url: Type.String({ format: "uri" }),
});

export const ActivatePageResponseSchema = Type.Object({
  status: Type.Union([Type.Literal("activated"), Type.Literal("unavailable")]),
});

// ── stream ──────────────────────────────────────────────────────────────────

/**
 * One collected item in a `/stream` batch. This is the SERVER-accepted superset:
 * the connector-worker's `ContentItem` sends the plain-content subset (id,
 * payload_text, author/source/score/embedding…), while richer producers (the
 * chrome extension, json_template feeds) also send `payload_type` + the
 * `payload_data`/`payload_template`/`attachments` it selects. All are optional
 * so a bare content item still validates.
 */
export const ContentItemSchema = Type.Object({
  id: Type.String(),
  title: Type.Optional(Type.String()),
  payload_type: Type.Optional(
    Type.Union([
      Type.Literal("text"),
      Type.Literal("markdown"),
      Type.Literal("json_template"),
      Type.Literal("media"),
      Type.Literal("empty"),
    ])
  ),
  payload_text: Type.String(),
  payload_data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  payload_template: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  attachments: Type.Optional(Type.Array(Type.Unknown())),
  author_name: Type.Optional(Type.String()),
  occurred_at: Type.String(),
  source_url: Type.Optional(Type.String()),
  score: Type.Optional(Type.Number()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  origin_parent_id: Type.Optional(Type.String()),
  embedding: Type.Optional(Type.Array(Type.Number())),
  embedding_model: Type.Optional(Type.String()),
  origin_type: Type.Optional(Type.String()),
  semantic_type: Type.Optional(Type.String()),
  behavior_signals: Type.Optional(
    Type.Array(ConnectorBehaviorSignalDraftSchema, { maxItems: 16 })
  ),
});

/**
 * `POST /api/workers/stream` batch body. `worker_id` is optional here (unlike
 * the /complete family): a legacy streamer may omit it, and the run-ownership
 * gate on /stream keys off the run's claimed_by, not this field.
 */
export const StreamBatchSchema = Type.Object({
  type: Type.Literal("batch"),
  run_id: Type.Integer(),
  worker_id: Type.Optional(Type.String()),
  items: Type.Array(ContentItemSchema),
  checkpoint: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

// ── complete family ─────────────────────────────────────────────────────────

/** `POST /api/workers/complete` (sync/watcher run terminal report). */
export const CompleteRequestSchema = Type.Composite([
  Type.Object({
    run_id: Type.Integer(),
    worker_id: Type.String(),
    status: Type.Union([Type.Literal("success"), Type.Literal("failed")]),
    items_collected: Type.Optional(Type.Integer()),
    error_message: Type.Optional(Type.String()),
    checkpoint: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    auth_update: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
  WorkerExitDiagnosticsSchema,
]);

/** `POST /api/workers/complete-action`. */
export const CompleteActionRequestSchema = Type.Object({
  run_id: Type.Integer(),
  worker_id: Type.String(),
  status: Type.Union([Type.Literal("success"), Type.Literal("failed")]),
  action_output: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  error_message: Type.Optional(Type.String()),
});

/** One event returned by `/fetch-events-for-embedding` for the worker to embed. */
export const EmbedEventSchema = Type.Object({
  id: Type.Integer(),
  content: Type.String(),
  title: Type.Union([Type.String(), Type.Null()]),
});

/** One (event, chunk) embedding in a `/complete-embeddings` batch. */
export const EmbeddingEntrySchema = Type.Object({
  event_id: Type.Integer(),
  chunk_index: Type.Integer(),
  embedding: Type.Array(Type.Number()),
  embedding_model: Type.Optional(Type.String()),
});

/** `POST /api/workers/complete-embeddings`. */
export const CompleteEmbeddingsRequestSchema = Type.Object({
  run_id: Type.Integer(),
  worker_id: Type.String(),
  embeddings: Type.Array(EmbeddingEntrySchema),
  error_message: Type.Optional(Type.String()),
});

/**
 * `POST /api/workers/complete-auth` (auth run terminal report). Carries the
 * same exit diagnostics as `/complete`.
 */
export const CompleteAuthRequestSchema = Type.Composite([
  Type.Object({
    run_id: Type.Integer(),
    worker_id: Type.String(),
    status: Type.Union([Type.Literal("success"), Type.Literal("failed")]),
    credentials: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    error_message: Type.Optional(Type.String()),
  }),
  WorkerExitDiagnosticsSchema,
]);

// ── auth signalling ─────────────────────────────────────────────────────────

/** `POST /api/workers/emit-auth-artifact`. */
export const EmitAuthArtifactRequestSchema = Type.Object({
  run_id: Type.Integer(),
  worker_id: Type.String(),
  artifact: Type.Record(Type.String(), Type.Unknown()),
});

/** `POST /api/workers/poll-auth-signal` request. */
export const PollAuthSignalRequestSchema = Type.Object({
  run_id: Type.Integer(),
  worker_id: Type.String(),
  signal_name: Type.String(),
});

/** `POST /api/workers/poll-auth-signal` response. */
export const PollAuthSignalResponseSchema = Type.Object({
  signal: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

/**
 * `POST /api/workers/heartbeat`. `progress` is a coarse liveness counter, not an
 * authoritative item count (that arrives on `/stream` + `/complete`).
 */
export const HeartbeatRequestSchema = Type.Object({
  run_id: Type.Integer(),
  worker_id: Type.String(),
  progress: Type.Optional(
    Type.Object({
      items_collected_so_far: Type.Optional(Type.Integer()),
    })
  ),
});

/**
 * Request the gateway dispatch a chrome connector action on behalf of a
 * running sync. Scoped to the parent run's org.
 */
export const DispatchChromeActionRequestSchema = Type.Object({
  parent_run_id: Type.Integer(),
  worker_id: Type.String(),
  action_key: Type.String(),
  action_input: Type.Record(Type.String(), Type.Unknown()),
});

/** Gateway → worker result of a dispatched chrome action. */
export const DispatchChromeActionResponseSchema = Type.Object({
  status: Type.Union([
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("timeout"),
  ]),
  output: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  error_message: Type.Optional(Type.String()),
});

export type RunType = Static<typeof RunTypeSchema>;
export type WorkerExitReason = Static<typeof WorkerExitReasonSchema>;
export type WorkerExitDiagnostics = Static<typeof WorkerExitDiagnosticsSchema>;
export type OAuthCredentials = Static<typeof OAuthCredentialsSchema>;
export type PollRequest = Static<typeof PollRequestSchema>;
export type PollResponse = Static<typeof PollResponseSchema>;
export type ActivatePageRequest = Static<typeof ActivatePageRequestSchema>;
export type ActivatePageResponse = Static<typeof ActivatePageResponseSchema>;
export type ContentItem = Static<typeof ContentItemSchema>;
export type StreamBatch = Static<typeof StreamBatchSchema>;
export type CompleteRequest = Static<typeof CompleteRequestSchema>;
export type CompleteActionRequest = Static<typeof CompleteActionRequestSchema>;
export type EmbedEvent = Static<typeof EmbedEventSchema>;
export type EmbeddingEntry = Static<typeof EmbeddingEntrySchema>;
export type CompleteEmbeddingsRequest = Static<
  typeof CompleteEmbeddingsRequestSchema
>;
export type CompleteAuthRequest = Static<typeof CompleteAuthRequestSchema>;
export type EmitAuthArtifactRequest = Static<
  typeof EmitAuthArtifactRequestSchema
>;
export type PollAuthSignalRequest = Static<typeof PollAuthSignalRequestSchema>;
export type PollAuthSignalResponse = Static<
  typeof PollAuthSignalResponseSchema
>;
export type HeartbeatRequest = Static<typeof HeartbeatRequestSchema>;
export type DispatchChromeActionRequest = Static<
  typeof DispatchChromeActionRequestSchema
>;
export type DispatchChromeActionResponse = Static<
  typeof DispatchChromeActionResponseSchema
>;
