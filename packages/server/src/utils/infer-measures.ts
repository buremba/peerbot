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
 * Parsing uses node-sql-parser (the same parser `execute-data-sources.ts` uses
 * for table extraction); polyglot 0.1.x does not expose a usable projection AST.
 */
import nodeSqlParser from 'node-sql-parser';

const { Parser } = nodeSqlParser;
const parser = new Parser();

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

function reaggForAggregate(name: string, distinct: boolean): ReaggRule {
  if (distinct) return 'holistic'; // COUNT(DISTINCT ...), etc.
  const n = name.toUpperCase();
  if (n === 'SUM' || n === 'COUNT') return 'additive';
  if (n === 'AVG') return 'ratio';
  if (n === 'MIN' || n === 'MAX') return 'extremum';
  if (n === 'MEDIAN' || n.startsWith('PERCENTILE')) return 'holistic';
  return 'non_additive'; // unknown aggregate → never silently roll it up
}

/** Best-effort output-column name for a projection item. */
function columnName(col: Record<string, unknown>): string | null {
  if (typeof col.as === 'string' && col.as) return col.as;
  const expr = col.expr as Record<string, unknown> | undefined;
  if (expr?.type === 'column_ref') {
    const column = expr.column;
    if (typeof column === 'string') return column;
    const nested = (column as Record<string, unknown>)?.expr as
      | Record<string, unknown>
      | undefined;
    if (typeof nested?.value === 'string') return nested.value;
  }
  return null;
}

/**
 * Classify each projection column of a derived entity's view SELECT.
 * Returns `[]` if the SQL can't be parsed or isn't a simple projection
 * (callers treat "no inference" as "author annotates explicitly").
 */
export function inferColumns(sql: string): InferredColumn[] {
  let stmt: Record<string, unknown> | undefined;
  try {
    // Strip {{...}} template placeholders so the parser doesn't choke.
    const forParsing = sql.trim().replace(/\{\{\w+(?:\.\w+)?\}\}/g, '0');
    const ast = parser.astify(forParsing, { database: 'PostgreSql' });
    stmt = (Array.isArray(ast) ? ast[0] : ast) as unknown as
      | Record<string, unknown>
      | undefined;
  } catch {
    return [];
  }

  const columns = stmt?.columns;
  if (!Array.isArray(columns)) return []; // `SELECT *` and unknown shapes → no inference

  const out: InferredColumn[] = [];
  for (const col of columns as Array<Record<string, unknown>>) {
    const name = columnName(col);
    if (!name || name === '*') continue;

    const expr = col.expr as Record<string, unknown> | undefined;
    if (expr?.type === 'aggr_func') {
      const fnName = typeof expr.name === 'string' ? expr.name : '';
      const distinct =
        (expr.args as Record<string, unknown> | undefined)?.distinct === 'DISTINCT';
      out.push({ name, role: 'measure', reagg: reaggForAggregate(fnName, distinct) });
    } else if (expr?.type === 'binary_expr' && expr.operator === '/') {
      out.push({ name, role: 'measure', reagg: 'ratio' });
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
    props[col.name] =
      col.role === 'measure'
        ? { type: 'number', ...existing, 'x-measure': { reagg: col.reagg } }
        : { ...existing, 'x-dimension': {} };
  }

  base.properties = props;
  return base;
}
