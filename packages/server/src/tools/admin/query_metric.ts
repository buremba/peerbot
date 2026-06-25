/**
 * query_metric — run a DECLARED, governed metric and return its rows.
 *
 * Prefer this over `query_sql` whenever a declared measure answers the question:
 * the metric layer enforces the resolution, dedupe, segment, and aggregation so
 * the numbers are consistent. Discover what exists with `list_metrics`; fall
 * back to `query_sql` only when no measure covers the ask.
 *
 * Thin wrapper over runMetric (compile → org-scope → read-only execute) — the
 * same path a federated warehouse metric flows through.
 */

import { type Static, Type } from '@sinclair/typebox';
import type { Env } from '../../index';
import { runMetric } from '../../metrics/run-metric';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';

export const QueryMetricSchema = Type.Object({
  entity_type: Type.String({
    description: 'Entity type slug that declares the metric (e.g. "company"). See list_metrics.',
  }),
  measure: Type.String({
    description: 'Declared measure name on that entity type (e.g. "spend").',
  }),
  by: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Dimension names to group by (e.g. ["currency","month"]). Omit for a grand total per entity.',
    }),
  ),
  segment: Type.Optional(
    Type.String({ description: 'An extra declared segment (named population filter) to AND in.' }),
  ),
  entity_id: Type.Optional(
    Type.Number({ description: 'Restrict to a single entity (entities.id); omit for all entities of the type.' }),
  ),
});

async function queryMetricImpl(
  args: Static<typeof QueryMetricSchema>,
  _env: Env,
  ctx: ToolContext,
): Promise<{ rows: Record<string, unknown>[]; row_count: number }> {
  if (!ctx.organizationId) {
    throw new Error('query_metric requires a bound organization');
  }
  const rows = await runMetric({
    organizationId: ctx.organizationId,
    entityType: args.entity_type,
    measure: args.measure,
    by: args.by,
    segment: args.segment,
    entityId: args.entity_id,
    userId: ctx.userId,
  });
  return { rows, row_count: rows.length };
}

export const queryMetric = withValidatedArgs('query_metric', QueryMetricSchema, queryMetricImpl);
