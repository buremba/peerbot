import { type Static, Type } from "@sinclair/typebox";

const BehaviorTriggerMatchValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

/**
 * Connector event activation for a Behavior. Triggers and context sources are
 * deliberately separate: a trigger decides when to run, while a source only
 * decides which durable data is available to that run.
 */
export const BehaviorEventTriggerSchema = Type.Object(
  {
    kind: Type.Literal("event"),
    connector_key: Type.String({ minLength: 1, maxLength: 100 }),
    connection_id: Type.Optional(Type.Integer({ minimum: 1 })),
    event_types: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
    match: Type.Optional(
      Type.Record(Type.String(), BehaviorTriggerMatchValueSchema, {
        description:
          "Connector-normalized exact-match fields such as resource_ref or channel_id.",
      })
    ),
    execution: Type.Optional(
      Type.Union([Type.Literal("turn"), Type.Literal("window")], {
        description:
          '"turn" renders the incoming event as the agent input (chat/listen); "window" runs the Behavior analysis flow.',
        default: "turn",
      })
    ),
    active_run: Type.Optional(
      Type.Union(
        [
          Type.Literal("queue"),
          Type.Literal("coalesce"),
          Type.Literal("steer"),
        ],
        {
          description:
            "What to do when this Behavior is busy: queue every event, combine waiting events, or steer the current trusted chat turn.",
          default: "queue",
        }
      )
    ),
    output: Type.Optional(
      Type.Union([Type.Literal("silent"), Type.Literal("reply_to_source")], {
        description:
          "Keep the result in Lobu or send it back through the source connector when supported.",
        default: "silent",
      })
    ),
    skip_if_unchanged: Type.Optional(
      Type.Boolean({
        description:
          "For window execution, do not enqueue an agent run when connector polling produced no durable source change.",
        default: true,
      })
    ),
  },
  { additionalProperties: false }
);
export type BehaviorEventTrigger = Static<typeof BehaviorEventTriggerSchema>;

export const BehaviorScheduleTriggerSchema = Type.Object(
  {
    kind: Type.Literal("schedule"),
    cron: Type.String({ minLength: 1, maxLength: 120 }),
    timezone: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])
    ),
    execution: Type.Optional(Type.Literal("window", { default: "window" })),
    active_run: Type.Optional(
      Type.Literal("coalesce", {
        default: "coalesce",
      })
    ),
    skip_if_unchanged: Type.Optional(Type.Boolean({ default: true })),
  },
  { additionalProperties: false }
);
export type BehaviorScheduleTrigger = Static<
  typeof BehaviorScheduleTriggerSchema
>;

export const BehaviorTriggerSchema = Type.Union([
  BehaviorEventTriggerSchema,
  BehaviorScheduleTriggerSchema,
]);
export type BehaviorTrigger = Static<typeof BehaviorTriggerSchema>;

export const BehaviorSourceSchema = Type.Object({
  name: Type.String(),
  query: Type.String(),
  // When true, this SQL source is CONTEXT (like an @entity ref), not event
  // content: its rows are handed to the agent for reasoning but are NOT linked
  // into the window's event set. Use it to feed a filtered set of entities the
  // agent should look at (e.g. duplicate-merge candidates) — the raw `id` it
  // projects is an entity id, not an `events.id`, so it must NOT go through the
  // watcher_window_events FK. A plain (non-context) SQL source stays event
  // content and its `id` must be an `events.id`.
  context: Type.Optional(Type.Boolean()),
});
export type BehaviorSource = Static<typeof BehaviorSourceSchema>;

export const BehaviorExecutionConfigSchema = Type.Object(
  {
    timeout_seconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 86_400,
        description:
          "Wall-clock cap in seconds for the device-worker CLI run (default 600).",
      })
    ),
    max_budget_usd: Type.Optional(
      Type.Number({
        minimum: 0,
        description:
          "Per-run dollar ceiling (claude only: --max-budget-usd). No-op on other CLIs.",
      })
    ),
    model: Type.Optional(
      Type.String({
        description: "Model alias/id passed to the CLI (--model).",
      })
    ),
    permission_mode: Type.Optional(
      Type.Union(
        [
          Type.Literal("acceptEdits"),
          Type.Literal("auto"),
          Type.Literal("bypassPermissions"),
          Type.Literal("default"),
          Type.Literal("dontAsk"),
          Type.Literal("plan"),
        ],
        {
          description: "Tool permission mode (claude only: --permission-mode).",
        }
      )
    ),
    effort: Type.Optional(
      Type.Union(
        [Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
        {
          description: "Reasoning effort (claude only: --effort).",
        }
      )
    ),
    finalize_nudges: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 5,
        description:
          "How many extra times to re-dispatch a server-side Behavior run that finished WITHOUT calling complete_window before failing it. 0 disables; omitted = global default.",
      })
    ),
  },
  {
    additionalProperties: false,
    description:
      "[create/update] Per-Behavior execution settings: device-worker CLI flags plus the server-side finalize-nudge budget. Omitted fields fall back to dispatcher/CLI/global defaults; pass null to clear.",
  }
);
export type BehaviorExecutionConfig = Static<
  typeof BehaviorExecutionConfigSchema
>;

// ============================================
// Typebox Schema (Flattened for MCP)
// ============================================

// Source definition — named SQL query
export const SourceSchema = Type.Object({
  name: Type.String({ description: 'Source name (e.g., "content", "volume")' }),
  query: Type.String({
    description:
      "SQL SELECT query. If it references the events table, time window bounds are auto-applied.",
  }),
  context: Type.Optional(
    Type.Boolean({
      description:
        "When true, the source is CONTEXT (like an @entity ref), not event content: its rows reach the agent but are NOT linked into the window's event set, so the `id` it projects may be an entity id rather than an events.id. Use for feeding a filtered entity set (e.g. duplicate-merge candidates) the agent should reason over.",
    })
  ),
});

// Flattened schema for MCP compatibility (MCP doesn't support top-level unions)
export const ManageBehaviorsSchema = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal("create", {
          description: "Create a Behavior with prompt + sources.",
        }),
        Type.Literal("list", { description: "List Behaviors." }),
        Type.Literal("update", { description: "Patch Behavior config." }),
        Type.Literal("create_version", {
          description: "Create a new versioned Behavior config.",
        }),
        Type.Literal("complete_window", {
          description: "Submit a Behavior window result.",
        }),
        Type.Literal("trigger", {
          description: "Manually fire a Behavior run.",
        }),
        Type.Literal("delete", { description: "Bulk-delete Behaviors." }),
        Type.Literal("set_reaction_script", {
          description: "Attach/remove a TypeScript reaction script.",
        }),
        Type.Literal("get_versions", {
          description: "List a Behavior\u2019s version history.",
        }),
        Type.Literal("get_version_details", {
          description: "Fetch full version config.",
        }),
        Type.Literal("get_component_reference", {
          description: "Static component/data-type documentation.",
        }),
        Type.Literal("submit_feedback", {
          description: "Submit per-field corrections on a window.",
        }),
        Type.Literal("get_feedback", {
          description: "Retrieve feedback for a Behavior.",
        }),
        Type.Literal("list_promoted", {
          description: "List entities promoted by a Behavior.",
        }),
        Type.Literal("create_from_version", {
          description: "Create Behaviors per entity from a template version.",
        }),
      ],
      { description: "Action to perform" }
    ),

    // Behavior identity (the persisted DB column is watcher_id)
    behavior_id: Type.Optional(
      Type.String({
        description:
          "[list/update/upgrade/get_versions/get_version_details/set_reaction_script/trigger] Behavior ID (numeric string)",
      })
    ),
    behavior_ids: Type.Optional(
      Type.Array(Type.String(), {
        description: "[delete] Array of Behavior IDs (numeric strings)",
      })
    ),

    // Fields for action="create"
    slug: Type.Optional(
      Type.String({ description: "[create] Unique Behavior identifier" })
    ),
    name: Type.Optional(
      Type.String({ description: "[create/create_version] Display name" })
    ),
    description: Type.Optional(
      Type.String({
        description: "[create/create_version] Behavior description",
      })
    ),
    entity_id: Type.Optional(
      Type.Number({
        description:
          "Entity ID. Optional for create — provide it to attach the Behavior to an entity; omit it for an org-scoped/global Behavior. Optional for list.",
      })
    ),
    entity_ids: Type.Optional(
      Type.Array(Type.Number(), {
        description:
          "[create_from_version] Array of entity IDs to create individual Behaviors for.",
      })
    ),
    version_id: Type.Optional(
      Type.Number({
        description:
          "[create_from_version] Source version ID to use as template for new Behaviors.",
      })
    ),
    name_pattern: Type.Optional(
      Type.String({
        description:
          '[create_from_version] Name pattern for created Behaviors. Use {{entity_name}} for substitution. Default: "{version_name}: {entity_name}".',
      })
    ),

    // Behavior config fields (create/create_version/update)
    prompt: Type.Optional(
      Type.String({
        description:
          "[create/create_version] LLM prompt template (Handlebars). Variables: {{entities}}, {{content}}, {{sources.name}}, {{data.name}}, {{#each entities}}{{name}}{{/each}}.",
      })
    ),
    sources: Type.Optional(
      Type.Array(SourceSchema, {
        description:
          "[create/create_version] Array of SQL data sources. Each source is { name, query }. Sources are version-owned — to change them on an existing Behavior, publish a new version with action: 'create_version'.",
      })
    ),
    keying_config: Type.Optional(
      Type.Any({
        description:
          "[create/create_version] Config for stable key generation across windows.",
      })
    ),
    classifiers: Type.Optional(
      Type.Any({
        description:
          "[create/create_version] Classifier definitions for extraction.",
      })
    ),
    triggers: Type.Optional(
      Type.Array(BehaviorTriggerSchema, {
        minItems: 0,
        maxItems: 16,
        description:
          "[create/update/create_version] Canonical Behavior activations. Use a schedule trigger for cadence and timezone.",
      })
    ),
    agent_id: Type.Optional(
      Type.String({
        description:
          "[create/update] Agent ID that owns/executes this Behavior. [list] Optional owner filter.",
      })
    ),
    status: Type.Optional(
      Type.Union([Type.Literal("active"), Type.Literal("archived")], {
        description:
          "[list] Optional status filter. Omit to include active Behaviors only.",
      })
    ),
    include_details: Type.Optional(
      Type.Boolean({
        description:
          "[list] Include prompt, schema, and sources in the response (default: false).",
      })
    ),
    order_by: Type.Optional(
      Type.Union([Type.Literal("last_fired_at"), Type.Literal("created_at")], {
        description: "[list] Sort field (default: created_at).",
      })
    ),
    order_dir: Type.Optional(
      Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
        description: "[list] Sort direction (default: desc).",
      })
    ),
    scheduler_client_id: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "[create/update/create_version] Optional MCP client ID that should auto-run this Behavior. Null clears it.",
      })
    ),
    device_worker_id: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "[create/update] Optional device worker UUID to pin this Behavior to (when its inputs live on that device). Null clears the pin.",
      })
    ),
    agent_kind: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          '[create/update] Optional agent kind override for this Behavior (e.g. "background", "notifier"). Null clears the override.',
      })
    ),
    notification_channel: Type.Optional(
      Type.Union(
        [
          Type.Literal("canvas"),
          Type.Literal("notification"),
          Type.Literal("both"),
        ],
        {
          description:
            '[create/update] Where firings surface: "canvas" (default), "notification" (OS notification), or "both".',
        }
      )
    ),
    notification_priority: Type.Optional(
      Type.Union(
        [Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")],
        {
          description:
            '[create/update] Priority class used by the dispatcher interrupt budget. Default "normal".',
        }
      )
    ),
    min_cooldown_seconds: Type.Optional(
      Type.Number({
        description:
          "[create/update] Minimum seconds between two firings of this Behavior (0 = no cooldown).",
        minimum: 0,
      })
    ),
    model_config: Type.Optional(
      Type.Any({ description: "[create/update] AI model configuration" })
    ),
    // Union with Null so `update` can clear a previously-saved config back to
    // NULL/defaults — omitted = unchanged, null = clear, object = replace. The
    // object shape lives in BehaviorExecutionConfigSchema; the role-policy gate
    // (assertValidExecutionConfig) stays in the CRUD handlers.
    execution_config: Type.Optional(
      Type.Union([Type.Null(), BehaviorExecutionConfigSchema])
    ),
    tags: Type.Optional(
      Type.Array(Type.String(), { description: "[create] Tags for filtering" })
    ),

    // Version management
    version: Type.Optional(
      Type.Number({
        description: "[upgrade/get_version_details] Version number",
      })
    ),
    target_version: Type.Optional(
      Type.Number({ description: "[upgrade] Version number to upgrade to" })
    ),
    change_notes: Type.Optional(
      Type.String({
        description: "[create_version] Change notes for the new version",
      })
    ),
    set_as_current: Type.Optional(
      Type.Boolean({
        description: "[create_version] Set as current version (default: true)",
      })
    ),
    reactions_guidance: Type.Optional(
      Type.String({
        description:
          "[create/create_version] Guidance text for LLM agents on what reactions to take.",
      })
    ),

    // Fields for action="complete_window"
    extracted_data: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          description:
            "[complete_window] Required. LLM analysis results. Must match the Behavior's extraction contract (derived from its entity type).",
        }
      )
    ),
    replace_existing: Type.Optional(
      Type.Boolean({
        description:
          "[complete_window] Replace existing window for same period (default: false).",
      })
    ),
    window_token: Type.Optional(
      Type.String({
        description:
          "[complete_window] JWT from read_knowledge(watcher_id, since, until). Pass this or window_tokens.",
      })
    ),
    window_tokens: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "[complete_window] Multiple page JWTs from read_knowledge for the same Behavior window. Content IDs are unioned and linked atomically.",
      })
    ),
    client_id: Type.Optional(
      Type.String({
        description:
          "[complete_window] Optional client identifier for execution provenance. Defaults to authenticated MCP client when available.",
      })
    ),
    model: Type.Optional(
      Type.String({
        description:
          "[complete_window] Optional model name used to produce the window result.",
      })
    ),
    run_metadata: Type.Optional(
      Type.Any({
        description:
          "[complete_window] Optional structured execution metadata for provenance (provider, session id, parameters, etc.).",
      })
    ),
    watcher_run_id: Type.Optional(
      Type.Number({
        description:
          "[complete_window] Optional Behavior run id for completion/provenance. Workers should pass the run ID from the dispatch prompt.",
      })
    ),
    template_version_id: Type.Optional(
      Type.Number({
        description:
          "[complete_window] Pin to a specific persisted Behavior version. Workers receive this from the run dispatch payload and pass it back so validation uses the same version that produced the extraction. Defaults to the run row's snapshot if available, else the Behavior's current version.",
      })
    ),

    // Fields for action="create" / "set_reaction_script"
    reaction_script: Type.Optional(
      Type.String({
        description:
          "[create/set_reaction_script] TypeScript source for an automated reaction. On create, it is compiled before the Behavior and its reaction fields are stored in one transaction. Pass an empty string to set_reaction_script to remove an existing script.",
      })
    ),

    // Fields for action="submit_feedback" / "get_feedback"
    window_id: Type.Optional(
      Type.Number({
        description:
          "[submit_feedback] Required. [get_feedback] Optional filter. Window ID to attach feedback to.",
      })
    ),
    corrections: Type.Optional(
      Type.Array(
        Type.Object({
          field_path: Type.String({
            description:
              'Dot/bracket path into extracted_data, e.g. "problems[1].severity" or "problems[2]" for an array item.',
          }),
          mutation: Type.Optional(
            Type.Union(
              [
                Type.Literal("set"),
                Type.Literal("remove"),
                Type.Literal("add"),
              ],
              {
                description:
                  'Default "set". Use "remove" to drop an array item; "add" to append one.',
              }
            )
          ),
          value: Type.Optional(
            Type.Any({
              description:
                "New value for set/add. Omitted for remove. Any JSON type (string/number/object/array).",
            })
          ),
          note: Type.Optional(
            Type.String({ description: "Optional per-field explanation." })
          ),
        }),
        {
          description:
            "[submit_feedback] One entry per corrected field. Each row is stored independently so future corrections can supersede earlier ones per field.",
        }
      )
    ),
    limit: Type.Optional(
      Type.Number({
        description:
          "[list/get_feedback] Maximum records to return. get_feedback defaults to 50; list defaults to all matching Behaviors.",
      })
    ),
  },
  { additionalProperties: false }
);

// ============================================
// Type Definitions
// ============================================

export type ManageBehaviorsArgs = Static<typeof ManageBehaviorsSchema>;

/**
 * The watcher columns a `manage_behaviors` UPDATE persists — a type-only `Pick`
 * of {@link ManageBehaviorsArgs} so the field TYPES are reused from the single
 * source (no re-typing); the STORED shape is these fields after the
 * write-normalization {@link normalizeBehaviorUpdatePatch} applies.
 *
 * EXCLUDES: name/description/prompt/sources (version-owned — an update can't
 * change them, changing them needs create_version) and routing keys
 * (action/behavior_id/entity_id/version_id). `next_run_at` is omitted too — a
 * DERIVED column, not a proposable field.
 */
export type BehaviorUpdatePatch = Pick<
  ManageBehaviorsArgs,
  | "model_config"
  | "execution_config"
  | "triggers"
  | "agent_id"
  | "scheduler_client_id"
  | "tags"
  | "device_worker_id"
  | "agent_kind"
  | "notification_channel"
  | "notification_priority"
  | "min_cooldown_seconds"
>;

/**
 * Canonical tag normalization for a watcher write — trim, drop empties, dedupe,
 * preserving first-seen order. The SINGLE source for how tags are STORED: the
 * server's `toTextArrayParam` (SQL array param) and `normalizeBehaviorUpdatePatch`
 * (review `proposedAfter`) both go through this, so the displayed tags equal the
 * stored tags exactly (e.g. `["  a  ", "a", ""]` → `["a"]`).
 */
export function normalizeBehaviorTags(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s.length === 0 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * The SINGLE SOURCE OF TRUTH for a `manage_behaviors` UPDATE's write-normalization
 * — the exact value each applied field STORES. Shared by the apply handler
 * (feeds the UPDATE SET clause) and the config-approval review's `proposedAfter`
 * (the pending-proposal endpoint), so "displayed == applied" can't drift: the
 * review shows precisely what this same function tells the handler to write.
 *
 * A `manage_behaviors` update is a PATCH — only keys PRESENT in `args` are
 * returned (absent keys keep their current values). Coercions mirror the stored
 * shape EXACTLY, incl. the ones that used to live only in the SQL params:
 *   - model_config ?? {}
 *   - tags → normalizeBehaviorTags (trim/drop-empty/dedupe)
 *   - notification_channel ?? 'canvas', notification_priority ?? 'normal',
 *     min_cooldown_seconds ?? 0
 *   - null-clearable scalars (agent_id/scheduler_client_id/
 *     device_worker_id/agent_kind) and execution_config keep null (a real clear
 *     the write applies) — NOT coerced to undefined, which would hide the clear.
 */
export function normalizeBehaviorUpdatePatch(
  args: ManageBehaviorsArgs
): BehaviorUpdatePatch {
  const patch: BehaviorUpdatePatch = {};
  if (args.model_config !== undefined)
    patch.model_config = args.model_config ?? {};
  // null is a REAL clear the write stores (toJsonParam(null) → SQL null); keep it
  // so the review shows the clear rather than hiding it (serializing away).
  if (args.execution_config !== undefined)
    patch.execution_config = args.execution_config ?? null;
  if (args.triggers !== undefined) patch.triggers = args.triggers;
  if (args.agent_id !== undefined) patch.agent_id = args.agent_id ?? null;
  if (args.scheduler_client_id !== undefined)
    patch.scheduler_client_id = args.scheduler_client_id ?? null;
  if (args.tags !== undefined) patch.tags = normalizeBehaviorTags(args.tags);
  if (args.device_worker_id !== undefined)
    patch.device_worker_id = args.device_worker_id ?? null;
  if (args.agent_kind !== undefined) patch.agent_kind = args.agent_kind ?? null;
  if (args.notification_channel !== undefined)
    patch.notification_channel = args.notification_channel ?? "canvas";
  if (args.notification_priority !== undefined)
    patch.notification_priority = args.notification_priority ?? "normal";
  if (args.min_cooldown_seconds !== undefined)
    patch.min_cooldown_seconds = args.min_cooldown_seconds ?? 0;
  return patch;
}

/**
 * Result of `manage_behaviors` — a discriminated union keyed on `action`.
 * TypeBox-first: the TS type is `Static<>`-derived, and the same schema is the
 * tool's `outputSchema`. Well-structured variants are precise; the genuinely
 * dynamic variants (`get_version_details` carries an open index signature,
 * `get_versions` returns arbitrary version rows, `get_component_reference`
 * embeds a large doc tree) use permissive object shapes so the schema is
 * honest rather than a brittle mirror of shapes that are intentionally open.
 */
export const ManageBehaviorsDeleteResultSchema = Type.Object({
  behavior_id: Type.String(),
  success: Type.Boolean(),
  message: Type.String(),
  version: Type.Optional(Type.Integer()),
});

export const ManageBehaviorsFeedbackItemSchema = Type.Object({
  id: Type.Integer(),
  window_id: Type.Integer(),
  field_path: Type.String(),
  mutation: Type.Union([
    Type.Literal("set"),
    Type.Literal("remove"),
    Type.Literal("add"),
  ]),
  corrected_value: Type.Unknown(),
  note: Type.Union([Type.String(), Type.Null()]),
  created_by: Type.String(),
  created_at: Type.String(),
  window_start: Type.Optional(Type.String()),
  window_end: Type.Optional(Type.String()),
});

export const ManageBehaviorsPromotedEntitySchema = Type.Object({
  id: Type.Integer(),
  name: Type.String(),
  entity_type: Type.String(),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  field_controls: Type.Record(Type.String(), Type.Unknown()),
  window_id: Type.Union([Type.Integer(), Type.Null()]),
  stable_key: Type.Union([Type.String(), Type.Null()]),
});

export const ManageBehaviorsResultSchema = Type.Union([
  Type.Object({
    action: Type.Literal("list"),
    behaviors: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  }),
  Type.Object({
    action: Type.Literal("create"),
    behavior_id: Type.String(),
    version: Type.Integer(),
    status: Type.String(),
    sources: Type.Optional(Type.Array(BehaviorSourceSchema)),
    view_url: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("update"),
    behavior_id: Type.String(),
    updated_fields: Type.Array(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("create_version"),
    behavior_id: Type.String(),
    version_id: Type.String(),
    version: Type.Integer(),
    previous_version: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal("complete_window"),
    behavior_id: Type.String(),
    window_id: Type.Integer(),
    window_start: Type.String(),
    window_end: Type.String(),
    content_linked: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal("trigger"),
    behavior_id: Type.String(),
    run_id: Type.Integer(),
    status: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("delete"),
    results: Type.Array(ManageBehaviorsDeleteResultSchema),
    summary: Type.Object({
      total: Type.Integer(),
      successful: Type.Integer(),
      failed: Type.Integer(),
    }),
  }),
  Type.Object({
    action: Type.Literal("set_reaction_script"),
    behavior_id: Type.String(),
    has_script: Type.Boolean(),
    message: Type.String(),
  }),
  // Intentionally permissive: version rows are arbitrary config snapshots.
  Type.Object({
    action: Type.Literal("get_versions"),
    behavior_id: Type.String(),
    versions: Type.Array(Type.Unknown()),
  }),
  // Intentionally permissive: carries an open `[key: string]: any` index sig
  // (the full version config snapshot). Intersecting a string→unknown record
  // gives the derived TS type an index signature AND emits
  // `additionalProperties: true` in the JSON Schema.
  Type.Intersect([
    Type.Object({
      action: Type.Literal("get_version_details"),
      behavior_id: Type.String(),
    }),
    Type.Record(Type.String(), Type.Unknown()),
  ]),
  // Intentionally permissive: embeds a large documentation tree
  // (ComponentReferenceDocumentation); the action literal + presence of
  // `documentation` is what clients key on.
  Type.Object({
    action: Type.Literal("get_component_reference"),
    documentation: Type.Unknown(),
  }),
  Type.Object({
    action: Type.Literal("submit_feedback"),
    behavior_id: Type.String(),
    window_id: Type.Integer(),
    feedback_ids: Type.Array(Type.Integer()),
  }),
  Type.Object({
    action: Type.Literal("get_feedback"),
    behavior_id: Type.String(),
    feedback: Type.Array(ManageBehaviorsFeedbackItemSchema),
  }),
  Type.Object({
    action: Type.Literal("list_promoted"),
    behavior_id: Type.String(),
    entities: Type.Array(ManageBehaviorsPromotedEntitySchema),
  }),
  Type.Object({
    action: Type.Literal("create_from_version"),
    created: Type.Array(
      Type.Object({
        behavior_id: Type.String(),
        entity_id: Type.Integer(),
        name: Type.String(),
      })
    ),
  }),
  // Builder-gate: non-human principal queued a Behavior definition write.
  // Mirrors manage_agents' pending_approval shape so the worker can forward a
  // chat approval card from the same result fields (run_id + proposal).
  Type.Object({
    action: Type.Union([
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("create_version"),
      Type.Literal("create_from_version"),
      Type.Literal("set_reaction_script"),
      Type.Literal("delete"),
    ]),
    run_id: Type.Integer(),
    event_id: Type.Optional(Type.Integer()),
    status: Type.Literal("pending_approval"),
    message: Type.String(),
    proposal: Type.Unknown(),
    current: Type.Union([
      Type.Record(Type.String(), Type.Unknown()),
      Type.Null(),
    ]),
  }),
]);

export type ManageBehaviorsResult = Static<typeof ManageBehaviorsResultSchema>;

/**
 * Proposed Behavior-definition mutation held in `runs.action_input` for a
 * builder-gate run. Captures the original manage_behaviors args so approve can
 * re-run the same write handler.
 *
 * Also persists the acting principal resolved at queue time so apply can
 * re-validate the foreign-owner guard against the ORIGINAL actor (not the
 * human approver). Without this, a group reassigned between queue and approve
 * would let A's pending mutation land on B-owned behavior.
 *
 * Behavior definition writes have no per-field pre-image (unlike manage_agents
 * update `base`); a straight re-run is the launch path — a stale approval may
 * clobber a newer edit (ownership re-check still rejects foreign owners).
 */
export interface ManageBehaviorsProposal {
  args: ManageBehaviorsArgs;
  /** Resolved `actor.ownerAgentId ?? actor.id` at queue time; null for humans. */
  actingAgentId: string | null;
  /** Session `actingWatcherId` at queue time, if any. */
  actingWatcherId: string | null;
}
// The REST/list helper is a projection of the canonical flattened tool schema,
// not a second hand-maintained contract that can drift from manage_behaviors.
export const ListBehaviorsSchema = Type.Pick(ManageBehaviorsSchema, [
  "behavior_id",
  "entity_id",
  "agent_id",
  "status",
  "include_details",
  "order_by",
  "order_dir",
  "limit",
]);

export type ListBehaviorsArgs = Static<typeof ListBehaviorsSchema>;

export const ListBehaviorsResultSchema = Type.Object({
  action: Type.Literal("list"),
  behaviors: Type.Array(Type.Record(Type.String(), Type.Unknown())),
});
export type ListBehaviorsResult = Static<typeof ListBehaviorsResultSchema>;
