/**
 * Tool: query_entity_type
 *
 * Read the rows of a DERIVED entity type by slug. This is the trusted entry point
 * for derived-entity reads (pi P0): the caller names only a slug it is allowed to
 * read — never raw SQL or a connection. The server resolves the type's stored
 * `backing_sql` (+ `backing_source`) and dispatches:
 *   - backing_source set  → execute LIVE against that connection's external DB
 *                           (read-only, no copy) via executeExternalSource
 *   - backing_source null → run the stored SQL through the org-scoped query_sql
 *                           path (today's internal behavior)
 *
 * The client can never pass `{ sql, connection }`, so it can neither run arbitrary
 * SQL nor point a query at an arbitrary database/connection.
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb } from '../../db/client';
import { executeExternalSource } from '../../utils/execute-external-source';
import logger from '../../utils/logger';
import type { ToolContext } from '../registry';
import { querySql } from './query_sql';

export const QueryEntityTypeSchema = Type.Object({
  slug: Type.String({
    description: 'Slug of a DERIVED (view-backed) entity type to read its rows.',
    minLength: 1,
  }),
  sort_by: Type.Optional(
    Type.String({ description: 'Column to sort by. Omit to return rows unordered.' })
  ),
  sort_order: Type.Optional(
    Type.Union([Type.Literal('asc'), Type.Literal('desc')], {
      description: 'Sort direction. Default: asc.',
    })
  ),
  limit: Type.Optional(
    Type.Number({ description: 'Rows per page (1–500). Default: 50.', minimum: 1, maximum: 500 })
  ),
  offset: Type.Optional(
    Type.Number({ description: 'Row offset for pagination. Default: 0.', minimum: 0 })
  ),
  search_term: Type.Optional(
    Type.String({ description: 'ILIKE search value (wrapped in %...% automatically).' })
  ),
  search_columns: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Columns to search across (required when search_term is set).',
    })
  ),
});

type QueryEntityTypeArgs = Static<typeof QueryEntityTypeSchema>;

interface QueryEntityTypeResult {
  rows: Record<string, unknown>[];
  columns: { name: string; type: string }[];
  total_count: number;
  has_more: boolean;
  /** Where the rows came from. */
  source: 'internal' | 'external';
  error?: string;
}

function errorResult(message: string, source: 'internal' | 'external' = 'internal'): QueryEntityTypeResult {
  return { rows: [], columns: [], total_count: 0, has_more: false, source, error: message };
}

export async function queryEntityType(
  args: QueryEntityTypeArgs,
  env: unknown,
  ctx: ToolContext
): Promise<QueryEntityTypeResult> {
  if (!args?.slug) return errorResult('slug is required.');

  const db = getDb();
  const rows = await db.unsafe(
    `SELECT et.backing_sql, et.backing_source, et.organization_id
     FROM entity_types et
     LEFT JOIN organization o ON o.id = et.organization_id
     WHERE et.slug = $1
       AND et.deleted_at IS NULL
       AND (et.organization_id = $2 OR o.visibility = 'public')
     ORDER BY (et.organization_id = $2) DESC, et.id ASC
     LIMIT 1`,
    [args.slug, ctx.organizationId]
  );

  if (rows.length === 0) return errorResult(`Entity type '${args.slug}' not found.`);

  const row = rows[0] as {
    backing_sql: string | null;
    backing_source: string | null;
    organization_id: string | null;
  };

  if (!row.backing_sql) {
    return errorResult(
      `Entity type '${args.slug}' is not derived (it has no backing view). Use query_sql or list_entities for stored types.`
    );
  }

  // External-backed: run live against the bound connection's database.
  if (row.backing_source) {
    // Reading an external-backed type resolves its connection in the CALLER's org;
    // a public type owned by another org must not be read here (its connection
    // lives in that org). Require own-org for external reads.
    if (row.organization_id !== ctx.organizationId) {
      return errorResult(
        `Entity type '${args.slug}' is external-backed and can only be read within its owning organization.`,
        'external'
      );
    }
    try {
      const r = await executeExternalSource(
        { organizationId: ctx.organizationId, connectionSlug: row.backing_source },
        row.backing_sql,
        {
          sortBy: args.sort_by,
          sortOrder: args.sort_order,
          limit: args.limit,
          offset: args.offset,
          searchTerm: args.search_term,
          searchColumns: args.search_columns,
        }
      );
      return { ...r, source: 'external' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ slug: args.slug, error: message }, 'query_entity_type external read failed');
      return errorResult(message, 'external');
    }
  }

  // Internal-backed: run the STORED backing_sql through the org-scoped query_sql
  // path (org-scoping CTEs, admin-table gating, pagination, search). The client
  // never supplies this SQL — it comes from the entity type's definition.
  const internal = await querySql(
    {
      sql: row.backing_sql,
      sort_by: args.sort_by,
      sort_order: args.sort_order,
      limit: args.limit,
      offset: args.offset,
      search_term: args.search_term,
      search_columns: args.search_columns,
    },
    env,
    ctx
  );

  return {
    rows: internal.rows,
    columns: internal.columns,
    total_count: internal.total_count,
    has_more: internal.has_more,
    source: 'internal',
    ...(internal.error ? { error: internal.error } : {}),
  };
}
