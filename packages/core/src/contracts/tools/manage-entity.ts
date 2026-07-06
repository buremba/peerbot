import { type Static, Type } from "@sinclair/typebox";

function SortOrderField(description: string) {
  return Type.Optional(
    Type.Union([Type.Literal("asc"), Type.Literal("desc")], { description })
  );
}

// ============================================
// Typebox Schema
// ============================================

export const ManageEntitySchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("create", {
        description: "Create an entity of a given type.",
      }),
      Type.Literal("update", {
        description:
          "Patch entity fields (human-owned fields queued for approval).",
      }),
      Type.Literal("list", {
        description: "Paginated entity list with filters.",
      }),
      Type.Literal("get", { description: "Fetch one entity." }),
      Type.Literal("delete", {
        description: "Delete an entity (force_delete_tree for cascading).",
      }),
      Type.Literal("link", {
        description: "Create a relationship edge between two entities.",
      }),
      Type.Literal("unlink", { description: "Soft-delete a relationship." }),
      Type.Literal("update_link", {
        description: "Patch relationship metadata/confidence/source.",
      }),
      Type.Literal("list_links", {
        description: "List relationships for an entity with filters + counts.",
      }),
    ],
    { description: "Action to perform" }
  ),

  // Entity type (required for create, list)
  entity_type: Type.Optional(
    Type.String({
      description: "Entity type as defined in your workspace",
    })
  ),

  // Entity ID (for get, update, delete, list_links)
  entity_id: Type.Optional(
    Type.Number({
      description: "[get/update/delete/list_links] Entity ID to operate on",
    })
  ),

  // Common fields
  name: Type.Optional(
    Type.String({ description: "[create/update] Entity name", minLength: 1 })
  ),
  content: Type.Optional(
    Type.String({
      description:
        "[create/update] Free-text content body. Used by memory entities and any entity that carries rich text.",
    })
  ),
  slug: Type.Optional(
    Type.String({
      description:
        "[create/update] URL-friendly slug (auto-generated from name if not provided)",
      pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
    })
  ),
  parent_id: Type.Optional(
    Type.Number({
      description:
        "[create/update] Parent entity ID (for hierarchical entities)",
    })
  ),
  enabled_classifiers: Type.Optional(
    Type.Array(Type.String(), {
      description: "[create/update] Enabled classifier slugs",
    })
  ),

  // Optional fields (available on all entity types)
  domain: Type.Optional(
    Type.String({
      description: "[create/update] Primary domain (e.g., spotify.com)",
    })
  ),
  category: Type.Optional(
    Type.String({ description: "[create/update/list] Industry category" })
  ),
  platform_type: Type.Optional(
    Type.String({
      description: "[create/update] Platform type (b2b, b2c, b2b2c)",
    })
  ),
  main_market: Type.Optional(
    Type.String({
      description: "[create/update/list] Primary market (ISO 3166-1 alpha-2)",
    })
  ),
  market: Type.Optional(
    Type.String({
      description: "[create/update/list] Market/region (ISO 3166-1 alpha-2)",
    })
  ),
  link: Type.Optional(
    Type.String({ description: "[create/update] Entity URL" })
  ),

  // Custom metadata (validated against entity type's JSON schema)
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "[create/update/link/update_link] Custom metadata object. For entities: validated against the entity type's JSON schema. For links: relationship metadata. On update, fields a human owns are NOT overwritten — they are queued for the human's approval and reported in the result's `blocked_fields`/`approval_queued`; tell the user you PROPOSED those changes rather than claiming you set them. Unowned fields in the same call apply directly (`applied_fields`).",
    })
  ),

  // Human-correction annotation
  field_note: Type.Optional(
    Type.String({
      description:
        "[update] Optional note explaining a human correction. Stored on the per-field ownership marker for every metadata field this update sets, so a watcher (and the UI) can see why the value was set.",
    })
  ),

  // Approve/affirm: claim ownership of a field's current value without changing it
  affirm_fields: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "[update] Metadata field names whose CURRENT value the human approves as-is. No value change, but each is marked human-owned so a watcher can't later overwrite it without an approval. The 'approve' half of the recap feedback loop.",
    })
  ),

  // List/pagination
  search: Type.Optional(Type.String({ description: "[list] Search by name" })),
  limit: Type.Optional(
    Type.Number({
      description: "[list/list_links] Page size (default: 100, max: 500)",
    })
  ),
  offset: Type.Optional(
    Type.Number({
      description: "[list/list_links] Pagination offset (default: 0)",
    })
  ),
  sort_by: Type.Optional(
    Type.String({
      description:
        "[list] Sort by column (name, created_at, domain, total_content, active_connections, watchers_count, children_count)",
    })
  ),
  sort_order: SortOrderField("[list] Sort order (asc or desc)"),

  // Delete options
  force_delete_tree: Type.Optional(
    Type.Boolean({
      description: "[delete] Force delete entity and all descendants",
    })
  ),

  // ---- Relationship (link) fields ----
  from_entity_id: Type.Optional(
    Type.Number({ description: "[link] Source entity ID" })
  ),
  to_entity_id: Type.Optional(
    Type.Number({ description: "[link] Target entity ID" })
  ),
  relationship_type_slug: Type.Optional(
    Type.String({
      description: "[link/list_links] Relationship type slug",
      minLength: 1,
    })
  ),
  confidence: Type.Optional(
    Type.Number({
      description:
        "[link/update_link] Confidence score 0-1. Defaults to 1.0 for ui/api source.",
      minimum: 0,
      maximum: 1,
    })
  ),
  source: Type.Optional(
    Type.Union(
      [
        Type.Literal("ui"),
        Type.Literal("llm"),
        Type.Literal("feed"),
        Type.Literal("api"),
      ],
      { description: "[link/update_link] Source of the relationship" }
    )
  ),
  relationship_id: Type.Optional(
    Type.Number({ description: "[update_link/unlink] Relationship ID" })
  ),
  direction: Type.Optional(
    Type.Union(
      [Type.Literal("outbound"), Type.Literal("inbound"), Type.Literal("both")],
      {
        description: "[list_links] Direction filter. Default both.",
      }
    )
  ),
  confidence_min: Type.Optional(
    Type.Number({
      description: "[list_links] Minimum confidence threshold",
      minimum: 0,
      maximum: 1,
    })
  ),
  include_deleted: Type.Optional(
    Type.Boolean({
      description: "[list_links] Include soft-deleted relationships",
    })
  ),
  watcher_source: Type.Optional(
    Type.Object(
      {
        watcher_id: Type.Number({
          description: "Watcher that triggered this mutation",
        }),
        window_id: Type.Number({
          description: "Window that triggered this mutation",
        }),
      },
      {
        description:
          "Attribution source when mutation is triggered by a watcher reaction",
      }
    )
  ),
});

export type ManageEntityArgs = Static<typeof ManageEntitySchema>;

// ============================================
// Result Types
// ============================================

// Relationship row shape (used by link actions)
export const RelationshipRowSchema = Type.Object({
  id: Type.Integer(),
  organization_id: Type.String(),
  from_entity_id: Type.Integer(),
  to_entity_id: Type.Integer(),
  relationship_type_id: Type.Integer(),
  relationship_type_slug: Type.String(),
  relationship_type_name: Type.String(),
  is_symmetric: Type.Boolean(),
  from_entity_name: Type.Optional(Type.String()),
  from_entity_type: Type.Optional(Type.String()),
  to_entity_name: Type.Optional(Type.String()),
  to_entity_type: Type.Optional(Type.String()),
  metadata: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  confidence: Type.Number(),
  source: Type.String(),
  created_by: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  updated_by: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  created_at: Type.String(),
  updated_at: Type.String(),
  deleted_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type RelationshipRow = Static<typeof RelationshipRowSchema>;

export const RelationshipCountByTypeSchema = Type.Object({
  relationship_type_slug: Type.String(),
  relationship_type_name: Type.String(),
  count: Type.Integer(),
});
export type RelationshipCountByType = Static<
  typeof RelationshipCountByTypeSchema
>;

/**
 * Shared entity shape across the create/update/get/list variants (the superset
 * of fields; each variant marks its extras optional). `metadata` and the
 * classifier/parent fields are loose on purpose — entities carry arbitrary
 * user/workspace metadata.
 */
export const ManageEntityItemSchema = Type.Object({
  id: Type.Integer(),
  entity_type: Type.String(),
  name: Type.String(),
  slug: Type.String(),
  parent_id: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  parent_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  parent_slug: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  parent_entity_type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  enabled_classifiers: Type.Optional(
    Type.Union([Type.Array(Type.String()), Type.Null()])
  ),
  // `created_at` arrives from the row as a `Date`; the structuredContent
  // validation layer coerces it to an ISO string before the check (Value.Convert
  // on Type.String() converts Date → ISO), so the schema declares the honest
  // on-the-wire shape — a string. (The former `Type.Unknown()` union arm made
  // this field accept ANY value, silently voiding its type.)
  created_at: Type.Optional(Type.String()),
  total_content: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  active_connections: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  watchers_count: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  children_count: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  space_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  view_url: Type.Optional(Type.String()),
});

/**
 * Result of `manage_entity` — discriminated union keyed on `action`.
 * TypeBox-first: `Static<>` derives the TS type from the same schema exposed as
 * the tool's `outputSchema`.
 */
export const ManageEntityResultSchema = Type.Union([
  Type.Object({
    action: Type.Literal("create"),
    entity: ManageEntityItemSchema,
    warnings: Type.Optional(Type.Array(Type.String())),
    next_steps: Type.Array(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("update"),
    entity: ManageEntityItemSchema,
    /** Fields the ownership-aware merge wrote (unowned for a watcher-source edit). */
    applied_fields: Type.Optional(Type.Array(Type.String())),
    /** Human-owned fields the edit was blocked from writing — queued for approval. */
    blocked_fields: Type.Optional(Type.Array(Type.String())),
    /** True when a blocked-field approval was queued this call. */
    approval_queued: Type.Optional(Type.Boolean()),
    /** Permalink to the approval card, when one was queued. */
    approval_url: Type.Optional(Type.String()),
    /** Pending approval run id — the worker bridges this into a live chat
     *  approval card (parity with manage_agents' `pending_approval`). */
    approval_run_id: Type.Optional(Type.Integer()),
    /** Blocked field_path -> proposed value, for the live card diff. */
    approval_fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    /** Blocked field_path -> current human-owned value, for the diff. */
    approval_current: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    /** Who proposed the blocked change: 'agent' | 'watcher'. */
    approval_attribution: Type.Optional(
      Type.Union([Type.Literal("agent"), Type.Literal("watcher")])
    ),
  }),
  Type.Object({
    action: Type.Literal("list"),
    entities: Type.Array(ManageEntityItemSchema),
    // Server-side resolution of every `x-link-entity-type` column referenced
    // by the page. Keyed by `${entityType}:${lookupField}`, then by the
    // lookup value from the row's metadata. Previously each entity-list page
    // fanned out one `manage_entity.list` per linked column (4× ~2.5 s on
    // the Company page); the FE now reads from this map instead.
    linked_entities: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Record(
          Type.String(),
          Type.Object({
            slug: Type.String(),
            entity_type: Type.String(),
            name: Type.String(),
          })
        )
      )
    ),
    metadata: Type.Object({
      page_size: Type.Integer(),
      has_more: Type.Boolean(),
      filtered_by_type: Type.Optional(Type.String()),
      total_count: Type.Optional(Type.Integer()),
      limit: Type.Optional(Type.Integer()),
      offset: Type.Optional(Type.Integer()),
      sort_by: Type.Optional(Type.String()),
      sort_order: Type.Optional(
        Type.Union([Type.Literal("asc"), Type.Literal("desc")])
      ),
    }),
  }),
  Type.Object({
    action: Type.Literal("get"),
    entity: ManageEntityItemSchema,
  }),
  Type.Object({
    action: Type.Literal("delete"),
    success: Type.Boolean(),
    message: Type.String(),
    deleted_count: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal("link"),
    relationship: RelationshipRowSchema,
  }),
  Type.Object({
    action: Type.Literal("update_link"),
    relationship: RelationshipRowSchema,
  }),
  Type.Object({
    action: Type.Literal("unlink"),
    success: Type.Boolean(),
    message: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("list_links"),
    relationships: Type.Array(RelationshipRowSchema),
    counts_by_type: Type.Array(RelationshipCountByTypeSchema),
    metadata: Type.Object({
      total: Type.Integer(),
      limit: Type.Integer(),
      offset: Type.Integer(),
      has_more: Type.Boolean(),
    }),
  }),
]);
export type ManageEntityResult = Static<typeof ManageEntityResultSchema>;
