/**
 * JSON Schema validation for watcher extraction
 */

/**
 * Validates a JSON Schema
 * @param schema JSON Schema to validate
 * @returns Validation error message or null if valid
 */
export function validateExtractionSchema(schema: any): string | null {
  if (!schema || typeof schema !== 'object') {
    return 'Schema must be a valid JSON object';
  }

  if (!schema.type) {
    return 'Schema must have a "type" property';
  }

  if (schema.type !== 'object') {
    return 'Schema type must be "object" (root level must be an object)';
  }

  if (!schema.properties || typeof schema.properties !== 'object') {
    return 'Schema must have a "properties" object defining the fields to extract';
  }

  return null;
}

/**
 * Validates that classifier source_paths reference fields defined in the extraction schema.
 * This prevents source_path mismatches like `$.top_problems[*]` when schema has `problems`.
 *
 * @param classifiers Array of classifier definitions with source_path
 * @param extractionSchema JSON Schema defining the LLM output structure
 * @returns Error message if validation fails, null if valid
 */
export function validateClassifierSourcePaths(
  classifiers: Array<{ slug: string; source_path?: string }> | undefined,
  extractionSchema: any
): string | null {
  if (!classifiers || !Array.isArray(classifiers) || classifiers.length === 0) {
    return null; // No classifiers to validate
  }

  if (!extractionSchema?.properties) {
    return null; // No schema to validate against
  }

  const schemaFields = new Set(Object.keys(extractionSchema.properties));
  const mismatches: string[] = [];

  for (const classifier of classifiers) {
    if (!classifier.source_path) continue;

    // Extract root field from JSONPath like "$.problems[*]" -> "problems"
    const match = classifier.source_path.match(/^\$\.([a-zA-Z_][a-zA-Z0-9_]*)/);
    if (!match) continue;

    const rootField = match[1];
    if (!schemaFields.has(rootField)) {
      mismatches.push(
        `Classifier "${classifier.slug}" has source_path "${classifier.source_path}" ` +
          `but extraction_schema has no field "${rootField}". ` +
          `Available fields: [${Array.from(schemaFields).join(', ')}]`
      );
    }
  }

  if (mismatches.length > 0) {
    return mismatches.join('\n');
  }

  return null;
}
