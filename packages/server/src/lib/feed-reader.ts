/**
 * FeedReader — the read contract behind the feed registry. A feed is described by
 * two orthogonal axes (see `docs/plans/feeds-and-connections-model.md`):
 *   - {@link SourceKind}: WHERE the bytes live (chat transcript / live external
 *     dataset / collected events).
 *   - {@link LensKind}: HOW the caller wants to read them (recall / metric /
 *     raw-sql).
 * A reader owns exactly one `(source, lens)` tuple and is dispatched by that key,
 * with no central `switch` over kinds. `canRead` lets a reader decline a ctx it
 * can't serve (e.g. a keyword-only source with no query text) so the registry
 * skips it BRANCH-FREE — the caller never special-cases a kind.
 *
 * Today the registry is realized for the `recall` lens only (`RECALL_SOURCES` in
 * search.ts); the metric / raw-sql lenses and the live-pushdown path remain
 * separate functions. Folding them under one tuple-dispatched registry is the
 * consolidation target the doc describes — this shape was chosen so that
 * promotion is additive.
 *
 * The access-graph ACL gate ({@link AuthzScope}) is a REQUIRED, typed argument of
 * `read`, threaded by the registry to every reader — it is never buried in a
 * loose context where a call site could quietly drop it. What the type
 * guarantees: a reader must ACCEPT the gate, and the registry cannot invoke a
 * reader without supplying one. What the type does NOT guarantee: that a reader
 * actually applies the gate to its query predicate — TypeScript can't see inside
 * the body. That last mile is held by the per-source ACL tests (search-channel /
 * content-visibility / pushdown), which assert real rows are denied to a
 * non-member.
 *
 * `Ctx` carries only the NON-gate inputs (query text, limits, env, feed id …);
 * the tenant + principal + agent identity always arrive via `gate`.
 */

import type { AuthzScope } from '../authz/scope';

/** Axis 1 — where a feed's bytes live. Keep in sync with the model doc's table. */
export type SourceKind = 'chat-channel' | 'virtual-live-dataset' | 'collected';

/** Axis 2 — how the caller reads a feed. Any lens over any source kind. */
export type LensKind = 'recall' | 'metric' | 'raw-sql';

export interface FeedReader<
  S extends SourceKind,
  L extends LensKind,
  Ctx,
  Out,
> {
  /** WHERE the bytes live — one of the source-kind axis values. */
  readonly source: S;
  /** HOW the caller reads them — one of the lens-kind axis values. */
  readonly lens: L;
  /**
   * Whether this reader can serve `ctx`. Lets the registry skip a reader that
   * has no work to do (missing query text, wrong signal) WITHOUT the caller
   * branching on the reader's kind. Return `true` to always attempt `read`.
   */
  canRead(ctx: Ctx): boolean;
  /**
   * Run the read under `gate`. The gate is the first argument on purpose: it is
   * the ACL boundary every reader compiles its scoping predicate from, and
   * keeping it out of `ctx` makes the gate impossible to omit at the call site.
   * (TypeScript enforces that the gate is supplied, not that the body consults
   * it — the per-source ACL tests cover that.)
   */
  read(gate: AuthzScope, ctx: Ctx): Promise<Out>;
}
