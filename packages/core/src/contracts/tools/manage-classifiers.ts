import { type Static, Type } from "@sinclair/typebox";

// ============================================
// Typebox Schema
// ============================================

export const ManageClassifiersSchema = Type.Object({
  action: Type.Union(
    [
      // Template CRUD
      Type.Literal("create", {
        description:
          "Create a classifier. Org-level by default; pass automation_id to scope it to one Automation.",
      }),
      Type.Literal("list", { description: "List classifiers with filters." }),
      Type.Literal("generate_embeddings", {
        description: "Generate/regenerate attribute-value embeddings.",
      }),
      Type.Literal("delete", {
        description: "Archive a classifier (status -> deprecated).",
      }),
      // Manual classification
      Type.Literal("classify", {
        description: "Manual single/batch classification.",
      }),
      Type.Literal("apply", {
        description:
          "Run a classifier over specific content ids (embedding match, no LLM). Re-running re-labels: it replaces prior embedding results and never touches manual/LLM ones. Use after editing a classifier — run generate_embeddings first.",
      }),
    ],
    { description: "Action to perform" }
  ),

  // Template fields
  entity_id: Type.Optional(
    Type.Number({
      description:
        "[create/list] Entity ID to scope classifiers (global if omitted)",
    })
  ),
  automation_id: Type.Optional(
    Type.String({
      description:
        "[create] Persisted Automation ID returned by manage_automations (numeric string). OMIT for an org-level classifier — only those are matched by `apply` and the reconciliation job. Pass it only to scope the classifier to a single Automation.",
    })
  ),
  classifier_id: Type.Optional(
    Type.Number({
      description: "[generate_embeddings/delete] Classifier ID",
    })
  ),
  slug: Type.Optional(
    Type.String({
      description: '[create] Unique identifier (e.g., "sentiment", "quality")',
    })
  ),
  name: Type.Optional(Type.String({ description: "[create] Display name" })),
  description: Type.Optional(
    Type.String({ description: "[create] Classifier description" })
  ),
  attribute_key: Type.Optional(
    Type.String({
      description:
        '[create] Key in content classifications (e.g., "sentiment")',
    })
  ),
  attribute_values: Type.Optional(
    Type.Record(
      Type.String({ minLength: 1 }),
      Type.Object(
        {
          description: Type.String(),
          examples: Type.Array(Type.String()),
          embedding: Type.Optional(
            Type.Union([
              Type.Array(Type.Number(), { minItems: 1 }),
              Type.Null(),
            ])
          ),
        },
        { additionalProperties: false }
      ),
      {
        minProperties: 1,
        description:
          "[create] Map of attribute values to descriptions, examples, and optional embeddings.",
      }
    )
  ),
  min_similarity: Type.Optional(
    Type.Number({
      description: "[create] Minimum similarity threshold (default: 0.7)",
    })
  ),
  fallback_value: Type.Optional(
    Type.Any({
      description: "[create] Fallback value if no match (default: null)",
    })
  ),
  created_by: Type.Optional(
    Type.String({ description: "[create] Creator identifier" })
  ),
  status: Type.Optional(
    Type.String({
      description:
        "[list] Filter by status. Defaults to 'active' (deprecated classifiers are excluded). Pass 'deprecated' to see archived ones, or 'all' to list every classifier regardless of status.",
    })
  ),
  force_regenerate: Type.Optional(
    Type.Boolean({
      description:
        "[generate_embeddings] Force regenerate existing embeddings (default: false)",
    })
  ),
  embedding_model: Type.Optional(
    Type.String({
      description:
        "[create/generate_embeddings/apply] Embedding model to use. Defaults to this deployment's configured model; only set it to work in a different vector space. Label vectors and event vectors must share a model — a classifier embedded under one model matches nothing when applied under another, and `apply` will report every id as not_embedded until the events are embedded under the same model.",
    })
  ),

  // Manual classification fields
  content_id: Type.Optional(
    Type.Number({
      description: "[classify] Content ID to update (single mode)",
    })
  ),
  classifications: Type.Optional(
    Type.Array(
      Type.Object({
        content_id: Type.Number({ description: "Content ID" }),
        value: Type.Union([Type.String(), Type.Null()], {
          description: "Classification value, or null to unset",
        }),
        reasoning: Type.Optional(
          Type.String({
            description: "Reasoning/justification for this classification",
          })
        ),
      }),
      {
        description:
          "[classify] Array of classifications to update (batch mode)",
      }
    )
  ),
  content_ids: Type.Optional(
    Type.Array(Type.Number(), {
      minItems: 1,
      maxItems: 2000,
      description:
        "[apply] Content ids to classify. Get them with a read-only SQL query first, then pass them here. Ids outside your organization, or without an embedding, are skipped and reported — never silently dropped.",
    })
  ),
  classifier_slug: Type.Optional(
    Type.String({
      description:
        '[classify/apply] Classifier slug (e.g., "sentiment", "bug-severity")',
    })
  ),
  value: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        "[classify] Classification value for single update, or null to unset",
    })
  ),
  source: Type.Optional(
    Type.Union([Type.Literal("llm"), Type.Literal("user")], {
      description:
        '[classify] Classification source: "llm" (AI-generated) or "user" (manual). Defaults to "user".',
    })
  ),
  reasoning: Type.Optional(
    Type.String({
      description:
        "[classify] Reasoning/justification for the classification(s)",
    })
  ),
});

export type ManageClassifiersArgs = Static<typeof ManageClassifiersSchema>;

/**
 * Result of `manage_classifiers`. TypeBox-first: `Static<>` derives the TS type
 * from the same schema exposed as the tool's `outputSchema`. `data` is an
 * arbitrary payload (varies by action) so it's honestly `unknown`.
 */
export const ManageClassifiersResultSchema = Type.Object({
  success: Type.Boolean(),
  action: Type.String(),
  message: Type.Optional(Type.String()),
  data: Type.Optional(Type.Unknown()),
});
export type ManageClassifiersResult = Static<
  typeof ManageClassifiersResultSchema
>;
