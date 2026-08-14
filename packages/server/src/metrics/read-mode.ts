/**
 * Read-mode resolution for declared metrics — lowers `EventSet.reads` into the
 * predicate the compiler ANDs into its events filter.
 *
 * ## What `asOf` means here
 * `{ asOf }` is a **valid-time** (event-time) cut: it answers "what do we now
 * know the state to have been on 31 March", by restricting the event set to
 * rows whose `occurred_at` is at or before the instant. That is the semantic
 * the SDK contract declares (`MetricReadMode`: "compared against `occurred_at`
 * (event time, NOT system time)").
 *
 * It is deliberately NOT a system-time ("what did we believe on 31 March")
 * read. Those differ whenever a row was later corrected: valid-time replays
 * today's corrected history, system-time replays the stale belief. System-time
 * would have to walk the supersede chain per row (`superseded_by` + the
 * superseder's `created_at`), i.e. reconstruct history on the read path — the
 * shape that must be materialized at write time, not scanned. It stays
 * unimplemented until something actually needs it.
 *
 * Consequences worth knowing, all inherent to a valid-time read:
 *  - resolution still runs through the entity's CURRENT aliases and current
 *    non-deleted set — renaming or deleting an entity changes past answers;
 *  - a superseded (corrected/tombstoned) event is masked, because the relation
 *    is still `current_event_records` (see `validateAndScopeQuery`);
 *  - backfilled rows stamped with a true past `occurred_at` correctly move a
 *    past answer.
 *
 * ## Cost
 * `asOf` adds one range predicate to the existing events filter. It strictly
 * REDUCES the rows the already-shipped `current` read scans and introduces no
 * new aggregation, join, or per-row function — so it does not change this
 * path's asymptotics, and it is not a new "aggregate history on the read path"
 * surface. See `docs/GOTCHAS.md`-adjacent note in the metric compiler header.
 */

import type { EntityMetrics, MetricReadMode } from "@lobu/connector-sdk";
import { MetricCompileError, MetricNotImplementedError } from "./errors";

/** `2026-03-31` — a whole UTC day, interpreted INCLUSIVELY (see below). */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * A full ISO-8601 instant with an EXPLICIT offset. An offset-less
 * `2026-03-31T00:00:00` is rejected on purpose: Postgres would resolve it in
 * the session timezone, so the same config would answer differently on two
 * replicas.
 */
const INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** The SQL column an `asOf` cut compares against. */
const AS_OF_COLUMN = "occurred_at";

/**
 * Lower `reads` into a SQL predicate over the events relation, or `null` when
 * the mode adds no predicate (`"current"`).
 *
 * Emits a literal rather than a bind parameter because the compiler hands a
 * finished SQL string to `validateAndScopeQuery`, which owns the parameter
 * list. Safe because the value is matched against {@link DATE_ONLY} /
 * {@link INSTANT} first — neither admits a quote, backslash, or comment.
 *
 * @param label eventSet name, for error messages.
 */
export function compileReadModePredicate(
  reads: MetricReadMode | undefined,
  label: string,
): string | null {
  const mode = reads ?? "current";
  if (mode === "current") return null;
  if (mode === "raw") {
    // `validateAndScopeQuery` rewrites `events` → `current_event_records`
    // unconditionally, so the compiler cannot express "include superseded
    // rows" today. Honouring `raw` needs a second scoped relation, not a
    // predicate.
    throw new MetricNotImplementedError(
      `eventSet "${label}": reads mode "raw" is not implemented (the scoped relation always masks superseded rows)`,
    );
  }
  if (typeof mode !== "object" || typeof mode.asOf !== "string") {
    throw new MetricCompileError(
      `eventSet "${label}": unsupported reads mode ${JSON.stringify(mode)}`,
    );
  }
  const bound = asOfBound(mode.asOf, label);
  // `'…'::timestamptz`, not `TIMESTAMPTZ '…'`: the compiled SQL is re-parsed by
  // @polyglot-sql/sdk in `validateAndScopeQuery` for table extraction, and that
  // parser rejects the typed-literal spelling. This is also the cast form the
  // events CTE already uses.
  return `${AS_OF_COLUMN} ${bound.op} '${bound.literal}'::timestamptz`;
}

/**
 * The half-open bound an `asOf` string denotes.
 *
 * A date-only `2026-03-31` means "the state at the END of 31 March" — the
 * reading a human means by "the balance on 31 March". Taking it literally as
 * `<= 2026-03-31T00:00:00Z` would silently drop that whole day, so it lowers
 * to `< 2026-04-01T00:00:00Z` instead. An explicit instant is taken at face
 * value and compared inclusively.
 */
function asOfBound(asOf: string, label: string): { op: "<" | "<="; literal: string } {
  if (DATE_ONLY.test(asOf)) {
    const start = Date.parse(`${asOf}T00:00:00Z`);
    if (Number.isNaN(start)) {
      throw new MetricCompileError(`eventSet "${label}": asOf "${asOf}" is not a real date`);
    }
    const next = new Date(start + 24 * 60 * 60 * 1000).toISOString();
    return { op: "<", literal: next };
  }
  if (INSTANT.test(asOf) && !Number.isNaN(Date.parse(asOf))) {
    return { op: "<=", literal: asOf };
  }
  throw new MetricCompileError(
    `eventSet "${label}": asOf "${asOf}" must be an ISO-8601 date (YYYY-MM-DD, read as end of that UTC day) or an instant with an explicit offset (2026-03-31T23:59:59Z)`,
  );
}

/**
 * Apply-time validation of every declared `reads` mode, so a bad `asOf` fails
 * at `lobu apply` instead of at the first query. Returns human messages;
 * empty ⇒ valid. Mirrors `validateEntityMetrics`' contract.
 */
export function validateMetricReadModes(metrics: unknown): string[] {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return [];
  const eventSets = (metrics as EntityMetrics).eventSets;
  if (!eventSets || typeof eventSets !== "object") return [];
  const errors: string[] = [];
  for (const [name, eventSet] of Object.entries(eventSets)) {
    if (!eventSet || typeof eventSet !== "object") continue;
    try {
      compileReadModePredicate(eventSet.reads, name);
    } catch (error) {
      // A NotImplemented mode is a valid declaration the compiler can't serve
      // yet; rejecting it at apply would strand configs that only READ other
      // measures. Only malformed declarations are apply-time errors.
      if (error instanceof MetricNotImplementedError) continue;
      if (error instanceof MetricCompileError) {
        errors.push(error.message);
        continue;
      }
      throw error;
    }
  }
  return errors;
}
