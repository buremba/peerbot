/**
 * Metric compiler — "producer A": lowers a declared metric (an entity type's
 * eventSets/measures/dimensions/segments) into org-scopable SQL over the event
 * stream, then aggregates it. The output SELECT references `events` + `entities`
 * as plain tables; the caller passes it through `validateAndScopeQuery`, which
 * rewrites `events` → `current_event_records` (superseded rows masked) and
 * org-scopes both — so this module never writes scoping or masking itself.
 *
 * Consolidation: the `aggregate` step (SELECT agg(expr) … GROUP BY dims) is the
 * SAME step a federated warehouse metric flows through — only the *relation*
 * differs (here a resolved/deduped CTE over events; there a connector's
 * SEMANTIC_VIEW). That step is the Malloy-swappable seam.
 *
 * v1 scope: `eventSet.by: "alias"` + `reads: "current"` only. window/link,
 * raw/asOf reads, and cross-entity joins are deferred (NotImplemented).
 */

import type { EntityMetrics } from "@lobu/connector-sdk";

class MetricCompileError extends Error {}
class MetricNotImplementedError extends MetricCompileError {}

interface CompileMetricInput {
  /** entity_types.id, for the alias-resolution join. */
  entityTypeId: number;
  /** The entity type's declared metric contract (from metrics_config). */
  metrics: EntityMetrics;
  /** Measure name to compute. */
  measure: string;
  /** Dimension names to group by (default: none → a single grand-total row per entity). */
  by?: string[];
  /** Extra segment name to AND in, beyond the measure's own `segments`. */
  segment?: string;
  /** Restrict to one entity (entities.id); omitted ⇒ all entities of the type. */
  entityId?: number;
}

const SANE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Output column alias for a dimension / measure — guarded so names can't inject. */
function outName(kind: string, name: string): string {
  if (!SANE_IDENT.test(name)) {
    throw new MetricCompileError(`${kind} name "${name}" must be a plain identifier`);
  }
  return name;
}

/**
 * Compile a measure into a single SELECT (no top-level WITH). Throws
 * MetricCompileError on bad references and MetricNotImplementedError for
 * deferred features. The result is NOT yet org-scoped — pass it through
 * `validateAndScopeQuery`.
 */
export function compileMetricSql(input: CompileMetricInput): string {
  const { metrics, entityTypeId } = input;
  const measure = metrics.measures?.[input.measure];
  if (!measure) {
    throw new MetricCompileError(`measure "${input.measure}" is not declared`);
  }
  const eventSet = metrics.eventSets?.[measure.eventSet];
  if (!eventSet) {
    throw new MetricCompileError(
      `measure "${input.measure}" references eventSet "${measure.eventSet}" which is not declared`,
    );
  }
  if (eventSet.by !== "alias") {
    throw new MetricNotImplementedError(
      `eventSet resolver "${eventSet.by}" is not implemented in v1 (alias only)`,
    );
  }
  const reads = eventSet.reads ?? "current";
  if (reads !== "current") {
    throw new MetricNotImplementedError(
      `reads mode "${JSON.stringify(reads)}" is not implemented in v1 ("current" only)`,
    );
  }
  if (!eventSet.field) {
    throw new MetricCompileError(`alias eventSet "${measure.eventSet}" needs a "field"`);
  }

  // ── Resolve segments (measure's own + the caller's override) ──────────────
  const segNames = [...(measure.segments ?? []), ...(input.segment ? [input.segment] : [])];
  const segWheres: string[] = [];
  for (const name of segNames) {
    const seg = metrics.segments?.[name];
    if (!seg) throw new MetricCompileError(`segment "${name}" is not declared`);
    segWheres.push(`(${seg.where})`);
  }

  // ── Dimensions to group by ────────────────────────────────────────────────
  const dims = (input.by ?? []).map((name) => {
    const dim = metrics.dimensions?.[name];
    if (!dim) throw new MetricCompileError(`dimension "${name}" is not declared`);
    return { col: outName("dimension", name), expr: dim.expr };
  });

  // ── Inner: filtered events (single table → `metadata` is unambiguous, no
  //    qualifier needed for the config-authored predicates). ─────────────────
  const innerWhere = [
    eventSet.where ? `(${eventSet.where})` : null,
    measure.where ? `(${measure.where})` : null,
    ...segWheres,
  ].filter(Boolean);
  const evt = `SELECT * FROM events${
    innerWhere.length ? ` WHERE ${innerWhere.join(" AND ")}` : ""
  }`;

  // ── Alias resolution: flatten (entity_id, alias) so `entities.metadata`
  //    never enters the expr scope (keeps `metadata` = the event's). ─────────
  const entWhere = [`ent.entity_type_id = ${Number(entityTypeId)}`, `ent.deleted_at IS NULL`];
  if (input.entityId !== undefined) entWhere.push(`ent.id = ${Number(input.entityId)}`);
  const entAlias = `SELECT ent.id AS entity_id, a.alias
       FROM entities ent, jsonb_array_elements_text(ent.metadata->'aliases') AS a(alias)
       WHERE ${entWhere.join(" AND ")}`;

  // ── Resolved + deduped relation. DISTINCT over the dedupe tuple ∪ entity ∪
  //    dims ∪ measure expr so summing over distinct rows is correct (a missing
  //    dim in the dedupe set would wrongly collapse rows across that dim). ────
  const dedupeCols = (eventSet.dedupeKey ?? []).map((e, i) => `(${e}) AS __dk${i}`);
  const measureExprSel = measure.expr ? `(${measure.expr}) AS __m` : null;
  const dimSels = dims.map((d) => `(${d.expr}) AS ${d.col}`);
  const distinct = eventSet.dedupeKey && eventSet.dedupeKey.length > 0 ? "DISTINCT " : "";
  const relationCols = [
    "ea.entity_id",
    ...dimSels,
    ...(measureExprSel ? [measureExprSel] : []),
    ...dedupeCols,
  ].join(", ");
  const fieldExpr = `evt.${eventSet.field}`;
  const resolved = `SELECT ${distinct}${relationCols}
     FROM (${evt}) evt
     JOIN (${entAlias}) ea ON ea.alias = ${fieldExpr}`;

  // ── Aggregate (the shared, Malloy-swappable seam) ─────────────────────────
  const measureName = outName("measure", input.measure);
  const aggExpr = aggregateExpr(measure.agg, measure.expr ? "__m" : null, measureName);
  const groupCols = ["entity_id", ...dims.map((d) => d.col)];
  const selectCols = [...groupCols, aggExpr].join(", ");
  return `SELECT ${selectCols}
     FROM (${resolved}) resolved
     GROUP BY ${groupCols.join(", ")}`;
}

/** The aggregate column for a measure. `count` ⇒ COUNT(*); others aggregate the
 *  measure expr (aliased `__m` in the relation). */
function aggregateExpr(
  agg: string,
  exprCol: string | null,
  outAlias: string,
): string {
  if (agg === "count") return `COUNT(*) AS ${outAlias}`;
  if (!exprCol) {
    throw new MetricCompileError(`agg "${agg}" requires an expr`);
  }
  switch (agg) {
    case "sum":
      return `SUM(${exprCol}) AS ${outAlias}`;
    case "min":
      return `MIN(${exprCol}) AS ${outAlias}`;
    case "max":
      return `MAX(${exprCol}) AS ${outAlias}`;
    case "count_distinct":
      return `COUNT(DISTINCT ${exprCol}) AS ${outAlias}`;
    default:
      throw new MetricCompileError(`unsupported agg "${agg}"`);
  }
}
