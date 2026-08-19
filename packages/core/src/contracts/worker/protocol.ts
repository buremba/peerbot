/**
 * Worker ⇄ gateway HTTP protocol contract (TypeBox).
 *
 * Single source of truth for the device/connector-worker job protocol:
 * `POST /api/workers/poll`, `/api/workers/complete`, `/complete-action`,
 * `/complete-embeddings`, `/complete-automation`, `/emit-auth-artifact`,
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

// Wire mirror of connector-sdk's ConnectorAutomationSignalDraftSchema. Core is
// deliberately dependency-free from connector-sdk; both the worker and gateway
// compile against this schema at the HTTP boundary.
const ConnectorAutomationSignalDraftSchema = Type.Object(
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
  Type.Literal("automation"),
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
  /**
   * Agent kinds this device can run for Automations (e.g. `["claude-code"]`).
   * Advertised by the connector-worker daemon, derived from the binaries
   * actually resolvable on that machine — not the build's static kind table,
   * which would make the gate below inert. The gateway
   * persists it on `device_workers.agent_kinds` and withholds device-pinned
   * runs whose `agent_kind` the device did not advertise. Omit the field
   * entirely when the client runs no CLIs and should stay unrestricted; send
   * `[]` to claim no Automation runs at all — including runs that name no
   * `agent_kind`, since a device that runs nothing has no default either.
   */
  agent_kinds: Type.Optional(Type.Array(Type.String())),
});

/**
 * Per-automation device-worker CLI execution settings. Mirrors the server's
 * `automations.execution_config` jsonb column; a missing key means "use the
 * dispatcher/CLI default". Field names are snake_case to match the wire payload.
 */
export const AutomationExecutionConfigSchema = Type.Object({
  /** Wall-clock cap in seconds; the dispatcher enforces it by SIGTERM. */
  timeout_seconds: Type.Optional(Type.Integer()),
  /** Per-run dollar ceiling (claude-only today). */
  max_budget_usd: Type.Optional(Type.Number()),
  /** Model alias/id (`--model` / `-m`). */
  model: Type.Optional(Type.String()),
  /** Tool permission mode (`--permission-mode`). */
  permission_mode: Type.Optional(Type.String()),
  /** Reasoning effort: low|medium|high (`--effort` / `--variant` / `--thinking`). */
  effort: Type.Optional(Type.String()),
});

/**
 * Automation metadata in the poll envelope. `prompt` is the version-pinned
 * instructions (author prompt + frozen skill snapshots, composed server-side by
 * `formatDeviceAutomationInstructions`); `extraction_schema` is the derived
 * output contract the CLI must satisfy (null for untyped Automations).
 */
export const AutomationPollMetaSchema = Type.Object({
  id: Type.String(),
  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  slug: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  agent_kind: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  notification_channel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  notification_priority: Type.Optional(
    Type.Union([Type.String(), Type.Null()])
  ),
  execution_config: Type.Optional(AutomationExecutionConfigSchema),
  prompt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  extraction_schema: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
});

/** Trigger event in the automation poll envelope (`approved_input` verbatim). */
export const AutomationPollEventSchema = Type.Object({
  trigger_event_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  fired_at: Type.String(),
  payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

/** Identity context for a device automation run. */
export const AutomationPollContextSchema = Type.Object({
  device: Type.Object({ worker_id: Type.Optional(Type.String()) }),
  user: Type.Object({
    user_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  }),
});

/**
 * `payload` of an automation poll response — the envelope a device-local CLI
 * executor passes to the spawned agent. Built ad hoc by `poll.ts` and
 * hand-decoded by the Mac app's `AutomationDispatcher`; typed here so the TS
 * daemon can express the same job.
 */
export const AutomationPollPayloadSchema = Type.Object({
  automation: AutomationPollMetaSchema,
  event: AutomationPollEventSchema,
  context: AutomationPollContextSchema,
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
  /** Owning org of a claimed automation run; sent on the automation lane only. */
  organization_id: Type.Optional(Type.String()),
  /**
   * Automation-run envelope. Present only when `run_type === 'automation'`: the
   * gateway composes the payload a device-local CLI executor needs to build a
   * prompt, and the device returns its process exit via `/complete-automation`.
   * No connector code, credentials, or compiled_code are shipped on this lane.
   */
  payload: Type.Optional(AutomationPollPayloadSchema),
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
  automation_signals: Type.Optional(
    Type.Array(ConnectorAutomationSignalDraftSchema, { maxItems: 16 })
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

/** `POST /api/workers/complete` (sync/automation run terminal report). */
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

/**
 * `POST /api/workers/me/runs/:runId/complete-automation` (device-side EXIT
 * REPORT). The run id travels in the URL, not the body. Reports process exit
 * metadata for an automation run executed by a local CLI agent; `finalize_attempt`
 * is the finalize round the reporting spawn ran under (0 for the first), which
 * makes the report replayable across a lost response.
 */
export const CompleteAutomationRequestSchema = Type.Object({
  worker_id: Type.String(),
  output: Type.Optional(Type.String()),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  duration_ms: Type.Optional(Type.Integer()),
  exit_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  exit_signal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  exit_reason: Type.Optional(WorkerExitReasonSchema),
  finalize_attempt: Type.Optional(Type.Integer()),
});

/**
 * Response from `complete-automation`. `status: "resume"` means the run is
 * still claimed and the device should re-spawn its CLI with `nudge` appended
 * (bounded by `max_attempts`). Other statuses are terminal.
 */
export const CompleteAutomationResponseSchema = Type.Object({
  ok: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  status: Type.String(),
  reason_code: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  attempt: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  max_attempts: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  nudge: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  window_id: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  idempotent: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
});

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
export type AutomationExecutionConfig = Static<
  typeof AutomationExecutionConfigSchema
>;
export type AutomationPollMeta = Static<typeof AutomationPollMetaSchema>;
export type AutomationPollEvent = Static<typeof AutomationPollEventSchema>;
export type AutomationPollContext = Static<typeof AutomationPollContextSchema>;
export type AutomationPollPayload = Static<typeof AutomationPollPayloadSchema>;
export type CompleteAutomationRequest = Static<
  typeof CompleteAutomationRequestSchema
>;
export type CompleteAutomationResponse = Static<
  typeof CompleteAutomationResponseSchema
>;
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
