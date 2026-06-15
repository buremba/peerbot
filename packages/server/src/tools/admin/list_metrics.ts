/**
 * list_metrics — the metric catalog. Lists the DECLARED measures / dimensions /
 * segments per entity type (with their descriptions), so the agent can discover
 * what governed metrics exist and call `query_metric` instead of hand-writing
 * SQL. This is the "semantic-first" discovery step: search here, then
 * query_metric; only fall back to query_sql when nothing covers the ask.
 */

import { type Static, Type } from '@sinclair/typebox';
import type { EntityMetrics } from '@lobu/connector-sdk';
import { getDb } from '../../db/client';
import type { Env } from '../../index';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';

export const ListMetricsSchema = Type.Object({
  entity_type: Type.Optional(
    Type.String({ description: 'Filter to one entity type slug (e.g. "company").' }),
  ),
  q: Type.Optional(
    Type.String({
      description: 'Keyword filter (case-insensitive) over measure/dimension/segment names + descriptions.',
    }),
  ),
});

interface MetricCatalogEntry {
  entity_type: string;
  name: string | null;
  measures: Array<{
    name: string;
    agg: string;
    eventSet: string;
    description: string;
    tier?: string;
    owner?: string;
  }>;
  dimensions: Array<{ name: string; description: string }>;
  segments: Array<{ name: string; description: string }>;
}

async function listMetricsImpl(
  args: Static<typeof ListMetricsSchema>,
  _env: Env,
  ctx: ToolContext,
): Promise<{ entity_types: MetricCatalogEntry[] }> {
  if (!ctx.organizationId) {
    throw new Error('list_metrics requires a bound organization');
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT slug, name, metrics_config
    FROM entity_types
    WHERE organization_id = ${ctx.organizationId}
      AND deleted_at IS NULL
      AND metrics_config IS NOT NULL
      ${args.entity_type ? sql`AND slug = ${args.entity_type}` : sql``}
    ORDER BY slug
  `) as unknown as Array<{ slug: string; name: string | null; metrics_config: unknown }>;

  const needle = args.q?.toLowerCase();
  const matches = (...vals: (string | undefined)[]) =>
    !needle || vals.some((v) => v?.toLowerCase().includes(needle));

  const entity_types: MetricCatalogEntry[] = [];
  for (const row of rows) {
    const m = (row.metrics_config ?? {}) as EntityMetrics;
    const measures = Object.entries(m.measures ?? {})
      .filter(([name, def]) => matches(name, def.description))
      .map(([name, def]) => ({
        name,
        agg: def.agg,
        eventSet: def.eventSet,
        description: def.description,
        ...(def.tier ? { tier: def.tier } : {}),
        ...(def.owner ? { owner: def.owner } : {}),
      }));
    const dimensions = Object.entries(m.dimensions ?? {})
      .filter(([name, def]) => matches(name, def.description))
      .map(([name, def]) => ({ name, description: def.description }));
    const segments = Object.entries(m.segments ?? {})
      .filter(([name, def]) => matches(name, def.description))
      .map(([name, def]) => ({ name, description: def.description }));

    // With a keyword, only surface entity types that have a matching member.
    if (needle && measures.length === 0 && dimensions.length === 0 && segments.length === 0) {
      continue;
    }
    entity_types.push({ entity_type: row.slug, name: row.name, measures, dimensions, segments });
  }
  return { entity_types };
}

export const listMetrics = withValidatedArgs('list_metrics', ListMetricsSchema, listMetricsImpl);
