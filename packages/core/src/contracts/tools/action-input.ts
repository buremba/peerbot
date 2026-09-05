/**
 * The input a caller supplies for one action of a union-shaped tool contract:
 * that action's variant, minus the `action` discriminator the SDK method fills
 * in itself.
 *
 * The ClientSDK sandbox namespaces derive their per-method input types through
 * this instead of restating the fields, because a hand-written copy drifts in
 * the direction that hurts most: a field the schema accepts but the copy omits
 * is invisible to every typed caller. `catalog.listInstalled` had exactly that
 * gap — the action schema and the method's own documented signature both
 * carried `include_catalog`, the copied input type did not, so no typed caller
 * could pass it.
 *
 * Only for contracts whose input schema is a `Type.Union` of per-action
 * variants. A flat `Type.Object` contract has nothing to `Extract` — its
 * `action` is a union-typed field, not a discriminator.
 */
export type ActionInput<Args, Action extends string> = Omit<
  Extract<Args, { action: Action }>,
  "action"
>;
