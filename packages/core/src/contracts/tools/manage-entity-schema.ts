import { type Static, Type } from "@sinclair/typebox";

// ============================================
// Typebox Schema
// ============================================

export const AutoCreateWhenRuleInputSchema = Type.Object(
  {
    sourceNamespace: Type.String({ minLength: 1 }),
    targetField: Type.String({ minLength: 1 }),
    assuranceRequired: Type.Union([
      Type.Literal("oauth_verified_admin_role"),
      Type.Literal("oauth_verified"),
      Type.Literal("cookie_session"),
      Type.Literal("self_attested"),
    ]),
    matchStrategy: Type.Union([
      Type.Literal("unique_only"),
      Type.Literal("all_matches"),
    ]),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false }
);

/** Derived-entity backing: a read-only SQL view. */
export const BackingInputSchema = Type.Object(
  {
    sql: Type.String({
      minLength: 1,
      description: "ANSI SELECT defining the view",
    }),
    connection: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Optional connection slug. When set, the view runs LIVE against that connection’s external database (read-only, no copy) instead of internal tables. Stored verbatim; resolved to the connection at read time.",
      })
    ),
  },
  { additionalProperties: false }
);

export const ManageEntitySchemaSchema = Type.Object({
  schema_type: Type.Union(
    [Type.Literal("entity_type"), Type.Literal("relationship_type")],
    {
      description: "Whether to manage entity types or relationship types",
    }
  ),

  action: Type.Union(
    [
      // Shared actions
      Type.Literal("list", {
        description: "List entity types or relationship types.",
      }),
      Type.Literal("get", { description: "Fetch one type by slug." }),
      Type.Literal("create", {
        description:
          "Create an entity type or relationship type (queued for approval).",
      }),
      Type.Literal("update", {
        description: "Patch a type (queued for approval).",
      }),
      Type.Literal("delete", {
        description: "Soft-delete a type; refuses if rows still reference it.",
      }),
      // Entity type only
      Type.Literal("audit", {
        description: "Fetch entity_type_audit rows (entity_type only).",
      }),
      // Relationship type only
      Type.Literal("add_rule", {
        description:
          "Add an allowed source→target type rule (relationship_type only).",
      }),
      Type.Literal("remove_rule", {
        description: "Soft-delete a rule (relationship_type only).",
      }),
      Type.Literal("list_rules", {
        description: "List allowed type rules (relationship_type only).",
      }),
    ],
    { description: "Action to perform" }
  ),

  // Identification
  slug: Type.Optional(
    Type.String({
      description:
        "[get/create/update/delete/audit/add_rule/remove_rule/list_rules] Type slug",
      minLength: 1,
    })
  ),

  // Shared create/update fields
  name: Type.Optional(
    Type.String({ description: "[create/update] Display name", minLength: 1 })
  ),
  description: Type.Optional(
    Type.String({ description: "[create/update] Description" })
  ),
  metadata_schema: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "[create/update] JSON Schema for metadata validation",
    })
  ),

  // Entity type fields
  icon: Type.Optional(
    Type.String({ description: "[entity_type: create/update] Emoji or icon" })
  ),
  color: Type.Optional(
    Type.String({
      description: "[entity_type: create/update] Color for UI display",
    })
  ),
  event_kinds: Type.Optional(
    Type.Union(
      [
        Type.Null(),
        Type.Record(
          Type.String(),
          Type.Object({
            description: Type.Optional(Type.String()),
            metadataSchema: Type.Optional(
              Type.Record(Type.String(), Type.Unknown())
            ),
            jsonTemplate: Type.Optional(
              Type.Record(Type.String(), Type.Unknown())
            ),
          })
        ),
      ],
      {
        description:
          "[entity_type: create/update] Event semantic types this type produces, keyed by semantic_type slug. Each entry can have a description, optional metadataSchema (JSON Schema), and optional jsonTemplate (render template). `null` clears all kinds; omit to leave unchanged.",
      }
    )
  ),
  backing: Type.Optional(
    Type.Union([Type.Null(), BackingInputSchema], {
      description:
        "[entity_type: create/update] Makes the type DERIVED — a read-only SQL view. `{ sql }` runs over your org's internal tables; `{ sql, connection: <slug> }` runs LIVE against that connection's external database (read-only, no copy). `null` clears it (revert to a stored type); omit to leave unchanged. Read a derived type's rows by running its `backing_sql` (returned by `get`) through `query_sql` — and when `get` also returns a `backing_source`, pass it as `query_sql`'s `connection` so the view runs against the external DB instead of your internal tables. `get` also returns `measure_columns` (the view's aggregate columns, classified on read).",
    })
  ),
  metrics_config: Type.Optional(
    Type.Union([Type.Null(), Type.Record(Type.String(), Type.Unknown())], {
      description:
        "[entity_type: create/update] Declared metric contract (eventSets/measures/dimensions/segments — see @lobu/connector-sdk) stored verbatim. The metric compiler lowers it into backing SQL. `null` clears it; omit to leave unchanged.",
    })
  ),

  // Relationship type fields
  is_symmetric: Type.Optional(
    Type.Boolean({
      description:
        "[relationship_type: create] Whether the relationship is symmetric (A↔B = B↔A). Default false.",
    })
  ),
  inverse_type_slug: Type.Optional(
    Type.String({
      description:
        '[relationship_type: create/update] Slug of the inverse relationship type (e.g., "depends_on" ↔ "dependency_of")',
    })
  ),
  status: Type.Optional(
    Type.Union([Type.Literal("active"), Type.Literal("archived")], {
      description: "[relationship_type: create/update] Status. Default active.",
    })
  ),
  auto_create_when: Type.Optional(
    Type.Array(AutoCreateWhenRuleInputSchema, {
      maxItems: 16,
      description:
        "[relationship_type: create/update] Identity-engine auto-derivation rules stored on relationship_type.metadata.autoCreateWhen",
    })
  ),

  // Rule fields (relationship_type only)
  source_entity_type_slug: Type.Optional(
    Type.String({
      description: "[relationship_type: add_rule] Source entity type slug",
    })
  ),
  target_entity_type_slug: Type.Optional(
    Type.String({
      description: "[relationship_type: add_rule] Target entity type slug",
    })
  ),
  rule_id: Type.Optional(
    Type.Number({
      description: "[relationship_type: remove_rule] Rule ID to remove",
    })
  ),

  // List filters
  include_deleted: Type.Optional(
    Type.Boolean({
      description: "[relationship_type: list] Include soft-deleted types",
    })
  ),
});

export type ManageEntitySchemaArgs = Static<typeof ManageEntitySchemaSchema>;

// ============================================
// Result Types
// ============================================

// An authored view template + its live data. Same shape resolve_path returns for
// entity-detail tabs; duplicated (not imported) to avoid coupling this admin tool
// to resolve_path's module-private schema.
export const ViewTemplateTabSchema = Type.Object({
  tab_name: Type.String(),
  tab_order: Type.Integer(),
  json_template: Type.Record(Type.String(), Type.Unknown()),
  version: Type.Integer(),
  version_id: Type.Integer(),
  template_data: Type.Union([
    Type.Record(Type.String(), Type.Array(Type.Unknown())),
    Type.Null(),
  ]),
});
export type ViewTemplateTab = Static<typeof ViewTemplateTabSchema>;

export const EntityTypeRowSchema = Type.Object({
  id: Type.Integer(),
  slug: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  icon: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  color: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  metadata_schema: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  event_kinds: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  backing_sql: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** Connection slug an external-backed derived view runs against; null ⇒ internal. */
  backing_source: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** Declared metric contract (eventSets/measures/dimensions/segments), stored verbatim; null ⇒ none. */
  metrics_config: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  is_system: Type.Boolean(),
  created_by: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  organization_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  organization_slug: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  // `Date` in the row; serialized to ISO over the wire. Accept either.
  created_at: Type.Union([Type.String(), Type.Unknown()]),
  updated_at: Type.Union([Type.String(), Type.Unknown()]),
  entity_count: Type.Optional(Type.Integer()),
  current_view_template_version_id: Type.Optional(
    Type.Union([Type.Integer(), Type.Null()])
  ),
  /** Derived types only — the view's aggregate columns, classified on read. */
  measure_columns: Type.Optional(Type.Array(Type.String())),
  /**
   * Authored TYPE-level list view templates (view_template_active_tabs for
   * resource_type='entity_type'), each with its `data_sources` run LIVE on read.
   * Populated only by `get`; the list-view switcher lists these alongside the
   * built-in Table/Board/Gallery. Same shape as resolve_path's tab payload.
   */
  view_templates: Type.Optional(Type.Array(ViewTemplateTabSchema)),
});
export type EntityTypeRow = Static<typeof EntityTypeRowSchema>;

export const AuditEntrySchema = Type.Object({
  id: Type.Integer(),
  entity_type_id: Type.Integer(),
  action: Type.String(),
  actor: Type.Union([Type.String(), Type.Null()]),
  before_payload: Type.Union([
    Type.Record(Type.String(), Type.Unknown()),
    Type.Null(),
  ]),
  after_payload: Type.Union([
    Type.Record(Type.String(), Type.Unknown()),
    Type.Null(),
  ]),
  created_at: Type.String(),
});
export type AuditEntry = Static<typeof AuditEntrySchema>;

export const RelationshipTypeRowSchema = Type.Object({
  id: Type.Integer(),
  slug: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  organization_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  organization_slug: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  created_by: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  metadata_schema: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  metadata: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  is_symmetric: Type.Boolean(),
  inverse_type_id: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  inverse_type_slug: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  status: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String(),
  deleted_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  relationship_count: Type.Optional(Type.Integer()),
});
export type RelationshipTypeRow = Static<typeof RelationshipTypeRowSchema>;

export const RelationshipTypeRuleRowSchema = Type.Object({
  id: Type.Integer(),
  relationship_type_id: Type.Integer(),
  source_entity_type_slug: Type.String(),
  target_entity_type_slug: Type.String(),
  created_at: Type.String(),
});
export type RelationshipTypeRuleRow = Static<
  typeof RelationshipTypeRuleRowSchema
>;

/**
 * Result of `manage_entity_schema` — discriminated union keyed on
 * `schema_type` + `action`. TypeBox-first: `Static<>` derives the TS type from
 * the same schema exposed as the tool's `outputSchema`.
 */
export const ManageEntitySchemaResultSchema = Type.Union([
  // Entity type results
  Type.Object({
    schema_type: Type.Literal("entity_type"),
    action: Type.Literal("list"),
    entity_types: Type.Array(EntityTypeRowSchema),
  }),
  Type.Object({
    schema_type: Type.Literal("entity_type"),
    action: Type.Literal("get"),
    entity_type: Type.Union([EntityTypeRowSchema, Type.Null()]),
  }),
  Type.Object({
    schema_type: Type.Literal("entity_type"),
    action: Type.Literal("create"),
    entity_type: EntityTypeRowSchema,
  }),
  Type.Object({
    schema_type: Type.Literal("entity_type"),
    action: Type.Literal("update"),
    entity_type: EntityTypeRowSchema,
  }),
  Type.Object({
    schema_type: Type.Literal("entity_type"),
    action: Type.Literal("delete"),
    success: Type.Boolean(),
    message: Type.String(),
  }),
  Type.Object({
    schema_type: Type.Literal("entity_type"),
    action: Type.Literal("audit"),
    audit_entries: Type.Array(AuditEntrySchema),
  }),
  // Relationship type results
  Type.Object({
    schema_type: Type.Literal("relationship_type"),
    action: Type.Literal("list"),
    relationship_types: Type.Array(RelationshipTypeRowSchema),
  }),
  Type.Object({
    schema_type: Type.Literal("relationship_type"),
    action: Type.Literal("get"),
    relationship_type: Type.Union([RelationshipTypeRowSchema, Type.Null()]),
  }),
  Type.Object({
    schema_type: Type.Literal("relationship_type"),
    action: Type.Literal("create"),
    relationship_type: RelationshipTypeRowSchema,
  }),
  Type.Object({
    schema_type: Type.Literal("relationship_type"),
    action: Type.Literal("update"),
    relationship_type: RelationshipTypeRowSchema,
  }),
  Type.Object({
    schema_type: Type.Literal("relationship_type"),
    action: Type.Literal("delete"),
    success: Type.Boolean(),
    message: Type.String(),
  }),
  Type.Object({
    schema_type: Type.Literal("relationship_type"),
    action: Type.Literal("add_rule"),
    rule: RelationshipTypeRuleRowSchema,
  }),
  Type.Object({
    schema_type: Type.Literal("relationship_type"),
    action: Type.Literal("remove_rule"),
    success: Type.Boolean(),
    message: Type.String(),
  }),
  Type.Object({
    schema_type: Type.Literal("relationship_type"),
    action: Type.Literal("list_rules"),
    rules: Type.Array(RelationshipTypeRuleRowSchema),
  }),
]);
export type ManageEntitySchemaResult = Static<
  typeof ManageEntitySchemaResultSchema
>;
