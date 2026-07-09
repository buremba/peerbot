import { type Static, Type } from "@sinclair/typebox";

export const WatcherSourceSchema = Type.Object({
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
export type WatcherSource = Static<typeof WatcherSourceSchema>;

export const WatcherExecutionConfigSchema = Type.Object(
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
          "How many extra times to re-dispatch a server-side watcher run that finished WITHOUT calling complete_window before failing it. 0 disables; omitted = global default.",
      })
    ),
  },
  {
    additionalProperties: false,
    description:
      "[create/update] Per-watcher execution settings: device-worker CLI flags plus the server-side finalize-nudge budget. Omitted fields fall back to dispatcher/CLI/global defaults; pass null to clear.",
  }
);

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
export const ManageWatchersSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("create", {
        description: "Create a watcher with prompt + sources.",
      }),
      Type.Literal("update", { description: "Patch watcher config." }),
      Type.Literal("create_version", {
        description: "Create a new versioned watcher config.",
      }),
      Type.Literal("complete_window", {
        description: "Submit a watcher window result.",
      }),
      Type.Literal("trigger", { description: "Manually fire a watcher run." }),
      Type.Literal("delete", { description: "Bulk-delete watchers." }),
      Type.Literal("set_reaction_script", {
        description: "Attach/remove a TypeScript reaction script.",
      }),
      Type.Literal("get_versions", {
        description: "List a watcher\u2019s version history.",
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
        description: "Retrieve feedback for a watcher.",
      }),
      Type.Literal("list_promoted", {
        description: "List entities promoted by a watcher.",
      }),
      Type.Literal("create_from_version", {
        description: "Spin up watchers per entity from a template version.",
      }),
    ],
    { description: "Action to perform" }
  ),

  // Watcher identity
  watcher_id: Type.Optional(
    Type.String({
      description:
        "[update/upgrade/get_versions/get_version_details/set_reaction_script/trigger] Watcher ID (numeric string)",
    })
  ),
  watcher_ids: Type.Optional(
    Type.Array(Type.String(), {
      description: "[delete] Array of watcher IDs (numeric strings)",
    })
  ),

  // Fields for action="create"
  slug: Type.Optional(
    Type.String({ description: "[create] Unique watcher identifier" })
  ),
  name: Type.Optional(
    Type.String({ description: "[create/create_version] Display name" })
  ),
  description: Type.Optional(
    Type.String({ description: "[create/create_version] Watcher description" })
  ),
  entity_id: Type.Optional(
    Type.Number({
      description:
        "Entity ID. Optional for create — provide it to attach the watcher to an entity; omit it for an org-scoped/global watcher. Optional for list.",
    })
  ),
  entity_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        "[create_from_version] Array of entity IDs to create individual watchers for.",
    })
  ),
  version_id: Type.Optional(
    Type.Number({
      description:
        "[create_from_version] Source version ID to use as template for new watchers.",
    })
  ),
  name_pattern: Type.Optional(
    Type.String({
      description:
        '[create_from_version] Name pattern for created watchers. Use {{entity_name}} for substitution. Default: "{version_name}: {entity_name}".',
    })
  ),

  // Watcher config fields (create/create_version/update)
  prompt: Type.Optional(
    Type.String({
      description:
        "[create/create_version] LLM prompt template (Handlebars). Variables: {{entities}}, {{content}}, {{sources.name}}, {{data.name}}, {{#each entities}}{{name}}{{/each}}.",
    })
  ),
  sources: Type.Optional(
    Type.Array(SourceSchema, {
      description:
        "[create/create_version/update] Array of SQL data sources. Each source is { name, query }.",
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
  schedule: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        '[create/update/create_version] Cron expression for watcher schedule (e.g. "0 * * * *" for hourly, "0 9 * * *" for daily at 9am). Null clears the schedule (an unscheduled/manual watcher).',
    })
  ),
  agent_id: Type.Optional(
    Type.String({
      description: "[create/update] Agent ID that owns/executes this watcher.",
    })
  ),
  scheduler_client_id: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        "[create/update/create_version] Optional MCP client ID that should auto-run this watcher. Null clears it.",
    })
  ),
  device_worker_id: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        "[create/update] Optional device worker UUID to pin this watcher to (when its inputs live on that device). Null clears the pin.",
    })
  ),
  agent_kind: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        '[create/update] Optional agent kind override for this watcher (e.g. "background", "notifier"). Null clears the override.',
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
        "[create/update] Minimum seconds between two firings of this watcher (0 = no cooldown).",
      minimum: 0,
    })
  ),
  model_config: Type.Optional(
    Type.Any({ description: "[create/update] AI model configuration" })
  ),
  // Union with Null so `update` can clear a previously-saved config back to
  // NULL/defaults — omitted = unchanged, null = clear, object = replace. The
  // object shape lives in WatcherExecutionConfigSchema; the role-policy gate
  // (assertValidExecutionConfig) stays in the CRUD handlers.
  execution_config: Type.Optional(
    Type.Union([Type.Null(), WatcherExecutionConfigSchema])
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), { description: "[create] Tags for filtering" })
  ),

  // Version management
  version: Type.Optional(
    Type.Number({ description: "[upgrade/get_version_details] Version number" })
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
          "[complete_window] Required. LLM analysis results. Must match the watcher's extraction contract (derived from its entity type).",
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
        "[complete_window] Multiple page JWTs from read_knowledge for the same watcher window. Content IDs are unioned and linked atomically.",
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
        "[complete_window] Optional watcher run id for run completion/provenance. Workers should pass the Watcher run ID from the dispatch prompt.",
    })
  ),
  template_version_id: Type.Optional(
    Type.Number({
      description:
        "[complete_window] Pin to a specific watcher_versions.id. Workers receive this from the run dispatch payload (snapshotted from current_version_id at run-creation) and pass it back here so validation uses the same version that produced the extraction. Defaults to the run row's snapshot if available, else the watcher's current_version_id.",
    })
  ),

  // Fields for action="set_reaction_script"
  reaction_script: Type.Optional(
    Type.String({
      description:
        "[set_reaction_script] TypeScript source for automated reaction. Set to empty string to remove.",
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
            [Type.Literal("set"), Type.Literal("remove"), Type.Literal("add")],
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
        "[get_feedback] Max feedback records to return (default: 50).",
    })
  ),
});

// ============================================
// Type Definitions
// ============================================

export type ManageWatchersArgs = Static<typeof ManageWatchersSchema>;

/**
 * Result of `manage_watchers` — a discriminated union keyed on `action`.
 * TypeBox-first: the TS type is `Static<>`-derived, and the same schema is the
 * tool's `outputSchema`. Well-structured variants are precise; the genuinely
 * dynamic variants (`get_version_details` carries an open index signature,
 * `get_versions` returns arbitrary version rows, `get_component_reference`
 * embeds a large doc tree) use permissive object shapes so the schema is
 * honest rather than a brittle mirror of shapes that are intentionally open.
 */
export const ManageWatchersDeleteResultSchema = Type.Object({
  watcher_id: Type.String(),
  success: Type.Boolean(),
  message: Type.String(),
  version: Type.Optional(Type.Integer()),
});

export const ManageWatchersFeedbackItemSchema = Type.Object({
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

export const ManageWatchersPromotedEntitySchema = Type.Object({
  id: Type.Integer(),
  name: Type.String(),
  entity_type: Type.String(),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  field_controls: Type.Record(Type.String(), Type.Unknown()),
  window_id: Type.Union([Type.Integer(), Type.Null()]),
  stable_key: Type.Union([Type.String(), Type.Null()]),
});

export const ManageWatchersResultSchema = Type.Union([
  Type.Object({
    action: Type.Literal("create"),
    watcher_id: Type.String(),
    version: Type.Integer(),
    status: Type.String(),
    sources: Type.Optional(Type.Array(WatcherSourceSchema)),
    view_url: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("update"),
    watcher_id: Type.String(),
    updated_fields: Type.Array(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("create_version"),
    watcher_id: Type.String(),
    version_id: Type.String(),
    version: Type.Integer(),
    previous_version: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal("complete_window"),
    watcher_id: Type.String(),
    window_id: Type.Integer(),
    window_start: Type.String(),
    window_end: Type.String(),
    content_linked: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal("trigger"),
    watcher_id: Type.String(),
    run_id: Type.Integer(),
    status: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("delete"),
    results: Type.Array(ManageWatchersDeleteResultSchema),
    summary: Type.Object({
      total: Type.Integer(),
      successful: Type.Integer(),
      failed: Type.Integer(),
    }),
  }),
  Type.Object({
    action: Type.Literal("set_reaction_script"),
    watcher_id: Type.String(),
    has_script: Type.Boolean(),
    message: Type.String(),
  }),
  // Intentionally permissive: version rows are arbitrary config snapshots.
  Type.Object({
    action: Type.Literal("get_versions"),
    watcher_id: Type.String(),
    versions: Type.Array(Type.Unknown()),
  }),
  // Intentionally permissive: carries an open `[key: string]: any` index sig
  // (the full version config snapshot). Intersecting a string→unknown record
  // gives the derived TS type an index signature AND emits
  // `additionalProperties: true` in the JSON Schema.
  Type.Intersect([
    Type.Object({
      action: Type.Literal("get_version_details"),
      watcher_id: Type.String(),
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
    watcher_id: Type.String(),
    window_id: Type.Integer(),
    feedback_ids: Type.Array(Type.Integer()),
  }),
  Type.Object({
    action: Type.Literal("get_feedback"),
    watcher_id: Type.String(),
    feedback: Type.Array(ManageWatchersFeedbackItemSchema),
  }),
  Type.Object({
    action: Type.Literal("list_promoted"),
    watcher_id: Type.String(),
    entities: Type.Array(ManageWatchersPromotedEntitySchema),
  }),
  Type.Object({
    action: Type.Literal("create_from_version"),
    created: Type.Array(
      Type.Object({
        watcher_id: Type.String(),
        entity_id: Type.Integer(),
        name: Type.String(),
      })
    ),
  }),
]);

export type ManageWatchersResult = Static<typeof ManageWatchersResultSchema>;
export const ListWatchersSchema = Type.Object({
  watcher_id: Type.Optional(
    Type.String({
      description:
        "Optional watcher ID (numeric string) to narrow to one watcher",
    })
  ),
  entity_id: Type.Optional(
    Type.Number({
      description:
        "Optional entity ID to list watchers attached to a specific entity",
    })
  ),
  agent_id: Type.Optional(
    Type.String({
      description:
        "Optional agent ID to list watchers owned by a specific agent",
    })
  ),
  status: Type.Optional(
    Type.String({
      description:
        'Optional status filter. Use "active" or "archived". Omit to include all.',
    })
  ),
  include_details: Type.Optional(
    Type.Boolean({
      description:
        "Include prompt, schema, and sources in response (default: false)",
    })
  ),
  watcher_group_id: Type.Optional(
    Type.Number({
      description:
        "Filter watchers sharing a watcher_group_id (for legacy group URL resolution)",
    })
  ),
  order_by: Type.Optional(
    Type.Union([Type.Literal("last_fired_at"), Type.Literal("created_at")], {
      description:
        "Sort field. Omit for created_at DESC (default, backward compatible).",
    })
  ),
  order_dir: Type.Optional(
    Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
      description: "Sort direction (default: desc)",
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum watchers to return (omit for all)",
    })
  ),
});

export type ListWatchersArgs = Static<typeof ListWatchersSchema>;

export const ListWatchersResultSchema = Type.Object({
  watchers: Type.Array(Type.Record(Type.String(), Type.Unknown())),
});
export type ListWatchersResult = Static<typeof ListWatchersResultSchema>;
