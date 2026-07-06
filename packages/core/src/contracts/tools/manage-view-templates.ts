import { type Static, Type } from "@sinclair/typebox";

// ============================================
// View template versioning types + helpers
// ============================================

export const ViewTemplateVersionRowSchema = Type.Object({
  id: Type.Integer(),
  version: Type.Integer(),
  tab_name: Type.Union([Type.String(), Type.Null()]),
  tab_order: Type.Integer(),
  json_template: Type.Record(Type.String(), Type.Unknown()),
  change_notes: Type.Union([Type.String(), Type.Null()]),
  created_by: Type.String(),
  created_by_username: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
});
export type ViewTemplateVersionRow = Static<
  typeof ViewTemplateVersionRowSchema
>;

export const ViewTemplateTabInfoSchema = Type.Object({
  tab_name: Type.String(),
  tab_order: Type.Integer(),
  current_version: Type.Integer(),
  current_version_id: Type.Integer(),
  json_template: Type.Record(Type.String(), Type.Unknown()),
});

// ============================================
// Schema
// ============================================

export const ManageViewTemplatesSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("set", {
        description: "Create a new version of a view template / tab.",
      }),
      Type.Literal("get", {
        description: "Fetch current default + tabs + history.",
      }),
      Type.Literal("rollback", {
        description: "Roll back to a prior version.",
      }),
      Type.Literal("remove_tab", { description: "Delete a named tab." }),
      Type.Literal("clear", {
        description: "Null the default (non-tab) template.",
      }),
    ],
    { description: "Action to perform" }
  ),

  resource_type: Type.Union(
    [Type.Literal("entity_type"), Type.Literal("entity")],
    {
      description: "Type of resource: entity_type or entity",
    }
  ),
  resource_id: Type.Union([Type.String(), Type.Number()], {
    description:
      "Resource identifier: entity type slug (string) or entity id (number)",
  }),

  json_template: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        '[set] The JSON template content. May include a data_sources key: { "data_sources": { "name": { "query": "SELECT ... FROM entities" } }, ...template }. Queries run against org-scoped virtual tables. Use {{entityId}} for current entity context.',
    })
  ),
  tab_name: Type.Optional(
    Type.String({
      description: "Tab name. Omit for the default/overview tab.",
    })
  ),
  tab_order: Type.Optional(
    Type.Number({ description: "[set] Sort order for tabs (default 0)" })
  ),
  change_notes: Type.Optional(
    Type.String({ description: "[set] Notes describing the change" })
  ),
  version: Type.Optional(
    Type.Number({ description: "[rollback] Version number to rollback to" })
  ),
});

export type ManageViewTemplatesArgs = Static<typeof ManageViewTemplatesSchema>;

// ============================================
// Result Types
// ============================================

/**
 * Result of `manage_view_templates` — discriminated union keyed on `action`.
 * TypeBox-first: `Static<>` derives the TS type from the same schema exposed as
 * the tool's `outputSchema`.
 */
export const ManageViewTemplatesResultSchema = Type.Union([
  Type.Object({
    action: Type.Literal("set"),
    version: ViewTemplateVersionRowSchema,
    message: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("get"),
    default_tab: Type.Object({
      current: Type.Union([ViewTemplateVersionRowSchema, Type.Null()]),
      history: Type.Array(ViewTemplateVersionRowSchema),
    }),
    tabs: Type.Array(ViewTemplateTabInfoSchema),
  }),
  Type.Object({
    action: Type.Literal("rollback"),
    version: ViewTemplateVersionRowSchema,
    message: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("remove_tab"),
    success: Type.Boolean(),
    message: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("clear"),
    success: Type.Boolean(),
    message: Type.String(),
  }),
]);
export type ManageViewTemplatesResult = Static<
  typeof ManageViewTemplatesResultSchema
>;
