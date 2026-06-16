/**
 * runMetric — the shared metric execution path. Loads an entity type's declared
 * metrics_config, compiles the requested measure to SQL (compiler.ts), org-scopes
 * it via `validateAndScopeQuery` (which rewrites `events` → current_event_records
 * + scopes both tables), and runs it read-only.
 *
 * This is the single entry point a `query_metric` MCP tool will wrap, and the
 * same aggregation/execution path a federated warehouse metric flows through —
 * only the relation differs (compiled-over-events here vs a connector's view).
 */

import type { EntityMetrics } from "@lobu/connector-sdk";
import { getDb } from "../db/client";
import { validateAndScopeQuery } from "../utils/execute-data-sources";
import { compileMetricSql } from "./compiler";

interface RunMetricInput {
  organizationId: string;
  /** Entity type slug (e.g. "company"). */
  entityType: string;
  /** Declared measure name (e.g. "spend"). */
  measure: string;
  /** Dimension names to group by. */
  by?: string[];
  /** Extra segment name to AND in. */
  segment?: string;
  /** Restrict to one entity (entities.id). */
  entityId?: number;
}

export async function runMetric(input: RunMetricInput): Promise<Record<string, unknown>[]> {
  const sql = getDb();
  const found = await sql`
    SELECT id, metrics_config
    FROM entity_types
    WHERE slug = ${input.entityType}
      AND organization_id = ${input.organizationId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (found.length === 0) {
    throw new Error(`entity type "${input.entityType}" not found`);
  }
  const entityTypeId = Number(found[0].id);
  const metrics = (found[0].metrics_config ?? {}) as EntityMetrics;

  const rawSql = compileMetricSql({
    entityTypeId,
    metrics,
    measure: input.measure,
    by: input.by,
    segment: input.segment,
    entityId: input.entityId,
  });
  const scoped = validateAndScopeQuery(rawSql, input.organizationId);

  const rows = await sql.begin(async (tx: typeof sql) => {
    await tx`SET TRANSACTION READ ONLY`;
    return tx.unsafe(scoped.sql, scoped.params as unknown[]);
  });
  return rows as unknown as Record<string, unknown>[];
}
