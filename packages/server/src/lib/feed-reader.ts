/**
 * FeedReader — the ONE read-path contract for every feed/recall source.
 *
 * The access-graph ACL gate ({@link AuthzScope}) is a REQUIRED, typed argument of
 * `read`, not a field a reader may forget to thread through a loose context. A
 * new reader literally cannot compile without accepting the gate, so it cannot
 * silently leak across users — the gate is a contract, not a convention.
 *
 * `Ctx` carries only the NON-gate inputs (query text, limits, env, feed id …);
 * the tenant + principal + agent identity always arrive via `gate`.
 */

import type { AuthzScope } from '../authz/scope';

export interface FeedReader<Ctx, Out> {
  /** Stable identifier for the reader (its recall kind / feed kind). */
  readonly kind: string;
  /**
   * Run the read under `gate`. The gate is the FIRST argument on purpose: it is
   * the ACL boundary every reader must compile its scoping predicate from, and
   * keeping it out of `ctx` makes "did this reader consult the gate?" a
   * type-checked question rather than a code-review one.
   */
  read(gate: AuthzScope, ctx: Ctx): Promise<Out>;
}
