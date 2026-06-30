/**
 * FeedReader — the read contract for the recall registry (`RECALL_SOURCES` in
 * search.ts). It is the ONE shape every recall source implements; the registry
 * fans out over readers without branching on kind. (Other feed read seams like
 * `readVirtualFeed`/`runConnectorQuery` take the same `AuthzScope` gate directly
 * but are single functions, not registry members, so they don't implement this.)
 *
 * The access-graph ACL gate ({@link AuthzScope}) is a REQUIRED, typed argument of
 * `read`, threaded by the registry to every reader — it is never buried in a
 * loose context where a call site could quietly drop it. What the type
 * guarantees: a reader must ACCEPT the gate, and `gatherRecall` cannot invoke a
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

export interface FeedReader<Ctx, Out> {
  /** Stable identifier for the reader (its recall kind / feed kind). */
  readonly kind: string;
  /**
   * Run the read under `gate`. The gate is the first argument on purpose: it is
   * the ACL boundary every reader compiles its scoping predicate from, and
   * keeping it out of `ctx` makes the gate impossible to omit at the call site.
   * (TypeScript enforces that the gate is supplied, not that the body consults
   * it — the per-source ACL tests cover that.)
   */
  read(gate: AuthzScope, ctx: Ctx): Promise<Out>;
}
