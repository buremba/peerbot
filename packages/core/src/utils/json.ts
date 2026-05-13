import { createLogger } from "../logger";

const logger = createLogger("json-utils");

/**
 * Safely parse JSON string
 * Returns null on parse failure instead of throwing
 */
export function safeJsonParse<T = unknown>(
  data: string,
  fallback: T | null = null
): T | null {
  try {
    return JSON.parse(data) as T;
  } catch (error) {
    logger.debug("JSON parse failed", {
      error: error instanceof Error ? error.message : String(error),
      dataPreview: data.substring(0, 100),
    });
    return fallback;
  }
}

/**
 * Stringify a value to JSON, converting bigint values to numbers (when safe)
 * or strings. Use this when serializing query results that may contain bigint columns.
 */
function stringifyBigIntSafe(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) => {
    if (typeof candidate === "bigint") {
      const numeric = Number(candidate);
      return Number.isSafeInteger(numeric) ? numeric : candidate.toString();
    }
    return candidate;
  });
}

/**
 * Round-trip a value through JSON serialization to convert bigint values
 * to plain numbers or strings. Useful for REST API responses where the value
 * must be a plain JSON-compatible object (not a string).
 */
export function toJsonSafe<T>(value: T): T {
  return JSON.parse(stringifyBigIntSafe(value)) as T;
}

/**
 * Parse a value that may be a JSON-encoded object (e.g. a jsonb column returned
 * as a string) into a plain object.  Returns `{}` when the input is falsy,
 * not valid JSON, or not a plain object.
 */
export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
