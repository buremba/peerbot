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
 *   - SQL parsed via @polyglot-sql/sdk to extract ALL table references
 *   - Schema-qualified references (e.g. public.user) rejected outright
 *   - Every table ref gets a CTE with org-scoping baked in
 *   - READ ONLY transaction + timeout via sql.begin()
 *   - FORBIDDEN_OPS regex as additional safeguard
 */

import { Dialect, ast, parse as parseSql } from '@polyglot-sql/sdk';
import type { DbClient } from '../db/client';
import logger from './logger';
import { buildConnectionVisibilityClause } from './content-search/visibility';
import {
  ADMIN_ONLY_QUERYABLE_TABLES,
  buildColumnList,
  type ColumnDef,
  QUERYABLE_TABLE_NAMES,
  SAFE_COLUMN_DEFS,
  validateTableQuery,
} from './table-schema';
import { getErrorMessage } from "@lobu/core";

/** A named SQL data source: { name, query } or keyed as Record<string, { query }> */
export type DataSourceInput =
  | Record<string, { query: string }>
  | Array<{ name: string; query: string }>;

export interface DataSourceContext {
  organizationId: string;
  /**
   * The requesting user. When set, the events CTE additionally intersects with
   * per-user connection visibility (visibility='org' OR created_by=userId) so
   * query_sql / metrics / client.query don't leak other users' private-connection
   * data — matching what search_memory/get_content already enforce.
   */
  userId?: string | null;
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

type SqlNode = ast.Expression;

/** Strip {{...}} template placeholders to a literal so the parser doesn't choke. */
function stripPlaceholders(sql: string): string {
  return sql.replace(/\{\{\w+(?:\.\w+)?\}\}/g, '0');
}

/** Parse to the top-level statement node, or undefined when the SQL won't parse. */
function parseRoot(sql: string): SqlNode | undefined {
  const res = parseSql(stripPlaceholders(sql), Dialect.PostgreSQL);
  if (!res.success || !res.ast) return undefined;
  return (Array.isArray(res.ast) ? res.ast[0] : res.ast) as SqlNode | undefined;
}

/** Pull a bare identifier string out of polyglot's `{ name, quoted }` shapes. */
function identName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.name === 'string') return o.name;
    if (o.name && typeof o.name === 'object') return identName(o.name);
    if (o.this) return identName(o.this);
  }
  return null;
}

/**
 * Collect every schema-qualified table reference (`schema.table`) in the parsed
 * tree by recursing the RAW AST node graph.
 *
 * Security-critical: org-scoping shadows UNQUALIFIED table names with CTEs, so a
 * schema-qualified ref (`public.connections`, `pg_catalog.*`) bypasses scoping
 * and reads every org's rows. polyglot's `getTables`/`walk`/`findByType` only
 * surface the FIRST `FROM` table — they do NOT descend into JOINs or
 * sub-selects — so a qualified table in a join or subquery would slip past a
 * node-enumeration check. A raw recursion over the node graph is the only
 * reliable way to see them all. A polyglot table-ref node is shaped
 * `{ name, schema, catalog, ... }`; `schema` is null when unqualified.
 *
 * Iterative (stack) traversal, NOT recursion: a recursion depth-cap would
 * fail OPEN — a deeply-nested `public.oauth_tokens` past the cap would slip
 * past and bypass scoping. The `seen` set bounds the walk on cyclic graphs.
 */
function collectSchemaQualifiedTables(root: unknown): string[] {
  const seen = new Set<object>();
  const hits: string[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node as object)) continue;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    const obj = node as Record<string, unknown>;
    if (obj.schema != null && obj.name != null && Object.hasOwn(obj, 'catalog')) {
      hits.push(`${identName(obj.schema) ?? '?'}.${identName(obj.name) ?? '?'}`);
    }
    for (const key of Object.keys(obj)) stack.push(obj[key]);
  }
  return hits;
}

/**
 * Every table-ref name anywhere in the tree (lowercased) via the same raw walk.
 * Security-critical: `ast.getTableNames` does NOT descend into subqueries nested
 * inside an expression (e.g. `(CASE WHEN … THEN (SELECT … FROM oauth_tokens) …)`),
 * so a table hidden there would be neither scoped nor admin-gated. This walk
 * reaches them. Includes CTE-reference names (filtered out by the caller).
 */
function collectAllTableNames(root: unknown): string[] {
  const seen = new Set<object>();
  const names: string[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node as object)) continue;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    const obj = node as Record<string, unknown>;
    if (obj.name != null && Object.hasOwn(obj, 'catalog')) {
      const n = identName(obj.name);
      if (n) names.push(n.toLowerCase());
    }
    for (const key of Object.keys(obj)) stack.push(obj[key]);
  }
  return names;
}

/**
 * Names defined in every WITH clause in the tree (lowercased), incl. nested
 * WITHs. A CTE name is a local alias, NOT a base table — it must be excluded
 * from the scoping list (we'd otherwise inject a conflicting CTE) and from the
 * admin gate (a `WITH events AS …` would otherwise be treated as the base table).
 */
function collectCteNames(root: unknown): Set<string> {
  const seen = new Set<object>();
  const names = new Set<string>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node as object)) continue;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.ctes)) {
      for (const cte of obj.ctes) {
        const alias = identName((cte as Record<string, unknown>)?.alias);
        if (alias) names.add(alias.toLowerCase());
      }
    }
    for (const key of Object.keys(obj)) stack.push(obj[key]);
  }
  return names;
}

/**
 * Strip leading whitespace + SQL comments (line `--…` and block `/* … *​/`) with
 * a single linear scan. Deliberately NOT a regex: a comment-stripping regex with
 * nested quantifiers (`(?:--…|/*…*​/)*`) backtracks catastrophically on crafted
 * input (e.g. many unclosed `/*`) — a ReDoS DoS, since this runs on member SQL.
 */
export function stripLeadingComments(sql: string): string {
  const n = sql.length;
  let i = 0;
  for (;;) {
    while (i < n && /\s/.test(sql[i])) i++;
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) return '';
      i = nl + 1;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i);
      if (end === -1) return '';
      i = end + 2;
    } else {
      return sql.slice(i);
    }
  }
}

// A read query is SELECT or WITH … SELECT, after any leading comments. Rejects
// DML/DDL prefixes AND PostgreSQL's `TABLE <name>` shorthand (≡ SELECT * FROM
// <name>) — polyglot mis-parses the latter as a column, so it yields no table
// refs and would otherwise pass through unscoped.
export function isReadQuery(sql: string): boolean {
  return /^(SELECT|WITH)\b/i.test(stripLeadingComments(sql));
}

// ============================================
// SQL Parsing
// ============================================

/**
 * Extract the COMPLETE set of base-table references a query reads, lowercased —
 * the list that must each be wrapped in an org-scoping CTE.
 *
 * Why this is more than `ast.getTableNames`: the @polyglot-sql/sdk migration's
 * scoping relied on `getTableNames`, which has TWO blind spots that each leak
 * (found by the adversarial bug-hunt):
 *  1. It does not descend into subqueries nested inside an EXPRESSION — e.g.
 *     `(CASE WHEN … THEN (SELECT … FROM oauth_tokens) END)` or a scalar
 *     `SELECT (SELECT … FROM events) …`. Such a table was left unscoped.
 *  2. PostgreSQL's `TABLE <name>` shorthand mis-parses as a column, yielding no
 *     refs at all (handled by the SELECT/WITH guard in validateAndScopeQuery).
 *
 * Strategy here:
 *  - Reject multiple statements and schema-qualified refs (both bypass scoping).
 *  - Build the ref set from a raw AST walk (`collectAllTableNames`), which is a
 *    strict SUPERSET of `ast.getTableNames` (verified across diverse shapes) and
 *    additionally reaches expression-nested subqueries getTableNames misses. The
 *    completeness-invariant test suite guards this against parser changes.
 *  - Exclude CTE names (local aliases, not base tables).
 *  - FAIL-CLOSED collision guard: reject a query whose CTE name shadows a real
 *    or admin table. The parser cannot tell, by lexical scope, whether `events`
 *    in `WITH events AS (SELECT … FROM events)` is the CTE or the base table —
 *    so we forbid the ambiguity rather than risk an unscoped base-table read.
 */
function extractTableRefs(query: string): string[] {
  const res = parseSql(stripPlaceholders(query), Dialect.PostgreSQL);
  if (!res.success || !res.ast) {
    throw new Error('Could not parse SQL query for table extraction');
  }
  // Reject multiple statements: org-scoping CTEs only wrap the FIRST statement,
  // so a trailing `; SELECT … FROM public.oauth_tokens` would run unscoped.
  const statements = Array.isArray(res.ast) ? res.ast : [res.ast];
  if (statements.length > 1) {
    throw new Error('Multiple SQL statements are not allowed; provide a single query.');
  }
  const root = statements[0] as SqlNode;

  // Reject schema-qualified references anywhere in the tree (joins, subqueries,
  // CTE bodies, UNION branches) — they bypass the org-scoping CTEs.
  const qualified = collectSchemaQualifiedTables(root);
  if (qualified.length > 0) {
    throw new Error(
      `Schema-qualified table references are not allowed: ${[...new Set(qualified)].join(', ')}`
    );
  }

  const cteNames = collectCteNames(root);
  // A CTE may not shadow a real/admin table name — see fail-closed note above.
  for (const cte of cteNames) {
    if (QUERYABLE_TABLE_NAMES.has(cte) || ADMIN_ONLY_QUERYABLE_TABLES.has(cte)) {
      throw new Error(
        `CTE name '${cte}' collides with a reserved table name; rename the CTE.`
      );
    }
  }

  // Every base-table ref via the raw walk (superset of getTableNames, incl.
  // expression-nested), minus CTE names (local aliases, not base tables).
  const refs = new Set<string>();
  for (const n of collectAllTableNames(root)) {
    if (!cteNames.has(n)) refs.add(n);
  }
  return Array.from(refs);
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
 *   2. extractTableRefs() — @polyglot-sql/sdk AST extracts table names
 *   3. buildScopedQuery() — wraps each table reference in an org-scoped CTE
 *
 * Throws on any validation failure.
 */
export function validateAndScopeQuery(
  rawSql: string,
  organizationId: string,
  options?: {
    safeColumns?: Map<string, ColumnDef[]>;
    /**
     * Tables the caller may NOT reference (rejected even though they're in the
     * global allowlist). Used to keep auth/identity tables (oauth_tokens,
     * oauth_clients, user) admin-only when a non-admin runs query_sql /
     * metric_series. Omit for admin / server-internal callers (full access).
     */
    restrictedTables?: ReadonlySet<string>;
    /**
     * The requesting user. Threaded into the events CTE so connection-sourced
     * rows are filtered to org-visible connections or this user's own private
     * ones (per-user visibility). Omit for service/headless callers — null
     * yields org-visible-only (fail-closed for private data).
     */
    userId?: string | null;
  }
): { sql: string; params: unknown[] } {
  const trimmed = rawSql.trim();
  if (!trimmed) {
    throw new Error('SQL query is required');
  }

  // Must be a read query. Rejects DML/DDL AND PostgreSQL's `TABLE <name>`
  // shorthand (≡ `SELECT * FROM <name>`) — polyglot mis-parses `TABLE` as a
  // column, so it would yield zero table refs and pass through UNSCOPED and
  // past the admin-table gate. The gate below is fail-closed regardless, but
  // rejecting the shorthand outright keeps the contract obvious.
  if (!isReadQuery(trimmed)) {
    throw new Error('Only SELECT / WITH queries are allowed.');
  }

  // Schema-level validation via SQL parser (rejects unknown tables/columns, mutations, etc.)
  const validation = validateTableQuery(trimmed);
  if (!validation.valid) {
    throw new Error(validation.errors.join('; '));
  }

  // COMPLETE table extraction (union of getTableNames + raw walk, CTE names
  // excluded). Drives the unknown-table check, the admin gate, AND org-scoping,
  // so an expression-nested table is caught by all three.
  const tableRefs = extractTableRefs(trimmed);
  const unknown = tableRefs.filter((t) => !QUERYABLE_TABLE_NAMES.has(t));
  if (unknown.length > 0) {
    throw new Error(`Unknown table(s): ${unknown.join(', ')}`);
  }

  if (options?.restrictedTables) {
    const blocked = tableRefs.filter((t) => options.restrictedTables?.has(t));
    if (blocked.length > 0) {
      throw new Error(
        `Table(s) require admin access: ${[...new Set(blocked)].join(', ')}`
      );
    }
  }

  return buildScopedQuery(
    trimmed,
    tableRefs,
    { organizationId, userId: options?.userId ?? null },
    options
  );
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
export function buildScopedQuery(
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

  // Per-user connection visibility (S0). Applied to EVERY CTE on this seam that
  // exposes connection-sourced event content — `events`, `event_classifications`
  // (whose `excerpts` is verbatim source text), and `connections` — so query_sql
  // / metrics / client.query never surface another user's private-connection data.
  // This is the same gate search_memory/get_content already enforce. `userId`
  // null (headless/service) yields org-visible-only, fail-closed for private data.

  // For a table holding events (alias has a `connection_id` col): restrict to
  // org-visible connections or the requesting user's own private ones.
  const eventConnVisibility = (alias: string): string => {
    const vis = buildConnectionVisibilityClause(
      {
        organizationId: context.organizationId,
        userId: context.userId ?? null,
        baseParamIndex: idx + 1,
      },
      alias
    );
    if (!vis.sql) return '';
    params.push(...vis.params);
    idx += vis.params.length;
    return ` ${vis.sql}`;
  };

  // For the `connections` table itself: the row is visible when org-shared or
  // owned by the requesting user (mirrors manage_connections CRUD).
  const connectionRowVisibility = (alias: string): string => {
    idx += 1;
    params.push(context.userId ?? null);
    const userP = `$${idx}::text`;
    return ` AND (${alias}.visibility = 'org' OR (${userP} IS NOT NULL AND ${alias}.created_by = ${userP}))`;
  };

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

  // security-allowed: every `${safeName}` below is a QUERYABLE_TABLE_NAMES-whitelisted
  // identifier that's been double-quote-escaped; every `${orgP}` is a $N parameter
  // placeholder; `sel()` / `selEntitiesJoined()` return validated column expressions.
  // postgres.js tagged templates can't template dynamic identifiers, so these CTE
  // skeletons are built via concatenation. Static-guard suppression applies to this
  // whole loop body.
  for (const table of tableRefs) {
    // Escape double quotes in table name for safe identifier quoting
    const safeName = table.replace(/"/g, '""');

    if (table === 'entities') {
      // security-allowed: see block comment above this for-loop
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
      // what search_memory/get_content surface.
      // security-allowed: see block comment above the for-loop
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

      eventsCte += eventConnVisibility('ev');

      eventsCte += ')';
      ctes.push(eventsCte);
    } else if (table === 'connections') {
      // A private connection's own row (display_name, account_id, config) is
      // per-user too — mirror manage_connections CRUD so a member can't read
      // another user's private-connection metadata via raw SQL.
      // Soft-deleted rows are intentionally NOT excluded here — query_sql is an
      // audit/debug surface and there's no cross-user leak (a deleted private
      // connection still carries created_by, so the visibility predicate blocks
      // it). The per-user predicate is the security boundary.
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'cn')} FROM public.connections cn WHERE cn.organization_id = ${orgP}` +
          connectionRowVisibility('cn') +
          ')'
      );
    } else if (table === 'watchers') {
      // security-allowed: see block comment above the for-loop
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'i')} FROM public.watchers i WHERE EXISTS (` +
          'SELECT 1 FROM public.entities ent WHERE ent.id = ANY(i.entity_ids) ' +
          `AND ent.organization_id = ${orgP}))`
      );
    } else if (table === 'event_classifications') {
      // security-allowed: see block comment above the for-loop
      // `excerpts`/`values`/`reasoning` carry verbatim source-event content, so
      // the EXISTS must apply per-user connection visibility on `ev` — otherwise
      // any member reads classifications of another user's private-connection
      // events (the same leak the events CTE closes, on the joined table).
      // Use current_event_records (not public.events) for tombstone parity with
      // the events CTE — a superseded event's classifications shouldn't surface.
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'ec')} FROM public.event_classifications ec WHERE EXISTS (` +
          'SELECT 1 FROM public.current_event_records ev ' +
          'JOIN public.entities ent ON ent.id = ANY(ev.entity_ids) ' +
          `WHERE ev.id = ec.event_id AND ent.organization_id = ${orgP}` +
          eventConnVisibility('ev') +
          '))'
      );
    } else if (table === 'watcher_versions') {
      // security-allowed: see block comment above the for-loop
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'wv')} FROM public.watcher_versions wv ` +
          'JOIN public.watchers w ON w.id = wv.watcher_id WHERE EXISTS (' +
          'SELECT 1 FROM public.entities ent WHERE ent.id = ANY(w.entity_ids) ' +
          `AND ent.organization_id = ${orgP}))`
      );
    } else if (table === 'watcher_windows') {
      // security-allowed: see block comment above the for-loop
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
      // Every feed derives from a connection (`connection_id` NOT NULL), so a
      // private connection's feeds (display_name, config, last_error) are
      // per-user too — gate via the owning connection's visibility.
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'fd')} FROM public.feeds fd WHERE fd.organization_id = ${orgP}` +
          eventConnVisibility('fd') +
          ')'
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
      // security-allowed: see block comment above the for-loop
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
  // Strip leading line/block comments before deciding how to merge: a
  // `-- note\nWITH x AS (…) …` query is still a WITH, and prepending a second
  // WITH keyword would emit invalid SQL (`WITH … \n -- note \n WITH x …`).
  // Comments are cosmetic, so dropping the leading ones is safe.
  const body = stripLeadingComments(processedQuery).trim();

  // If the user query is itself a WITH, splice our CTEs in front of its CTE list
  // (single WITH keyword); otherwise prepend our WITH block.
  const finalSql = /^WITH\b/i.test(body)
    ? `${cteStr},\n${body.replace(/^WITH\s+/i, '')}`
    : `${cteStr}\n${body}`;

  return { sql: finalSql, params };
}

// ============================================
// Validation
// ============================================

/**
 * Inspect a SELECT/WITH query's top-level projection and report whether it
 * surfaces an `id` column.
 *
 * Watcher-mode content aggregation keys every row by `row.id` (see
 * queryContentData in get_content.ts) and the signed window_token only carries
 * those numeric ids. A source query that omits `id` (e.g. `SELECT origin_id,
 * payload_text FROM events`) therefore produces zero content_ids — which makes
 * complete_window silently report `content_linked: 0` and skip the reaction
 * even though the agent received the rows. We catch that at save time instead.
 *
 * A projection "has id" if it contains a `*` star (bare or table-qualified),
 * a bare `id` column reference, or any column aliased `AS id`.
 *
 * Returns true on any parse failure: this is a best-effort guard, not a
 * security control, and we never want a parser edge case to block a save.
 */
export function queryProjectsIdColumn(query: string): boolean {
  try {
    const root = parseRoot(query);
    // Treat any shape we can't analyze (parse failure, non-SELECT) as "has id"
    // so we never block a save on a parser edge case.
    if (!root || ast.getExprType(root) !== 'select') return true;
    const projection = (ast.getExprData(root) as { expressions?: unknown[] }).expressions;
    if (!Array.isArray(projection)) return true;

    for (const item of projection as SqlNode[]) {
      const itemType = ast.getExprType(item);
      // Star projection: `*` or `alias.*`
      if (itemType === 'star' || ast.isStar?.(item)) return true;
      if (itemType === 'alias') {
        const d = ast.getExprData(item) as Record<string, unknown>;
        if (identName(d.alias)?.toLowerCase() === 'id') return true; // ... AS id
        const inner = (d.this ?? d.expr) as SqlNode | undefined;
        if (inner && (ast.getExprType(inner) === 'star' || ast.isStar?.(inner))) return true;
      } else if (itemType === 'column') {
        if (identName((ast.getExprData(item) as Record<string, unknown>).name)?.toLowerCase() === 'id')
          return true; // bare `id`
      }
    }
    return false;
  } catch {
    return true;
  }
}

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
      const res = parseSql(stripPlaceholders(trimmed), Dialect.PostgreSQL);
      if (!res.success) throw new Error(res.error ?? 'could not parse query');
      // Reject auth/identity tables at save time so a template that would only
      // be masked at runtime fails fast with a clear error. (Runtime masking via
      // SAFE_COLUMN_DEFS is the enforcement; this is early, defense-in-depth
      // feedback.) Column-level allowlisting is intentionally NOT applied here —
      // data sources legitimately reference entity-type slugs (unknown tables).
      const refs = extractTableRefs(trimmed);
      const restricted = refs.filter((t) => ADMIN_ONLY_QUERYABLE_TABLES.has(t));
      if (restricted.length > 0) {
        throw new Error(
          `references admin-only table(s): ${[...new Set(restricted)].join(', ')}`
        );
      }
    } catch (err) {
      throw new Error(`Data source '${name}': ${getErrorMessage(err)}`);
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
    /** Transform the scoped SQL before execution (e.g. wrap for ID-only extraction or pagination). */
    wrapQuery?: (
      scopedSql: string,
      params: unknown[],
      sourceName: string
    ) => string | { sql: string; params: unknown[] };
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

        // Auth/identity tables (oauth_tokens, oauth_clients, user) must not be
        // referenceable from a view-template / watcher data source — these
        // results surface to public/member readers via resolve_path. Mirror
        // query_sql's non-admin gate. (Entity-type slugs are never in this set.)
        const restricted = tableRefs.filter((t) =>
          ADMIN_ONLY_QUERYABLE_TABLES.has(t)
        );
        if (restricted.length > 0) {
          throw new Error(
            `Source '${name}': table(s) require admin access: ${[...new Set(restricted)].join(', ')}`
          );
        }

        // safeColumns masks each core-table CTE to its allowlisted columns, so
        // excluded secret columns (connections.credentials, oauth_tokens.
        // token_hash, oauth_clients.client_secret, user.email/phoneNumber,
        // events.embedding, feeds.checkpoint) are never emitted even when the
        // query selects them. Without it the CTE fell back to SELECT *, leaking
        // every physical column. Entity-type slug CTEs (no allowlist entry) keep
        // their SELECT * — entity data is the template's intended payload.
        let { sql: scopedQuery, params } = buildScopedQuery(query, tableRefs, context, {
          safeColumns: SAFE_COLUMN_DEFS,
        });

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
          const wrapped = options.wrapQuery(scopedQuery, params, name);
          if (typeof wrapped === 'string') {
            scopedQuery = wrapped;
          } else {
            scopedQuery = wrapped.sql;
            params = wrapped.params;
          }
        }

        const rows = await sql.begin(async (tx) => {
          await tx.unsafe('SET TRANSACTION READ ONLY');
          await tx.unsafe(`SET LOCAL statement_timeout = '${QUERY_TIMEOUT_MS}'`);
          return tx.unsafe(scopedQuery, params);
        });

        results[name] = Array.isArray(rows) ? rows.slice(0, MAX_ROWS) : [];
      } catch (err) {
        logger.warn(
          { error: getErrorMessage(err), dataSource: name },
          'Data source execution failed'
        );
        results[name] = [];
      }
    })
  );

  return results;
}
