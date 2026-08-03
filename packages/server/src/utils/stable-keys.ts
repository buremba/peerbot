/**
 * Stable Keys Utility
 *
 * Computes deterministic entity keys for merging entities across windows.
 * Keys are computed by slugifying and concatenating specified fields.
 *
 * Example: For a problem with category="Stability" and name="App Crashes",
 * the computed key would be "stability::app-crashes"
 */

/**
 * Slugify a string for use in stable keys.
 *
 * NOTE: This is intentionally NOT the shared `generateSlug`. Stable keys are
 * persisted and used to merge entities across windows, so its output must stay
 * byte-stable — it keeps word chars (`\w`) and converts underscores, which
 * differs from the URL-slug rules. Do not consolidate this with generateSlug.
 */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove non-word chars except spaces and hyphens
    .replace(/[\s_]+/g, '-') // Replace spaces and underscores with hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
}

/**
 * Compute one Behavior-scoped stable key without adding transport-only fields
 * to the model's output or the entity's metadata.
 */
export function computeStableKey(
  row: Record<string, unknown>,
  keyFields: readonly string[]
): string {
  return keyFields
    .map((field) => {
      const value = row[field];
      return value === null || value === undefined ? '' : slugify(String(value));
    })
    .join('::');
}
