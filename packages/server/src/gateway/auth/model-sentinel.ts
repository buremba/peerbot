/**
 * Restriction-sentinel helpers, in their own module to avoid an import cycle
 * between `provider-catalog` (dispatch resolution) and
 * `settings/model-selection` (allow-list enforcement) — both need these.
 */

/**
 * Model suffix used by the migration/provisioning to keep a RESTRICTED agent
 * closed when no concrete model could be resolved for a declared provider. A
 * `<slug>/__unresolved__` (or `legacy/__unresolved__`) ref is NEVER routable:
 * it exists only to keep `models` non-empty (not allow-all) so the exact gate
 * stays closed until an operator picks a real model.
 */
export const UNRESOLVED_MODEL_SUFFIX = "__unresolved__";

/** True when a model ref is an unresolved restriction sentinel (never routes). */
export function isUnresolvedModelRef(ref: string): boolean {
  const slash = ref.indexOf("/");
  return slash > 0 && ref.slice(slash + 1) === UNRESOLVED_MODEL_SUFFIX;
}
