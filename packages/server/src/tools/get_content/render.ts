/**
 * Tool: read_knowledge — turning raw query rows into the canonical
 * ContentItem shape (excerpt highlighting, client/parent-context resolution,
 * row mapping).
 */

import type { ContentItem } from '@lobu/connector-sdk';
import { parseJsonObject } from '@lobu/core';
import { type DbClient, parsePgNumberArray, pgTextArray } from '../../db/client';
import logger from '../../utils/logger';
import { buildEventPermalink } from '../../utils/url-builder';
import type { ContentRow } from './types';
import { parseRecordArray, toNumberOrUndefined } from './types';

/**
 * Fetch excerpts for evidence highlighting when filtering by a single
 * classification value.
 */
export async function fetchClassificationExcerpts(
  sql: DbClient,
  classificationFilters: Array<{ classifier_slug: string; value: string }> | undefined,
  rawContent: ContentRow[]
): Promise<Map<number, string>> {
  const excerptsMap = new Map<number, string>();
  if (classificationFilters?.length === 1 && rawContent.length > 0) {
    const { classifier_slug: classifierSlug, value: filterValue } = classificationFilters[0];
    const contentIds = rawContent.map((f) => f.id);
    const contentIdPlaceholders = contentIds.map((_, i) => `$${i + 3}`).join(',');
    const excerptsResult = await sql.unsafe(
      `
      SELECT
        cc.event_id,
        cc.excerpts::jsonb->>$1 as excerpt
      FROM event_classifications cc
      JOIN classify_facet cl ON cc.classifier_id = cl.id
      WHERE cc.event_id IN (${contentIdPlaceholders})
        AND cl.slug = $2
        AND $1 = ANY(cc."values")
        AND cc.excerpts::jsonb ? $1
    `,
      [filterValue, classifierSlug, ...contentIds]
    );

    for (const row of excerptsResult as unknown as Array<{
      event_id: number;
      excerpt: string;
    }>) {
      if (row.excerpt) {
        excerptsMap.set(Number(row.event_id), row.excerpt);
      }
    }

    logger.debug(
      { classifierSlug, filterValue, excerptCount: excerptsMap.size },
      '[get_content] Fetched excerpts for evidence highlighting'
    );
  }
  return excerptsMap;
}

/**
 * Map raw query rows to the canonical content item shape used across the app,
 * batch-resolving client_name and parent_context first.
 */
export async function buildContentItems(opts: {
  sql: DbClient;
  rawContent: ContentRow[];
  organizationId: string;
  ownerSlug: string | null;
  baseUrl: string | undefined;
  excerptsMap: Map<number, string>;
}): Promise<ContentItem[]> {
  const { sql, rawContent, organizationId, ownerSlug, baseUrl, excerptsMap } = opts;

  // Batch-resolve client_name and parent_context in parallel — the two
  // queries are independent (one keys by event id, the other by origin_id)
  // and on a high-RTT DB the serial form pays the round-trip twice.
  const idsNeedingClientName = rawContent.filter((f) => !f.client_name).map((f) => f.id);
  const parentExternalIds = rawContent
    .filter(
      (f) => f.origin_parent_id && !rawContent.some((r) => r.origin_id === f.origin_parent_id)
    )
    .map((f) => f.origin_parent_id as string);
  const uniqueParentIds = [...new Set(parentExternalIds)];

  const [clientRows, parentRows] = await Promise.all([
    idsNeedingClientName.length > 0
      ? sql`
        SELECT e.id, oc.client_name
        FROM current_event_records e
        JOIN oauth_clients oc ON oc.id = e.client_id
        WHERE e.id = ANY(${`{${idsNeedingClientName.join(',')}}`}::bigint[])
          AND e.client_id IS NOT NULL
      `
      : Promise.resolve([] as Array<{ id: number; client_name: string }>),
    uniqueParentIds.length > 0
      ? sql`
        SELECT origin_id, author_name, title, payload_text, occurred_at, source_url, score
        FROM current_event_records
        WHERE origin_id = ANY(${pgTextArray(uniqueParentIds)}::text[])
          AND organization_id = ${organizationId}
        LIMIT ${uniqueParentIds.length}
      `
      : Promise.resolve([] as Array<Record<string, unknown>>),
  ]);

  const clientNameMap = new Map<number, string>();
  for (const row of clientRows) {
    clientNameMap.set(Number(row.id), String(row.client_name));
  }

  const parentContextMap = new Map<string, ContentItem['parent_context']>();
  for (const row of parentRows) {
    const text = String(row.payload_text ?? '');
    parentContextMap.set(String(row.origin_id), {
      author_name: String(row.author_name ?? ''),
      title: row.title ? String(row.title) : null,
      text_content: text.length > 200 ? `${text.slice(0, 200)}…` : text,
      occurred_at: String(row.occurred_at ?? ''),
      source_url: String(row.source_url ?? ''),
      score: Number(row.score) || 0,
    });
  }

  // Map to the canonical content item shape used across the app.
  const contentItems: ContentItem[] = rawContent.map((f) => {
    const metadata = parseJsonObject(f.metadata);
    const classifications = parseJsonObject(f.classifications);

    return {
      id: f.id,
      entity_ids: parsePgNumberArray(f.entity_ids),
      platform: f.platform,
      origin_id: f.origin_id ?? '',
      semantic_type: f.semantic_type ?? 'content',
      origin_type: f.origin_type ?? null,
      payload_type: f.payload_type ?? 'text',
      payload_text: f.payload_text ?? '',
      payload_data: parseJsonObject(f.payload_data),
      payload_template: f.payload_template ? parseJsonObject(f.payload_template) : null,
      attachments: parseRecordArray(f.attachments),
      author_name: f.author_name ?? null,
      client_name: f.client_name ?? clientNameMap.get(f.id) ?? null,
      title: f.title,
      text_content: f.payload_text ?? '',
      rating: (metadata.rating as string) || null,
      source_url: f.source_url ?? null,
      score: Number(f.score) || 0,
      metadata,
      classifications,
      created_at: f.created_at,
      occurred_at: f.occurred_at || f.created_at,
      content_date: f.occurred_at || f.created_at,
      excerpt: excerptsMap.get(f.id),
      similarity: toNumberOrUndefined(f.similarity),
      text_rank: toNumberOrUndefined(f.text_rank),
      combined_score: toNumberOrUndefined(f.combined_score),
      score_breakdown: f.score_breakdown as ContentItem['score_breakdown'],
      origin_parent_id: f.origin_parent_id || null,
      root_origin_id: f.root_origin_id || f.origin_id || String(f.id),
      depth: f.depth ?? 0,
      interaction_type: f.interaction_type ?? undefined,
      interaction_status: f.interaction_status ?? undefined,
      interaction_input_schema: f.interaction_input_schema
        ? parseJsonObject(f.interaction_input_schema)
        : undefined,
      interaction_input: f.interaction_input ? parseJsonObject(f.interaction_input) : undefined,
      interaction_output: f.interaction_output
        ? parseJsonObject(f.interaction_output)
        : undefined,
      interaction_error: f.interaction_error ?? undefined,
      supersedes_event_id: f.supersedes_event_id == null ? null : Number(f.supersedes_event_id),
      parent_context:
        parentContextMap.get(f.origin_parent_id as string) ??
        (f.parent_context as ContentItem['parent_context']) ??
        null,
      root_context: f.root_context as ContentItem['root_context'],
      permalink: ownerSlug ? buildEventPermalink(ownerSlug, f.id, baseUrl) : null,
    };
  });

  return contentItems;
}
