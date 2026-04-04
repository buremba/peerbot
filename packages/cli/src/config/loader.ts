import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { type LobuTomlConfig, lobuConfigSchema } from "./schema.js";

export const CONFIG_FILENAME = "lobu.toml";

export interface LoadResult {
  config: LobuTomlConfig;
  path: string;
}

export interface LoadError {
  error: string;
  details?: string[];
}

/**
 * Load and validate lobu.toml from a directory.
 */
export async function loadConfig(cwd: string): Promise<LoadResult | LoadError> {
  const configPath = join(cwd, CONFIG_FILENAME);

  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    return {
      error: `No ${CONFIG_FILENAME} found in ${cwd}`,
      details: ["Run `lobu init` to create one."],
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    return {
      error: `Invalid TOML syntax in ${CONFIG_FILENAME}`,
      details: [err instanceof Error ? err.message : String(err)],
    };
  }

  const result = lobuConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`
    );
    return { error: `Invalid ${CONFIG_FILENAME}`, details };
  }

  return { config: result.data, path: configPath };
}

export function isLoadError(
  result: LoadResult | LoadError
): result is LoadError {
  return "error" in result;
}
