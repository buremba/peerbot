import { ConfigError } from "../errors";

/**
 * Get required environment variable
 * Throws ConfigError if not set
 */
export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Get optional environment variable with default
 */
export function getOptionalEnv(name: string, defaultValue: string): string;
export function getOptionalEnv(
  name: string,
  defaultValue?: string
): string | undefined;
export function getOptionalEnv(
  name: string,
  defaultValue?: string
): string | undefined {
  return process.env[name] || defaultValue;
}

/**
 * Get optional number environment variable with default
 * Throws ConfigError if value is not a valid number
 */
export function getOptionalNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  // Use Number() not parseInt(): parseInt silently accepts trailing garbage
  // ("100ms" -> 100, "3.5" -> 3), so a typo'd env value would pass instead of
  // failing loud.
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(
      `Invalid number for ${name}: ${value} (expected integer)`
    );
  }
  return parsed;
}

/**
 * Get optional boolean environment variable with default
 * Accepts "true", "1", "yes" as truthy values
 */
export function getOptionalBoolean(
  name: string,
  defaultValue: boolean
): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  const lower = value.toLowerCase();
  return lower === "true" || lower === "1" || lower === "yes";
}
