import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ValidationError } from './errors.ts';
import { getActiveSession } from './openclaw-auth.ts';

export interface ProfileConfig {
  url?: string;
  apiUrl?: string;
  mcpUrl?: string;
  envFile?: string;
  [key: string]: unknown;
}

interface OwlettoConfig {
  profiles: Record<string, ProfileConfig>;
}

export interface ResolvedProfile {
  name: string;
  config: ProfileConfig;
  configPath: string | null;
}

const DEFAULT_PROFILE: ProfileConfig = {
  url: 'http://localhost:8787/mcp',
};

function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const envVal = process.env[key];
    if (envVal === undefined) {
      throw new ValidationError(`Environment variable "${key}" is not set (referenced in config)`);
    }
    return envVal;
  });
}

function interpolateProfile(profile: ProfileConfig): ProfileConfig {
  const result: ProfileConfig = {};
  for (const [key, value] of Object.entries(profile)) {
    result[key] = typeof value === 'string' ? interpolateEnv(value) : value;
  }
  return result;
}

export function findConfigFile(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = resolve(dir, 'owletto.config.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadConfig(configPath: string): OwlettoConfig {
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as OwlettoConfig;
  if (!parsed.profiles || typeof parsed.profiles !== 'object') {
    throw new ValidationError(`Invalid config: "profiles" object required in ${configPath}`);
  }
  return parsed;
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

  const config = loadConfig(configPath);
  const profileNames = Object.keys(config.profiles);

  if (profileNames.length === 0) {
    throw new ValidationError(`No profiles defined in ${configPath}`);
  }

  const name = requestedName ?? profileNames[0]!;
  const raw = config.profiles[name];

  if (!raw) {
    throw new ValidationError(`Profile "${name}" not found. Available: ${profileNames.join(', ')}`);
  }

  return {
    name,
    config: interpolateProfile(raw),
    configPath,
  };
}
