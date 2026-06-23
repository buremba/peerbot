/**
 * Tool: manage_classifiers
 *
 * Unified classifier management: template CRUD, entity-classifier assignment, and manual classification.
 *
 * Template actions:
 * - create: Create new classifier (v1)
 * - list: List all classifiers (optionally filter by slug/status)
 * - generate_embeddings: Generate embeddings for attribute values
 * - delete: Archive classifier (soft delete)
 *
 * Manual classification:
 * - classify: Update content classification manually (single or batch)
 */

import { type Static, Type } from '@sinclair/typebox';
import type { DbClient } from '../../db/client';
import { getDb } from '../../db/client';
import type { Env } from '../../index';
import {
  generateEmbeddings as generateEmbeddingsViaService,
  isValidEmbedding,
} from '../../utils/embeddings';
import logger from '../../utils/logger';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';
import { defineFlatActionTool, flatAction } from './action-tool';

// ============================================
// Typebox Schema
// ============================================

export const ManageClassifiersSchema = Type.Object({
  action: Type.Union(
    [
      // Template CRUD
      Type.Literal('create'),
      Type.Literal('list'),
      Type.Literal('generate_embeddings'),
      Type.Literal('delete'),
      // Manual classification
      Type.Literal('classify'),
    ],
    { description: 'Action to perform' }
  ),

  // Template fields
  entity_id: Type.Optional(
    Type.Number({
      description: '[create/list] Entity ID to scope classifiers (global if omitted)',
    })
  ),
  watcher_id: Type.Optional(
    Type.Number({
      description: '[create] Watcher ID (required — classifiers must belong to a watcher)',
    })
  ),
  classifier_id: Type.Optional(
    Type.Number({
      description: '[generate_embeddings/delete] Classifier ID',
    })
  ),
  slug: Type.Optional(
    Type.String({
      description: '[create] Unique identifier (e.g., "sentiment", "quality")',
    })
  ),
  name: Type.Optional(Type.String({ description: '[create] Display name' })),
  description: Type.Optional(Type.String({ description: '[create] Classifier description' })),
  attribute_key: Type.Optional(
    Type.String({
      description: '[create] Key in content classifications (e.g., "sentiment")',
    })
  ),
  attribute_values: Type.Optional(
    Type.Any({
      description:
        '[create] Attribute values with descriptions, examples, and optional embeddings.',
    })
  ),
  min_similarity: Type.Optional(
    Type.Number({
      description: '[create] Minimum similarity threshold (default: 0.7)',
    })
  ),
  fallback_value: Type.Optional(
    Type.Any({
      description: '[create] Fallback value if no match (default: null)',
    })
  ),
  created_by: Type.Optional(Type.String({ description: '[create] Creator identifier' })),
  status: Type.Optional(
    Type.String({ description: '[list] Filter by status (active or deprecated)' })
  ),
  force_regenerate: Type.Optional(
    Type.Boolean({
      description: '[generate_embeddings] Force regenerate existing embeddings (default: false)',
    })
  ),

  // Manual classification fields
  content_id: Type.Optional(
    Type.Number({ description: '[classify] Content ID to update (single mode)' })
  ),
  classifications: Type.Optional(
    Type.Array(
      Type.Object({
        content_id: Type.Number({ description: 'Content ID' }),
        value: Type.Union([Type.String(), Type.Null()], {
          description: 'Classification value, or null to unset',
        }),
        reasoning: Type.Optional(
          Type.String({ description: 'Reasoning/justification for this classification' })
        ),
      }),
      { description: '[classify] Array of classifications to update (batch mode)' }
    )
  ),
  classifier_slug: Type.Optional(
    Type.String({
      description: '[classify] Classifier slug (e.g., "sentiment", "bug-severity")',
    })
  ),
  value: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: '[classify] Classification value for single update, or null to unset',
    })
  ),
  source: Type.Optional(
    Type.Union([Type.Literal('llm'), Type.Literal('user')], {
      description:
        '[classify] Classification source: "llm" (AI-generated) or "user" (manual). Defaults to "user".',
    })
  ),
  reasoning: Type.Optional(
    Type.String({
      description: '[classify] Reasoning/justification for the classification(s)',
    })
  ),
});

type ManageClassifiersArgs = Static<typeof ManageClassifiersSchema>;

type ManageClassifiersResult = {
  success: boolean;
  action: string;
  message?: string;
  data?: any;
};

// ============================================
// Helpers
// ============================================

async function hydrateAttributeEmbeddings(
  attributeValues: Record<
    string,
    { description: string; examples: string[]; embedding?: number[] | null }
  >,
  env: Env,
  options: { forceRegenerate?: boolean } = {}
): Promise<{
  attributeValues: Record<
    string,
    { description: string; examples: string[]; embedding?: number[] }
  >;
  generatedCount: number;
}> {
  const updated: Record<string, { description: string; examples: string[]; embedding?: number[] }> =
    {};
  const valuesToEmbed: string[] = [];

  for (const [value, config] of Object.entries(attributeValues)) {
    const hasEmbedding = isValidEmbedding(config.embedding ?? null);
    if (!hasEmbedding || options.forceRegenerate) {
      valuesToEmbed.push(value);
    }
    updated[value] = {
      description: config.description,
      examples: config.examples,
      embedding: hasEmbedding ? (config.embedding as number[]) : undefined,
    };
  }

  if (valuesToEmbed.length > 0) {
    const embeddings = await generateEmbeddingsViaService(valuesToEmbed, env);
    valuesToEmbed.forEach((value, index) => {
      updated[value] = { ...updated[value], embedding: embeddings[index] };
    });
  }

  return { attributeValues: updated, generatedCount: valuesToEmbed.length };
}

function stripEmbeddingsFromAttributeValues(
  attributeValues: unknown
): Record<string, { description: string; examples: string[] }> | null {
  if (!attributeValues) return null;
  const parsed =
    typeof attributeValues === 'string' ? JSON.parse(attributeValues) : attributeValues;
  if (typeof parsed !== 'object' || parsed === null) return null;

  const stripped: Record<string, { description: string; examples: string[] }> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, any>)) {
    if (value && typeof value === 'object') {
      const { embedding, ...rest } = value;
      stripped[key] = rest;
    } else {
      stripped[key] = value;
    }
  }
  return stripped;
}

// ============================================
// Main Function (Action Router)
// ============================================

export const manageClassifiers = withValidatedArgs(
  'manage_classifiers',
  ManageClassifiersSchema,
  defineFlatActionTool<ManageClassifiersArgs, ManageClassifiersResult>('manage_classifiers', {
    create: flatAction((args, ctx, env) => handleCreate(args, env, ctx)),
    list: flatAction(handleList),
    generate_embeddings: flatAction((args, ctx, env) => handleGenerateEmbeddings(args, env, ctx)),
    delete: flatAction(handleDelete),
    classify: flatAction(handleClassify),
  })
);

// ============================================
// Template CRUD Handlers
// ============================================

async function handleCreate(
  args: ManageClassifiersArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageClassifiersResult> {
  const sql = getDb();

  if (!args.slug || !args.name || !args.attribute_key || !args.attribute_values) {
    return {
      success: false,
      action: 'create',
      message: 'Missing required fields: slug, name, attribute_key, attribute_values',
    };
  }

  if (!args.watcher_id) {
    return {
      success: false,
      action: 'create',
      message: 'Missing required field: watcher_id. Classifiers must be associated with a watcher.',
    };
  }

  const entityId = args.entity_id ?? null;

  const watcher = await sql`
    SELECT id FROM watchers
    WHERE id = ${args.watcher_id} AND organization_id = ${ctx.organizationId}
  `;
  if (watcher.length === 0) {
    return {
      success: false,
      action: 'create',
      message: `Watcher not found: ${args.watcher_id}`,
    };
  }

  if (entityId !== null) {
    const entity = await sql`
      SELECT id FROM entities
      WHERE id = ${entityId} AND organization_id = ${ctx.organizationId} AND deleted_at IS NULL
    `;
    if (entity.length === 0) {
      return {
        success: false,
        action: 'create',
        message: `Entity not found: ${entityId}`,
      };
    }
  }

  const existing = await sql`
    SELECT id, slug FROM classify_facet
    WHERE slug = ${args.slug} AND organization_id = ${ctx.organizationId}
  `;
  if (existing.length > 0) {
    return {
      success: false,
      action: 'create',
      message: `Classifier with slug '${args.slug}' already exists.`,
      data: { classifier_id: existing[0].id },
    };
  }

  // created_by has a FK to user(id) — fall back to ctx.userId, not a literal
  // string. Anonymous public reads can't reach this code path (the route is
  // admin-gated), so ctx.userId is non-null here.
  const createdBy = args.created_by ?? ctx.userId;
  // Config lives on the single classify_facet row now (no version table) — hydrate embeddings first,
  // then one insert carrying identity + config.
  const { attributeValues: withEmbeddings, generatedCount } = await hydrateAttributeEmbeddings(
    args.attribute_values,
    env
  );

  const classifierResult = await sql`
    INSERT INTO classify_facet (
      organization_id, slug, name, description, attribute_key, status, created_by,
      entity_id, entity_ids, watcher_id, attribute_values, min_similarity, fallback_value
    ) VALUES (
      ${ctx.organizationId},
      ${args.slug}, ${args.name}, ${args.description || null}, ${args.attribute_key},
      'active', ${createdBy}, ${entityId},
      CASE WHEN ${entityId}::bigint IS NULL THEN ARRAY[]::bigint[] ELSE ARRAY[${entityId}]::bigint[] END,
      ${args.watcher_id}, ${sql.json(withEmbeddings)}, ${args.min_similarity ?? 0.7}, ${args.fallback_value ?? null}
    )
    RETURNING id, slug, name, attribute_key, entity_id, entity_ids, watcher_id
  `;
  const classifier = classifierResult[0];

  return {
    success: true,
    action: 'create',
    message:
      generatedCount > 0
        ? `Classifier '${args.slug}' created successfully (generated ${generatedCount} embeddings)`
        : `Classifier '${args.slug}' created successfully`,
    data: { classifier_id: classifier.id, slug: classifier.slug, version: 1 },
  };
}

async function handleList(
  args: ManageClassifiersArgs,
  ctx: ToolContext
): Promise<ManageClassifiersResult> {
  const sql = getDb();
  const filterEntityId = args.entity_id ?? null;
  const statusFilter = args.status ?? null;

  const conditions: string[] = ['fc.watcher_id IS NOT NULL', 'fc.organization_id = $1'];
  const params: unknown[] = [ctx.organizationId];
  let paramIdx = 2;

  if (statusFilter) {
    conditions.push(`fc.status = $${paramIdx++}`);
    params.push(statusFilter);
  }

  if (filterEntityId !== null) {
    conditions.push(`$${paramIdx++} = ANY(fc.entity_ids)`);
    params.push(filterEntityId);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const classifiers = await sql.unsafe(
    `SELECT
      fc.id, fc.slug, fc.name, fc.description, fc.attribute_key, fc.entity_ids,
      et.slug AS entity_type, fc.status, fc.created_at, fc.updated_at,
      fc.min_similarity, fc.fallback_value, fc.attribute_values,
      fc.watcher_id,
      w.name as watcher_name,
      CASE
        WHEN fc.entity_ids IS NULL OR cardinality(fc.entity_ids) = 0 THEN 'global'
        WHEN e.parent_id IS NULL THEN 'root'
        ELSE 'child'
      END as scope
    FROM classify_facet fc
    LEFT JOIN entities e ON e.id = ANY(fc.entity_ids)
    LEFT JOIN entity_types et ON et.id = e.entity_type_id
    LEFT JOIN watchers w ON fc.watcher_id = w.id
    ${whereClause}
    ORDER BY
      CASE WHEN fc.entity_ids IS NULL OR cardinality(fc.entity_ids) = 0 THEN 0 WHEN e.parent_id IS NULL THEN 1 ELSE 2 END,
      fc.watcher_id NULLS LAST,
      fc.created_at DESC`,
    params
  );

  const result = classifiers.map((row) => ({
    ...row,
    attribute_values: stripEmbeddingsFromAttributeValues(row.attribute_values),
  }));

  return {
    success: true,
    action: 'list',
    message: `Found ${result.length} classifiers`,
    data: { classifiers: result },
  };
}

async function handleGenerateEmbeddings(
  args: ManageClassifiersArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageClassifiersResult> {
  const sql = getDb();
  if (!args.classifier_id) {
    return {
      success: false,
      action: 'generate_embeddings',
      message: 'Missing required field: classifier_id',
    };
  }

  const facet = await sql`
    SELECT cf.attribute_values
    FROM classify_facet cf
    WHERE cf.id = ${args.classifier_id}
      AND cf.status = 'active'
      AND cf.organization_id = ${ctx.organizationId}
  `;
  if (facet.length === 0) {
    return {
      success: false,
      action: 'generate_embeddings',
      message: `No active classifier found for ${args.classifier_id}`,
    };
  }

  const current = facet[0];
  const attributeValues = current.attribute_values as Record<string, any>;
  const { attributeValues: updatedValues, generatedCount } = await hydrateAttributeEmbeddings(
    attributeValues,
    env,
    { forceRegenerate: args.force_regenerate }
  );

  // Config + embeddings live on the single classify_facet row now.
  if (generatedCount > 0 || args.force_regenerate) {
    await sql`UPDATE classify_facet SET attribute_values = ${sql.json(updatedValues)}, updated_at = now() WHERE id = ${args.classifier_id}`;
  }

  return {
    success: true,
    action: 'generate_embeddings',
    message:
      generatedCount > 0
        ? `Generated ${generatedCount} embeddings`
        : 'All attribute values already have embeddings',
    data: {
      classifier_id: args.classifier_id,
      generated_embeddings: generatedCount,
      attribute_count: Object.keys(updatedValues).length,
    },
  };
}

async function handleDelete(
  args: ManageClassifiersArgs,
  ctx: ToolContext
): Promise<ManageClassifiersResult> {
  const sql = getDb();
  if (!args.classifier_id) {
    return { success: false, action: 'delete', message: 'Missing required field: classifier_id' };
  }

  const result = await sql`
    UPDATE classify_facet
    SET status = 'deprecated', updated_at = current_timestamp
    WHERE id = ${args.classifier_id} AND organization_id = ${ctx.organizationId}
    RETURNING id
  `;
  if (result.length === 0) {
    return {
      success: false,
      action: 'delete',
      message: `Classifier not found: ${args.classifier_id}`,
    };
  }

  return {
    success: true,
    action: 'delete',
    message: 'Classifier archived (status set to deprecated)',
    data: { classifier_id: args.classifier_id },
  };
}

// ============================================
// Manual Classification Handler
// ============================================

async function handleClassify(
  args: ManageClassifiersArgs,
  ctx: ToolContext
): Promise<ManageClassifiersResult> {
  const sql = getDb();

  try {
    const isSingleMode = args.content_id !== undefined;
    const isBatchMode = args.classifications !== undefined;

    if (isSingleMode === isBatchMode) {
      return {
        success: false,
        action: 'classify',
        message:
          'Must provide either content_id (single mode) or classifications array (batch mode), not both',
      };
    }

    if (!args.classifier_slug) {
      return { success: false, action: 'classify', message: 'classifier_slug is required' };
    }

    const classifierResult = (await sql`
      SELECT cf.id as classifier_id, cf.attribute_key
      FROM classify_facet cf
      WHERE cf.slug = ${args.classifier_slug}
        AND cf.status = 'active'
        AND cf.organization_id = ${ctx.organizationId}
    `) as unknown as Array<{ classifier_id: number; attribute_key: string }>;

    if (classifierResult.length === 0) {
      return {
        success: false,
        action: 'classify',
        message: `Classifier not found or inactive: ${args.classifier_slug}`,
      };
    }

    const classifier = classifierResult[0];
    const source = args.source || 'user';

    if (isSingleMode) {
      if (args.content_id === undefined)
        return { success: false, action: 'classify', message: 'content_id is required' };
      if (args.value === undefined)
        return { success: false, action: 'classify', message: 'value is required' };

      const result = await updateSingleClassification(
        sql,
        ctx.organizationId,
        args.content_id,
        classifier,
        args.value,
        source,
        args.reasoning
      );
      return {
        success: result.success,
        action: 'classify',
        message: result.message,
        data: {
          updated: result.success ? 1 : 0,
          failed: result.success ? 0 : 1,
          details: [
            { content_id: args.content_id, success: result.success, error: result.message },
          ],
        },
      };
    }

    if (isBatchMode && args.classifications) {
      const results = await Promise.allSettled(
        args.classifications.map((item) =>
          updateSingleClassification(
            sql,
            ctx.organizationId,
            item.content_id,
            classifier,
            item.value,
            source,
            item.reasoning || args.reasoning
          )
        )
      );

      const details = results.map((result, index) => {
        const item = args.classifications![index];
        if (result.status === 'fulfilled') {
          const value = result.value as { success: boolean; message?: string };
          return {
            content_id: item.content_id,
            success: value.success,
            error: value.success ? undefined : value.message,
          };
        }
        return {
          content_id: item.content_id,
          success: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        };
      });

      const updated = details.filter((d) => d.success).length;
      const failed = details.filter((d) => !d.success).length;

      logger.info(
        {
          classifier_slug: args.classifier_slug,
          source,
          total: args.classifications.length,
          updated,
          failed,
        },
        'Batch classification update completed'
      );

      return {
        success: true,
        action: 'classify',
        message: `Updated ${updated} classification(s), ${failed} failed`,
        data: { updated, failed, details },
      };
    }

    return { success: false, action: 'classify', message: 'Invalid input mode' };
  } catch (error) {
    logger.error({ error, args }, 'Failed to update content classification');
    return {
      success: false,
      action: 'classify',
      message: error instanceof Error ? error.message : 'Failed to update classification',
    };
  }
}

async function updateSingleClassification(
  sql: DbClient,
  organizationId: string,
  contentId: number,
  classifier: { classifier_id: number; attribute_key: string },
  value: string | null,
  source: 'llm' | 'user',
  reasoning?: string
): Promise<{ success: boolean; message?: string }> {
  const contentCheck = await sql`
    SELECT id FROM events
    WHERE id = ${contentId} AND organization_id = ${organizationId}
  `;
  if (contentCheck.length === 0) {
    return { success: false, message: `Content not found: ${contentId}` };
  }

  const existingClassification = await sql`
    SELECT confidences FROM event_classifications
    WHERE event_id = ${contentId} AND classifier_id = ${classifier.classifier_id} AND source = 'embedding'
  `;

  let confidences: Record<string, number> = {};
  if (existingClassification.length > 0) {
    const existing = existingClassification[0].confidences as Record<string, number> | null;
    if (existing && typeof existing === 'object') confidences = { ...existing };
  }
  if (value) confidences[value] = 1.0;

  // Format as PostgreSQL text array literal — postgres.js with fetch_types:false can't serialize JS arrays
  const valuesLiteral = value ? `{${value}}` : '{}';

  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM event_classifications
      WHERE event_id = ${contentId} AND classifier_id = ${classifier.classifier_id} AND source = ${source} AND watcher_id IS NULL
    `;
    await tx`
      INSERT INTO event_classifications (event_id, classifier_id, watcher_id, window_id, "values", confidences, source, is_manual, reasoning)
      VALUES (${contentId}, ${classifier.classifier_id}, NULL, NULL, ${valuesLiteral}::text[], ${sql.json(confidences)}, ${source}, true, ${reasoning || null})
    `;
  });

  return { success: true };
}
