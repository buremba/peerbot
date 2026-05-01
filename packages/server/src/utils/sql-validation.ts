/**
 * SQL validation helpers for values that must be safely interpolated into SQL
 * (e.g. inside CTE LIMIT clauses, IN (...) lists, or other positions where
 * `pg`/`postgres` bind parameters are awkward). Prefer parameter binding when
 * possible; these validators are a defense-in-depth layer for the rest.
 */

/**
 * Validate and format an array of IDs for safe SQL usage.
 * Ensures all values are valid non-negative integers to prevent SQL injection.
 * @throws Error if any value is not a valid non-negative integer
 */
export function validateAndFormatIds(ids: number[], fieldName: string): string {
  if (!ids || ids.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array`);
  }
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 0) {
      throw new Error(`Invalid ${fieldName}: ${id} is not a valid positive integer`);
    }
  }
  return ids.join(',');
}

/**
 * Validate a single numeric ID for safe SQL usage.
 * @throws Error if value is not a valid non-negative integer
 */
export function validateNumericId(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${fieldName}: ${value} is not a valid positive integer`);
  }
  return value;
}
