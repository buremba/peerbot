/**
 * Stable Keys Utility
 *
 * Computes deterministic entity keys for merging entities across windows.
 * Keys are computed by slugifying and concatenating specified fields.
 *
 * Example: For a problem with category="Stability" and name="App Crashes",
 * the computed key would be "stability::app-crashes"
 */

import type { KeyingConfig } from '../types/watchers';

/**
 * Slugify a string for use in stable keys.
 * Converts to lowercase, replaces spaces/special chars with hyphens.
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
 * Get a nested value from an object using a dot-notation path.
 * Example: getPath({a: {b: 1}}, 'a.b') returns 1
 */
function getPath(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;

  return path.split('.').reduce((acc, key) => {
    if (acc && typeof acc === 'object' && key in acc) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj as unknown);
}

/**
 * Compute stable keys for entities in extracted data.
 *
 * This function mutates the input data, adding a computed key field
 * to each entity in the specified array.
 *
 * @param data - The extracted_data object from LLM output
 * @param config - Keying configuration from template
 *
 * @example
 * // Input data:
 * { problems: [{ category: "Stability", name: "App Crashes" }] }
 *
 * // With config:
 * { entity_path: "problems", key_fields: ["category", "name"], key_output_field: "problem_key" }
 *
 * // Output (mutated):
 * { problems: [{ category: "Stability", name: "App Crashes", problem_key: "stability::app-crashes" }] }
 */
export function computeStableKeys(data: Record<string, unknown>, config: KeyingConfig): void {
  const entities = getPath(data, config.entity_path);

  if (!Array.isArray(entities)) {
    // No entities to process, or path doesn't resolve to an array
    return;
  }

  for (const entity of entities) {
    if (!entity || typeof entity !== 'object') continue;

    const entityRecord = entity as Record<string, unknown>;

    // Build key from specified fields
    const keyParts = config.key_fields.map((field) => {
      const value = entityRecord[field];
      if (value === null || value === undefined) return '';
      return slugify(String(value));
    });

    // Join with :: separator (e.g., "stability::app-crashes")
    entityRecord[config.key_output_field] = keyParts.join('::');
  }
}
