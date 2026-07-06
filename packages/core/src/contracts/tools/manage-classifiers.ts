import { type Static, Type } from "@sinclair/typebox";

// ============================================
// Typebox Schema
// ============================================

export const ManageClassifiersSchema = Type.Object({
  action: Type.Union(
    [
      // Template CRUD
      Type.Literal("create", {
        description: "Create a classifier (must belong to a watcher).",
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
  watcher_id: Type.Optional(
    Type.Number({
      description:
        "[create] Watcher ID (required — classifiers must belong to a watcher)",
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
    Type.Any({
      description:
        "[create] Attribute values with descriptions, examples, and optional embeddings.",
    })
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
      description: "[list] Filter by status (active or deprecated)",
    })
  ),
  force_regenerate: Type.Optional(
    Type.Boolean({
      description:
        "[generate_embeddings] Force regenerate existing embeddings (default: false)",
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
  classifier_slug: Type.Optional(
    Type.String({
      description:
        '[classify] Classifier slug (e.g., "sentiment", "bug-severity")',
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
