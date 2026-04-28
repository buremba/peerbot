/**
 * Execute SQL data sources defined in a JSON view template.
 *
 * Queries run against a virtual schema of org-scoped CTEs. Table references
 * in user queries are resolved to:
 *   - Core tables (entities, events, connections, watchers, event_classifications)
 *     → CTE with organization_id filter
 *   - Any other name → treated as an entity_type slug, filtered from entities
 *
 * Security:
 *   - SQL parsed via node-sql-parser to extract ALL table references
 *   - Schema-qualified references (e.g. public.user) rejected outright
 *   - Every table ref gets a CTE with org-scoping baked in
 *   - READ ONLY transaction + timeout via sql.begin()
 *   - FORBIDDEN_OPS regex as additional safeguard
 */

import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const { Parser } = _require('node-sql-parser');

import type { DbClient } from '../db/client';
import logger from './logger';
import {
  buildColumnList,
  type ColumnDef,
  QUERYABLE_TABLE_NAMES,
  validateTableQuery,
} from './table-schema';

/** A named SQL data source: { name, query } or keyed as Record<string, { query }> */
export type DataSourceInput =
  | Record<string, { query: string }>
  | Array<{ name: string; query: string }>;

export interface DataSourceContext {
  organizationId: string;
  /** When set, events CTE filters to events belonging to any of these entities */
  entityIds?: number[];
  query?: Record<string, string>;
  /** When set, events CTE is filtered to this time window (incremental mode) */
  windowStart?: string;
  windowEnd?: string;
}

/** Operations that bypass READ ONLY transactions or have side-effects. */
const FORBIDDEN_OPS = /\b(COPY|IMPORT|PRAGMA|CALL)\b/i;
const MAX_ROWS = 1000;
const QUERY_TIMEOUT_MS = 5000;

const sqlParser = new Parser();

// ============================================
// SQL Parsing
// ============================================

/**
 * Extract all table references from a SQL query.
 * Rejects schema-qualified references (e.g. public.users, pg_catalog.pg_roles).
 * Filters out user-defined CTE names so they aren't treated as virtual tables.
 */
function extractTableRefs(query: string): string[] {
  // Replace {{...}} placeholders with a literal so the parser doesn't choke
  const forParsing = query.replace(/\{\{\w+(?:\.\w+)?\}\}/g, '0');

  const tableList = sqlParser.tableList(forParsing, { database: 'PostgreSql' });

  // Extract user-defined CTE names to exclude
  const userCteNames = new Set<string>();
  try {
    const ast = sqlParser.astify(forParsing, { database: 'PostgreSql' });
    const astObj = (Array.isArray(ast) ? ast[0] : ast) as unknown as Record<string, unknown>;
    const withClause = astObj?.with as Array<{ name: { value: string } }> | undefined;
    if (withClause) {
      for (const cte of withClause) {
        if (cte.name?.value) userCteNames.add(cte.name.value.toLowerCase());
      }
    }
  } catch {
    // If AST parsing fails, we still have tableList — just can't filter CTEs
  }

  const tables = new Set<string>();
  for (const ref of tableList) {
    // Format: "operation::schema::table"
    const parts = ref.split('::');
    const schema = parts[1];
    const table = parts[2];

    if (schema && schema !== 'null' && schema !== '') {
      throw new Error(`Schema-qualified table references are not allowed: ${schema}.${table}`);
    }

    if (table) {
      const lower = table.toLowerCase();
      if (!userCteNames.has(lower)) {
        tables.add(lower);
      }
    }
  }

  return Array.from(tables);
}

// ============================================
// Validate + Scope (shared by query_sql and reaction SDK)
// ============================================

/**
 * Validate a user SQL query and produce an org-scoped version.
 *
 * Validation pipeline:
 *   1. validateTableQuery() — @polyglot-sql/sdk parses the SQL and checks
 *      all table/column references against the allowlisted schema
 *   2. extractTableRefs() — node-sql-parser AST extracts table names
 *   3. buildScopedQuery() — wraps each table reference in an org-scoped CTE
 *
 * Throws on any validation failure.
 */
export function validateAndScopeQuery(
  rawSql: string,
  organizationId: string,
  options?: { safeColumns?: Map<string, ColumnDef[]> }
): { sql: string; params: unknown[] } {
  const trimmed = rawSql.trim();
  if (!trimmed) {
    throw new Error('SQL query is required');
  }

  // Schema-level validation via SQL parser (rejects unknown tables/columns, mutations, etc.)
  const validation = validateTableQuery(trimmed);
  if (!validation.valid) {
    throw new Error(validation.errors.join('; '));
  }

  // AST-based table extraction
  const tableRefs = extractTableRefs(trimmed);
  const unknown = tableRefs.filter((t) => !QUERYABLE_TABLE_NAMES.has(t));
  if (unknown.length > 0) {
    throw new Error(`Unknown table(s): ${unknown.join(', ')}`);
  }

  return buildScopedQuery(trimmed, tableRefs, { organizationId }, options);
}

// ============================================
// CTE Building
// ============================================

/**
 * Build org-scoped CTEs for each referenced table and combine with the user query.
 *
 * Core tables get predefined scoping patterns. Unknown table names are
 * treated as entity_type slugs (filtered from the entities table).
 */
function buildScopedQuery(
  userQuery: string,
  tableRefs: string[],
  context: DataSourceContext,
  options?: { safeColumns?: Map<string, ColumnDef[]> }
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let idx = 0;

  // $1 = organizationId
  idx++;
  params.push(context.organizationId);
  const orgP = `$${idx}`;

  // {{entityId}} substitution — only allocates a param when the query uses it
  let processedQuery = userQuery;
  if (context.entityIds && context.entityIds.length > 0) {
    let entityP: string | undefined;
    processedQuery = processedQuery.replace(/\{\{entityId\}\}/g, () => {
      if (!entityP) {
        idx++;
        params.push(context.entityIds![0]);
        entityP = `$${idx}::bigint`;
      }
      return entityP;
    });
  }

  // Remove {{organizationId}} — scoping is now automatic via CTEs
  processedQuery = processedQuery.replace(/\{\{organizationId\}\}/g, orgP);

  // Substitute {{query.paramName}} with parameterized values (NULL if missing).
  // Cast to ::text so PostgreSQL can determine the type even when the value is NULL.
  processedQuery = processedQuery.replace(/\{\{query\.(\w+)\}\}/g, (_match, paramName: string) => {
    idx++;
    params.push(context.query?.[paramName] ?? null);
    return `$${idx}::text`;
  });

  // Reject any remaining unknown placeholders
  const remaining = processedQuery.match(/\{\{(\w+(?:\.\w+)?)\}\}/g);
  if (remaining) {
    throw new Error(`Unknown context variables: ${remaining.join(', ')}`);
  }

  // Reject user-provided positional parameters (would conflict with ours)
  if (/\$\d+/.test(userQuery)) {
    throw new Error('Positional parameters ($1, $2, ...) are not allowed in data source queries');
  }

  // Build CTEs
  const ctes: string[] = [];

  // When safeColumns is provided, emit explicit column lists instead of SELECT *
  const sc = options?.safeColumns;
  const sel = (table: string, alias?: string) => {
    const defs = sc?.get(table);
    if (!defs) return alias ? `${alias}.*` : '*';
    return buildColumnList(defs, alias);
  };

  // Build the SELECT list for the entities CTE, where entity_type is now a
  // derived column from a JOIN to entity_types (et.slug AS entity_type).
  const selEntitiesJoined = (entityAlias: string, typeAlias: string): string => {
    const defs = sc?.get('entities');
    if (!defs) return `${entityAlias}.*, ${typeAlias}.slug AS entity_type`;
    return defs
      .map((c) => {
        if (c.name === 'entity_type') return `${typeAlias}.slug AS "entity_type"`;
        if (c.expr) {
          const prefixed = c.expr.replace(/^(\w+)/, `${entityAlias}.$1`);
          return `${prefixed} as "${c.name}"`;
        }
        return `${entityAlias}."${c.name}"`;
      })
      .join(', ');
  };

  for (const table of tableRefs) {
    // Escape double quotes in table name for safe identifier quoting
    const safeName = table.replace(/"/g, '""');

    if (table === 'entities') {
      ctes.push(
        `"${safeName}" AS (SELECT ${selEntitiesJoined('e', 'et')} ` +
          `FROM public.entities e ` +
          `JOIN public.entity_types et ON et.id = e.entity_type_id ` +
          `WHERE e.organization_id = ${orgP})`
      );
    } else if (table === 'events') {
      // Match buildOrgScopeWhere in content-search.ts: an event is in scope if
      // it was stamped to the caller's org directly, OR any of its entity_ids
      // belong to the caller's org, OR it came in through a connection in the
      // caller's org. Mirroring that here keeps query_sql consistent with
      // what search_knowledge/get_content surface.
      let eventsCte =
        `"${safeName}" AS (SELECT ${sel(table, 'ev')} FROM public.current_event_records ev ` +
        `WHERE (ev.organization_id = ${orgP} ` +
        'OR EXISTS (SELECT 1 FROM public.entities ent WHERE ent.id = ANY(ev.entity_ids) ' +
        `AND ent.organization_id = ${orgP}) ` +
        'OR EXISTS (SELECT 1 FROM public.connections con WHERE con.id = ev.connection_id ' +
        `AND con.organization_id = ${orgP}))`;

      // Entity scoping: filter events to the watcher's entities
      if (context.entityIds && context.entityIds.length > 0) {
        const placeholders = context.entityIds.map((id) => {
          idx++;
          params.push(id);
          return `$${idx}`;
        });
        eventsCte += ` AND ev.entity_ids && ARRAY[${placeholders.join(',')}]::bigint[]`;
      }

      // Time window scoping (incremental mode)
      if (context.windowStart && context.windowEnd) {
        idx++;
        params.push(context.windowStart);
        const windowStartP = `$${idx}`;
        idx++;
        params.push(context.windowEnd);
        const windowEndP = `$${idx}`;
        eventsCte += ` AND ev.occurred_at >= ${windowStartP}::timestamptz AND ev.occurred_at < ${windowEndP}::timestamptz`;
      }

      eventsCte += ')';
      ctes.push(eventsCte);
    } else if (table === 'connections') {
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table)} FROM public.connections WHERE organization_id = ${orgP})`
      );
    } else if (table === 'watchers') {
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'i')} FROM public.watchers i WHERE EXISTS (` +
          'SELECT 1 FROM public.entities ent WHERE ent.id = ANY(i.entity_ids) ' +
          `AND ent.organization_id = ${orgP}))`
      );
    } else if (table === 'event_classifications') {
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'ec')} FROM public.event_classifications ec WHERE EXISTS (` +
          'SELECT 1 FROM public.events ev ' +
          'JOIN public.entities ent ON ent.id = ANY(ev.entity_ids) ' +
          `WHERE ev.id = ec.event_id AND ent.organization_id = ${orgP}))`
      );
    } else if (table === 'watcher_versions') {
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'wv')} FROM public.watcher_versions wv ` +
          'JOIN public.watchers w ON w.id = wv.watcher_id WHERE EXISTS (' +
          'SELECT 1 FROM public.entities ent WHERE ent.id = ANY(w.entity_ids) ' +
          `AND ent.organization_id = ${orgP}))`
      );
    } else if (table === 'watcher_windows') {
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'ww')} FROM public.watcher_windows ww ` +
          'JOIN public.watchers w ON w.id = ww.watcher_id WHERE EXISTS (' +
          'SELECT 1 FROM public.entities ent WHERE ent.id = ANY(w.entity_ids) ' +
          `AND ent.organization_id = ${orgP}))`
      );
    } else if (table === 'oauth_clients') {
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table)} FROM public.oauth_clients WHERE organization_id = ${orgP})`
      );
    } else if (table === 'oauth_tokens') {
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table)} FROM public.oauth_tokens WHERE organization_id = ${orgP})`
      );
    } else if (table === 'user') {
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'u')} FROM public."user" u ` +
          `JOIN public.member m ON m."userId" = u.id ` +
          `WHERE m."organizationId" = ${orgP})`
      );
    } else if (table === 'feeds') {
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table)} FROM public.feeds WHERE organization_id = ${orgP})`
      );
    } else if (table === 'connector_definitions') {
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table)} FROM public.connector_definitions WHERE organization_id = ${orgP})`
      );
    } else if (table === 'entity_relationships') {
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table)} FROM public.entity_relationships WHERE organization_id = ${orgP} AND deleted_at IS NULL)`
      );
    } else if (table === 'entity_relationship_types') {
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table)} FROM public.entity_relationship_types WHERE organization_id = ${orgP})`
      );
    } else {
      // Treat as entity_type slug — uses entities columns
      idx++;
      params.push(table);
      ctes.push(
        `"${safeName}" AS (SELECT ${selEntitiesJoined('e', 'et')} ` +
          `FROM public.entities e ` +
          `JOIN public.entity_types et ON et.id = e.entity_type_id ` +
          `WHERE e.organization_id = ${orgP} AND et.slug = $${idx})`
      );
    }
  }

  // Combine CTEs with user query
  if (ctes.length === 0) return { sql: processedQuery, params };

  const cteStr = `WITH ${ctes.join(',\n')}`;
  const trimmed = processedQuery.trim();

  // If user query starts with WITH, merge CTEs (no duplicate WITH keyword)
  const finalSql = /^WITH\b/i.test(trimmed)
    ? `${cteStr},\n${trimmed.replace(/^WITH\s+/i, '')}`
    : `${cteStr}\n${trimmed}`;

  return { sql: finalSql, params };
}

// ============================================
// Validation
// ============================================

/**
 * Validate a data source query.
 * Checks: SELECT/WITH prefix, forbidden ops, SQL syntax, schema-qualified refs.
 * When `parse` is true (save-time), also validates syntax and table refs.
 */
export function validateDataSourceQuery(name: string, query: string, parse = false): void {
  const trimmed = query.trim();
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new Error(`Data source '${name}': query must start with SELECT or WITH`);
  }
  if (FORBIDDEN_OPS.test(trimmed)) {
    throw new Error(`Data source '${name}': query contains forbidden operations`);
  }
  if (parse) {
    try {
      const forParsing = trimmed.replace(/\{\{\w+(?:\.\w+)?\}\}/g, '0');
      sqlParser.astify(forParsing, { database: 'PostgreSql' });
      extractTableRefs(trimmed);
    } catch (err) {
      throw new Error(`Data source '${name}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Normalize DataSourceInput to entries array */
function toEntries(input: DataSourceInput): Array<[string, string]> {
  if (Array.isArray(input)) {
    return input.map((s) => [s.name, s.query]);
  }
  return Object.entries(input).map(([name, { query }]) => [name, query]);
}

// ============================================
// Execution
// ============================================

/**
 * Execute all data sources and return a map of name → rows.
 *
 * Each query runs in a proper sql.begin() transaction (connection-pinned)
 * with READ ONLY mode and a per-query timeout. Errors are caught per-source
 * so one failure doesn't break the rest.
 */
export async function executeDataSources(
  dataSources: DataSourceInput,
  context: DataSourceContext,
  sql: DbClient,
  options?: {
    /** Transform the scoped SQL before execution (e.g. wrap for ID-only extraction). */
    wrapQuery?: (scopedSql: string) => string;
  }
): Promise<Record<string, unknown[]>> {
  const results: Record<string, unknown[]> = {};
  const entries = toEntries(dataSources);
  if (entries.length === 0) return results;

  await Promise.all(
    entries.map(async ([name, query]) => {
      try {
        validateDataSourceQuery(name, query);
        const tableRefs = extractTableRefs(query);
        let { sql: scopedQuery, params } = buildScopedQuery(query, tableRefs, context);

        // Validate param count matches placeholders in scoped query
        const placeholderMatches = scopedQuery.match(/\$(\d+)/g);
        if (placeholderMatches) {
          const maxPlaceholder = Math.max(
            ...placeholderMatches.map((p: string) => parseInt(p.slice(1), 10))
          );
          if (maxPlaceholder > params.length) {
            throw new Error(
              `Source '${name}': query references $${maxPlaceholder} but only ${params.length} params provided`
            );
          }
        }

        if (options?.wrapQuery) {
          scopedQuery = options.wrapQuery(scopedQuery);
        }

        const rows = await sql.begin(async (tx) => {
          await tx.unsafe('SET TRANSACTION READ ONLY');
          await tx.unsafe(`SET LOCAL statement_timeout = '${QUERY_TIMEOUT_MS}'`);
          return tx.unsafe(scopedQuery, params);
        });

        results[name] = Array.isArray(rows) ? rows.slice(0, MAX_ROWS) : [];
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err), dataSource: name },
          'Data source execution failed'
        );
        results[name] = [];
      }
    })
  );

  return results;
}
