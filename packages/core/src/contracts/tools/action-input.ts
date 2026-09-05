/**
 * The input a caller supplies for one action of a union-shaped tool contract:
 * that action's variant, minus the `action` discriminator the SDK method fills
 * in itself.
 *
 * Each contract exports its per-action inputs through this (`FeedCreateInput`,
 * `ScheduleUpdateInput`, …) and every typed caller — the ClientSDK sandbox
 * namespaces, the published connector SDK — imports those names rather than
 * restating the fields. A hand-written copy drifts in the direction that hurts
 * most: a field the schema accepts but the copy omits is invisible to every
 * typed caller. `catalog.listInstalled` had exactly that gap — the action
 * schema and the method's own documented signature both carried
 * `include_catalog`, the copied input type did not, so no typed caller could
 * pass it.
 *
 * `Action` is constrained to the contract's own action names, so a typo fails
 * at the declaration rather than producing a type nothing can satisfy.
 *
 * Only for contracts whose input schema is a `Type.Union` of per-action
 * variants, each carrying a single-literal `action`. A flat `Type.Object`
 * contract has nothing to `Extract` — its `action` is a union-typed field, not
 * a discriminator.
 */
export type ActionInput<
  Args extends { action: string },
  Action extends Args["action"],
> = Omit<Extract<Args, { action: Action }>, "action">;
