/**
 * Entity-bound metric layer — the PERSISTED contract shapes.
 *
 * These live in `@lobu/connector-sdk` (not `@lobu/core`) because of two
 * constraints that intersect here:
 *  - the CLI config module (`@lobu/cli/config`) is loaded by jiti at `lobu apply`
 *    time and is import-isolated to relative siblings + connector-sdk + typebox
 *    (see config-isolation.test.ts) — it must NOT import `@lobu/core`'s heavy graph;
 *  - the server compiles/validates the stored metric JSON and must NOT import the CLI.
 * `connector-sdk` is the one shared package both can import, and it already
 * carries entity contract types (EntityIdentitySpec, EntityLinkRule, …).
 *
 * Plain interfaces for now. A runtime validator (zod, in the layer that
 * validates stored config) lands with the persistence path that uses it. The
 * compiler lowers `eventSets` + `measures` into backing SQL; nothing here
 * executes. v1 implements `EventSet.by: "alias"` only.
 */

/**
 * Temporal truth a measure reads over the append-only event stream:
 * - `"current"` — `current_event_records` (superseded rows masked); the default.
 * - `"raw"`     — `events` verbatim, including superseded rows (audit/debug).
 * - `{ asOf }`  — point-in-time snapshot; `asOf` is an ISO-8601 instant compared
 *                 against `occurred_at` (event time, NOT system time). A richer
 *                 structured form (relative durations, system-time) is deferred.
 */
export type MetricReadMode = 'current' | 'raw' | { asOf: string };

export type MetricTier = 'gold' | 'silver' | 'bronze';

/**
 * Cross-source fact-identity rule. DEFERRED — a no-op until a measure fuses more
 * than one source. Shaped now so the {@link EventSet} schema needs no breaking
 * change when the first multi-source measure ships; until then use
 * {@link EventSet.dedupeKey} for same-source dedupe.
 *
 * Domain-agnostic: keys are logical field names, not a fixed finance tuple.
 */
export interface FactMatchRule {
  /**
   * Per-source field map normalizing heterogeneous rows to a common fact tuple:
   * logical field name → SQL expression. e.g.
   * `{ amount: "metadata->>'amount'", at: "metadata->>'date'" }`.
   */
  key: Record<string, string>;
  /** Per-key match tolerance, e.g. `{ at: '2d', amount: '0' }` (string; the compiler interprets). */
  tolerance?: Record<string, string>;
  /** Source priority when the same fact is seen twice (e.g. `['revolut','gmail']`). */
  prefer?: string[];
}

/**
 * A NAMED event set — how events resolve to this entity, at an explicit grain
 * (the join key). An entity can resolve events in several roles/grains, so the
 * grain is named, not implicit. The compiler lowers this to the base relation a
 * measure aggregates over (resolve → reads-mask → dedupe → segment).
 *
 * v1 implements `by: "alias"` only; `"window"`/`"link"` and `factIdentity` are
 * deferred. `where` predicates are raw SQL — parsed/validated/org-scoped by the
 * compiler, never trusted verbatim.
 */
export interface EventSet {
  /** alias: `field` ∈ entity aliases · window: `occurred_at` ∈ [start,end] · link: `events[].entity_ids`. */
  by: 'alias' | 'window' | 'link';
  /** by:"alias" — event field matched against the entity's alias array. */
  field?: string;
  against?: 'aliases';
  /** by:"window" — entity property names bounding the time window. */
  start?: string;
  end?: string;
  /** by:"window" — forbid an event attaching to more than one entity. */
  cardinality?: 'one_per_event';
  /** Raw SQL predicate scoping the grain. */
  where?: string;
  /** Temporal truth to read. Default `"current"` (current_event_records). */
  reads?: MetricReadMode;
  /** Same-source identity: DISTINCT over this SQL-expression tuple, applied before aggregate. */
  dedupeKey?: string[];
  /** Cross-source identity — deferred (see {@link FactMatchRule}). */
  factIdentity?: FactMatchRule;
}

/** A governed aggregation bound to a named {@link EventSet} grain. */
export interface Measure {
  /** Name of the {@link EventSet} (on this entity) this measure aggregates over. */
  eventSet: string;
  agg: 'sum' | 'count' | 'min' | 'max' | 'count_distinct';
  /** SQL expression to aggregate. Required for every `agg` except `count` (validated at apply). */
  expr?: string;
  /** Extra raw-SQL predicate applied to this measure only. */
  where?: string;
  /** Names of {@link Segment}s (on this entity) to AND in, each applied per its `appliedBefore`. */
  segments?: string[];
  /** Dimensions safe to group WITH this measure; omitted ⇒ unknown (the compiler treats conservatively). */
  safeDimensions?: string[];
  /** REQUIRED — powers keyword discovery in the metric catalog. */
  description: string;
  owner?: string;
  tier?: MetricTier;
}

/** A governed group-by. */
export interface Dimension {
  expr: string;
  description: string;
}

/** A reusable named population filter (Anthropic "segment"). */
export interface Segment {
  description: string;
  /** Raw SQL predicate. */
  where: string;
  /** Grain the filter applies at. */
  on: 'event' | 'entity';
  /** Ordering relative to dedupe. Default `"aggregate"`. */
  appliedBefore?: 'dedupe' | 'aggregate';
}

/**
 * The declared metric contract for one entity type — the shape persisted in
 * `entity_types.metrics_config`. Mirrors the metric fields on the CLI's
 * `EntityType`; the apply path threads it through and the compiler reads it.
 */
export interface EntityMetrics {
  eventSets?: Record<string, EventSet>;
  measures?: Record<string, Measure>;
  dimensions?: Record<string, Dimension>;
  segments?: Record<string, Segment>;
}

const AGGS = new Set(['sum', 'count', 'min', 'max', 'count_distinct']);

/**
 * Validate a declared {@link EntityMetrics} contract. Returns a list of human
 * error messages (empty ⇒ valid). Defensive about shape so it can validate
 * untyped JSON at the server boundary as well as typed config at apply time.
 *
 * Catches what TypeScript can't: name references (a measure naming a missing
 * eventSet/segment still typechecks — they're strings) and the
 * `expr`-required-except-`count` rule. Pure; no Typebox-schema duplication of
 * the structural guarantees authoring already gets from the types.
 */
export function validateEntityMetrics(metrics: unknown): string[] {
  const errors: string[] = [];
  if (metrics == null) return errors;
  if (typeof metrics !== 'object' || Array.isArray(metrics)) {
    return ['metrics must be an object'];
  }
  const m = metrics as Record<string, unknown>;
  const asRecord = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

  const eventSets = asRecord(m.eventSets);
  const segments = asRecord(m.segments);
  const measures = asRecord(m.measures);
  const dimensions = asRecord(m.dimensions);
  const eventSetNames = new Set(Object.keys(eventSets));
  const segmentNames = new Set(Object.keys(segments));

  for (const [name, raw] of Object.entries(measures)) {
    const meas = asRecord(raw);
    const agg = meas.agg;
    if (typeof agg !== 'string' || !AGGS.has(agg)) {
      errors.push(`measure "${name}": invalid agg "${String(agg)}"`);
    }
    if (agg !== 'count' && (typeof meas.expr !== 'string' || meas.expr.trim() === '')) {
      errors.push(`measure "${name}": expr is required for agg "${String(agg)}"`);
    }
    if (typeof meas.eventSet !== 'string' || !eventSetNames.has(meas.eventSet)) {
      errors.push(
        `measure "${name}": eventSet "${String(meas.eventSet)}" is not a declared eventSet`,
      );
    }
    if (typeof meas.description !== 'string' || meas.description.trim() === '') {
      errors.push(`measure "${name}": description is required`);
    }
    const segs = meas.segments;
    if (segs !== undefined) {
      if (!Array.isArray(segs)) {
        errors.push(`measure "${name}": segments must be an array`);
      } else {
        for (const s of segs) {
          if (typeof s !== 'string' || !segmentNames.has(s)) {
            errors.push(`measure "${name}": segment "${String(s)}" is not a declared segment`);
          }
        }
      }
    }
  }

  for (const [name, raw] of Object.entries(dimensions)) {
    const dim = asRecord(raw);
    if (typeof dim.expr !== 'string' || dim.expr.trim() === '') {
      errors.push(`dimension "${name}": expr is required`);
    }
    if (typeof dim.description !== 'string' || dim.description.trim() === '') {
      errors.push(`dimension "${name}": description is required`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Federation (warehouse metrics contributed by a connector via reflectMetrics)
// ---------------------------------------------------------------------------

/**
 * Governance descriptor for a reflected measure column. The warehouse's own
 * semantic view already aggregates the column, so this carries DECLARATION
 * (which output columns are measures) + governance, not an aggregation.
 */
export interface ReflectedMeasure {
  description: string;
  tier?: MetricTier;
  owner?: string;
  /** Native grain, e.g. "order" vs "order_line" — a drift signal. */
  grain: string;
  /** Dimensions safe to group WITH this measure (else fan-out double-counting). */
  safeDimensions?: string[];
}

/**
 * An entity type a connector contributes by FEDERATING a warehouse's own
 * governed metric (Snowflake `SEMANTIC_VIEW()` / dbt / Cube). The `backing.sql`
 * runs LIVE against the connection via the connector's live-query path; Lobu
 * stores a thin pointer + governance and never re-authors the metric.
 */
export interface EntityTypeContribution {
  key: string;
  name?: string;
  description?: string;
  /** Read-only SQL over the warehouse, run live through this connection slug. */
  backing: { sql: string; connection: string };
  /** Native refresh cadence of the underlying view — a drift signal. */
  freshness?: string;
  /** DECLARES which output columns are measures, plus their governance. */
  measures: Record<string, ReflectedMeasure>;
  /** Output columns that are dimensions, plus their descriptions. */
  dimensions?: Record<string, { description: string }>;
}
