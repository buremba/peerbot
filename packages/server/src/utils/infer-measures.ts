/**
 * Classify a derived entity view's output columns as measures or dimensions —
 * computed ON READ, never persisted.
 *
 * A derived entity type is a SQL view; each output column is either a MEASURE
 * (an aggregate / computed numeric) or a DIMENSION (a plain grouping column).
 * The UI uses this to tag/right-align measure columns. We do NOT write these
 * roles into metadata_schema — persisting an inferred superset only created
 * apply-diff churn; the single consumer (the UI) reads them at query time.
 *
 * Parsing uses @polyglot-sql/sdk — the same engine `validateAndScopeQuery` uses.
 * The SDK auto-initialises on (ESM) import, so the synchronous `parse` works
 * without an explicit init step.
 */
import { Dialect, ast, parse } from '@polyglot-sql/sdk';

type Node = ast.Expression;

export interface DerivedColumn {
  name: string;
  role: 'measure' | 'dimension';
}

// A projection column is a MEASURE when its expression is an aggregate or a
// computed numeric (ratio). polyglot reports canonical aggregates by name
// (sum/count/…) and everything else as the generic `aggregate_function` /
// `within_group` (e.g. bool_or, jsonb_agg, percentile_cont … WITHIN GROUP);
// `div` covers ratios. Anything else (a bare column, a cast of one) is a
// dimension.
const MEASURE_EXPR_TYPES = new Set<string>([
  'sum',
  'count',
  'avg',
  'min',
  'max',
  'median',
  'mode',
  'approx_distinct',
  'approx_count_distinct',
  'count_if',
  'sum_if',
  'group_concat',
  'string_agg',
  'list_agg',
  'array_agg',
  'stddev',
  'variance',
  'first',
  'last',
  'any_value',
  // polyglot's generic aggregate node types
  'aggregate_function',
  'within_group',
  // computed numeric (ratios)
  'div',
]);

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
 * Classify each projection column of a derived entity's view SELECT.
 * Returns `[]` if the SQL can't be parsed or isn't a simple projection.
 */
export function inferColumns(sql: string): DerivedColumn[] {
  // Strip {{...}} template placeholders so the parser doesn't choke.
  const forParsing = sql.trim().replace(/\{\{\w+(?:\.\w+)?\}\}/g, '0');

  let root: Node | undefined;
  try {
    const res = parse(forParsing, Dialect.PostgreSQL);
    if (!res.success || !res.ast) return [];
    root = (Array.isArray(res.ast) ? res.ast[0] : res.ast) as Node | undefined;
  } catch {
    return [];
  }
  if (!root || ast.getExprType(root) !== 'select') return [];

  const projection = (ast.getExprData(root) as { expressions?: unknown[] }).expressions;
  if (!Array.isArray(projection)) return [];

  const out: DerivedColumn[] = [];
  for (const item of projection as Node[]) {
    const itemType = ast.getExprType(item);

    let nameSrc: unknown;
    let valueExpr: Node = item;
    if (itemType === 'alias') {
      const d = ast.getExprData(item) as Record<string, unknown>;
      nameSrc = d.alias;
      valueExpr = (d.this ?? d.expr ?? item) as Node;
    } else if (itemType === 'column') {
      nameSrc = (ast.getExprData(item) as Record<string, unknown>).name;
    } else {
      continue; // star / literal / unnamed projection
    }

    const name = identName(nameSrc);
    if (!name || name === '*') continue;

    out.push({
      name,
      role: MEASURE_EXPR_TYPES.has(ast.getExprType(valueExpr)) ? 'measure' : 'dimension',
    });
  }
  return out;
}

/** Names of the view's measure columns (computed on read; never persisted). */
export function measureColumns(sql: string): string[] {
  return inferColumns(sql)
    .filter((c) => c.role === 'measure')
    .map((c) => c.name);
}
