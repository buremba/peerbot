import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { lobuConfigSchema } from '@lobu/core';
import { parse as parseToml } from 'smol-toml';
import { ValidationError } from './errors.ts';
import { getActiveSession } from './openclaw-auth.ts';

export interface ProfileConfig {
  url?: string;
  apiUrl?: string;
  mcpUrl?: string;
  databaseUrl?: string;
  embeddingsUrl?: string;
  envFile?: string;
  [key: string]: unknown;
}

export interface ResolvedProfile {
  name: string;
  config: ProfileConfig;
  configPath: string | null;
}

const DEFAULT_PROFILE: ProfileConfig = {
  url: 'http://localhost:8787/mcp',
};

const CONFIG_FILENAME = 'lobu.toml';

function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const envVal = process.env[key];
    if (envVal === undefined) {
      throw new ValidationError(`Environment variable "${key}" is not set (referenced in config)`);
    }
    return envVal;
  });
}

/**
 * Map a raw TOML profile (snake_case keys) into the CLI's camelCase
 * ProfileConfig, interpolating `${ENV_VAR}` references in string values.
 */
function normalizeProfile(raw: Record<string, unknown>): ProfileConfig {
  const keyMap: Record<string, string> = {
    url: 'url',
    api_url: 'apiUrl',
    mcp_url: 'mcpUrl',
    database_url: 'databaseUrl',
    embeddings_url: 'embeddingsUrl',
    env_file: 'envFile',
  };
  const result: ProfileConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    const mapped = keyMap[key] ?? key;
    result[mapped] = typeof value === 'string' ? interpolateEnv(value) : value;
  }
  return result;
}

export function findConfigFile(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = resolve(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadProfiles(configPath: string): Record<string, Record<string, unknown>> {
  const raw = readFileSync(configPath, 'utf-8');
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Invalid TOML syntax in ${configPath}: ${msg}`);
  }

  const result = lobuConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ValidationError(`Invalid lobu.toml schema in ${configPath}:\n${details}`);
  }

  return (result.data.owletto?.profiles ?? {}) as Record<string, Record<string, unknown>>;
}

export function resolveProfile(
  profileFlag: string | undefined,
  contextName: string | null
): ResolvedProfile {
  const configPath = findConfigFile();

  // Resolution priority:
  // 1. --profile flag
  // 2. OWLETTO_PROFILE env var
  // 3. contextName (from project-local or global context file)
  // 4. First profile in config
  // 5. Built-in defaults (or active session)
  const requestedName = profileFlag ?? process.env.OWLETTO_PROFILE ?? contextName ?? null;

  if (!configPath) {
    const { session } = getActiveSession();
    if (session?.mcpUrl) {
      return {
        name: requestedName ?? 'default',
        config: { url: session.mcpUrl },
        configPath: null,
      };
    }
    return {
      name: requestedName ?? 'default',
      config: DEFAULT_PROFILE,
      configPath: null,
    };
  }

  const profiles = loadProfiles(configPath);
  const profileNames = Object.keys(profiles);

  if (profileNames.length === 0) {
    const { session } = getActiveSession();
    if (session?.mcpUrl) {
      return {
        name: requestedName ?? 'default',
        config: { url: session.mcpUrl },
        configPath,
      };
    }
    return {
      name: requestedName ?? 'default',
      config: DEFAULT_PROFILE,
      configPath,
    };
  }

  const name = requestedName ?? profileNames[0]!;
  const raw = profiles[name];

  if (!raw) {
    throw new ValidationError(
      `Profile "${name}" not found in [owletto.profiles] of ${configPath}. Available: ${profileNames.join(', ')}`
    );
  }

  return {
    name,
    config: normalizeProfile(raw),
    configPath,
  };
}
