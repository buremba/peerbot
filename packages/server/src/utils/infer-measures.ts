/**
 * Infer measure / dimension roles for a derived entity's view columns from its
 * SELECT projection.
 *
 * A derived entity type is a SQL view; each output column is either a MEASURE
 * (an aggregate — it has a re-aggregation rule that says how it rolls up to a
 * coarser grain) or a DIMENSION (a plain grouping column). We read the role and
 * the re-agg rule straight from the aggregate function in the SELECT, so authors
 * don't hand-annotate the common cases — they only override the tricky ones
 * (declared `x-measure` always wins; this only fills gaps).
 *
 * Re-aggregation rules (why the function matters):
 *   SUM / COUNT            → additive    (re-sum across groups)
 *   COUNT(DISTINCT ...)    → holistic    (cannot re-sum; recompute from base)
 *   MEDIAN / PERCENTILE_*  → holistic
 *   AVG                    → ratio       (recompute SUM/COUNT, never average averages)
 *   MIN / MAX              → extremum    (min/max at any grain)
 *   a / b                  → ratio
 *   anything else          → non_additive (safe: the engine refuses to roll it up)
 *
 * Parsing uses @polyglot-sql/sdk — the same postgres-aware SQL engine that
 * `validateAndScopeQuery` uses to validate/scope queries — so the whole stack
 * runs on one parser. The SDK auto-initialises on (ESM) import, so the
 * synchronous `parse` below works without an explicit init step.
 */
import { Dialect, ast, parse } from '@polyglot-sql/sdk';

type Node = ast.Expression;

export type ReaggRule =
  | 'additive'
  | 'holistic'
  | 'ratio'
  | 'extremum'
  | 'non_additive';

export interface InferredColumn {
  name: string;
  role: 'measure' | 'dimension';
  /** Only set for measures. */
  reagg?: ReaggRule;
}

// Aggregate function node types polyglot reports via getExprType(). Anything in
// this set is a measure; the re-agg rule depends on which one (+ DISTINCT).
const ADDITIVE_AGGS = new Set(['sum', 'count', 'count_if', 'sum_if']);
const HOLISTIC_AGGS = new Set([
  'median',
  'mode',
  'approx_distinct',
  'approx_count_distinct',
]);
const EXTREMUM_AGGS = new Set(['min', 'max']);
const AGG_TYPES = new Set<string>([
  ...ADDITIVE_AGGS,
  ...HOLISTIC_AGGS,
  ...EXTREMUM_AGGS,
  'avg',
  // present but not safely re-aggregatable → non_additive
  'group_concat',
  'string_agg',
  'list_agg',
  'array_agg',
  'stddev',
  'variance',
  'first',
  'last',
  'any_value',
]);

function reaggForAggregate(type: string, distinct: boolean): ReaggRule {
  if (distinct) return 'holistic'; // COUNT(DISTINCT ...), etc.
  if (ADDITIVE_AGGS.has(type)) return 'additive';
  if (type === 'avg') return 'ratio';
  if (EXTREMUM_AGGS.has(type)) return 'extremum';
  if (HOLISTIC_AGGS.has(type)) return 'holistic';
  return 'non_additive'; // unknown/unsafe aggregate → never silently roll it up
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
 * Classify each projection column of a derived entity's view SELECT.
 * Returns `[]` if the SQL can't be parsed or isn't a simple projection
 * (callers treat "no inference" as "author annotates explicitly").
 */
export function inferColumns(sql: string): InferredColumn[] {
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
  if (!root || ast.getExprType(root) !== 'select') return []; // non-SELECT / unknown shape

  const projection = (ast.getExprData(root) as { expressions?: unknown[] }).expressions;
  if (!Array.isArray(projection)) return [];

  const out: InferredColumn[] = [];
  for (const item of projection as Node[]) {
    const itemType = ast.getExprType(item);

    // Resolve the output column name + the value expression behind it.
    let nameSrc: unknown;
    let valueExpr: Node = item;
    if (itemType === 'alias') {
      const d = ast.getExprData(item) as Record<string, unknown>;
      nameSrc = d.alias;
      valueExpr = (d.this ?? d.expr ?? item) as Node;
    } else if (itemType === 'column') {
      nameSrc = (ast.getExprData(item) as Record<string, unknown>).name;
    } else {
      continue; // star / literal / unnamed projection → not a useful column
    }

    const name = identName(nameSrc);
    if (!name || name === '*') continue;

    const valueType = ast.getExprType(valueExpr);
    if (valueType === 'div') {
      out.push({ name, role: 'measure', reagg: 'ratio' }); // a / b
    } else if (AGG_TYPES.has(valueType)) {
      const distinct = (ast.getExprData(valueExpr) as Record<string, unknown>).distinct === true;
      out.push({ name, role: 'measure', reagg: reaggForAggregate(valueType, distinct) });
    } else {
      out.push({ name, role: 'dimension' });
    }
  }
  return out;
}

/**
 * Merge inferred measure/dimension roles into a derived entity's metadata_schema
 * `properties` as `x-measure` / `x-dimension` extensions. Author-declared
 * annotations win — inference only fills columns the author didn't annotate.
 */
export function applyInferredMeasures(
  metadataSchema: Record<string, unknown> | undefined,
  backingSql: string
): Record<string, unknown> {
  const base: Record<string, unknown> = { type: 'object', ...(metadataSchema ?? {}) };
  const props: Record<string, unknown> = {
    ...((base.properties as Record<string, unknown>) ?? {}),
  };

  for (const col of inferColumns(backingSql)) {
    const existing = (props[col.name] as Record<string, unknown> | undefined) ?? {};
    // Author already declared this column's role → keep it.
    if (existing['x-measure'] !== undefined || existing['x-dimension'] !== undefined) {
      continue;
    }
    // `inferred: true` marks these as server-derived (not author-declared) so
    // the apply diff can strip them — otherwise a derived entity churns every
    // apply (the config never declares this inferred superset). The flagged
    // annotation is the ONLY key inference injects (no `type`), so stripping it
    // leaves exactly the author's keys — keeping the diff exact even when the
    // author also gave the column a description.
    props[col.name] =
      col.role === 'measure'
        ? { ...existing, 'x-measure': { reagg: col.reagg, inferred: true } }
        : { ...existing, 'x-dimension': { inferred: true } };
  }

  base.properties = props;
  return base;
}

/**
 * Remove the derived-only `x-measure` / `x-dimension` annotations from a
 * metadata_schema. Used when an entity type reverts from derived to stored:
 * measures/dimensions are meaningless on a row-backed type, so they must not
 * linger from a previous derived definition.
 */
export function stripMeasureAnnotations(
  metadataSchema: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadataSchema) return metadataSchema;
  const propsIn = metadataSchema.properties as Record<string, unknown> | undefined;
  if (!propsIn) return metadataSchema;
  const propsOut: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(propsIn)) {
    if (prop && typeof prop === 'object' && !Array.isArray(prop)) {
      const { 'x-measure': _m, 'x-dimension': _d, ...rest } = prop as Record<string, unknown>;
      propsOut[name] = rest;
    } else {
      propsOut[name] = prop;
    }
  }
  return { ...metadataSchema, properties: propsOut };
}
