/**
 * User-level config loader for the embedded server.
 *
 * Reads `~/.config/lobu/config.json` (owned by the CLI's
 * `packages/cli/src/internal/context.ts`) and returns the current context's
 * `server` block. The Mac app writes this file to point a stable local server
 * at a brew-managed Postgres without per-project `.env` plumbing.
 *
 * Sync on purpose — start-local.ts reads env at module-load time, so this has
 * to resolve before the first env read. Cost is one ~1KB JSON file per boot.
 *
 * Schema is duplicated from the CLI's `LobuServerConfig` rather than imported
 * to keep `@lobu/server` free of a `@lobu/cli` dependency.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface UserServerConfig {
  databaseUrl?: string;
  port?: number;
  host?: string;
  dataDir?: string;
}

interface StoredEntry {
  apiUrl?: unknown;
  server?: unknown;
}

interface StoredConfig {
  currentContext?: unknown;
  contexts?: Record<string, StoredEntry>;
}

const CONFIG_PATH = join(homedir(), '.config', 'lobu', 'config.json');

export function loadUserServerConfig(
  configPath: string = CONFIG_PATH,
  contextOverride?: string
): UserServerConfig | undefined {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return undefined;
  }

  let parsed: StoredConfig;
  try {
    parsed = JSON.parse(raw) as StoredConfig;
  } catch {
    return undefined;
  }

  const contextName =
    contextOverride?.trim() ||
    (typeof parsed.currentContext === 'string' && parsed.currentContext.trim()) ||
    'lobu';
  const entry = parsed.contexts?.[contextName];
  if (!entry) return undefined;

  return normalizeServerConfig(entry.server);
}

function normalizeServerConfig(raw: unknown): UserServerConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const src = raw as Record<string, unknown>;
  const out: UserServerConfig = {};

  if (typeof src.databaseUrl === 'string' && src.databaseUrl.trim()) {
    out.databaseUrl = src.databaseUrl.trim();
  }
  if (typeof src.port === 'number' && Number.isInteger(src.port) && src.port > 0) {
    out.port = src.port;
  }
  if (typeof src.host === 'string' && src.host.trim()) {
    out.host = src.host.trim();
  }
  if (typeof src.dataDir === 'string' && src.dataDir.trim()) {
    out.dataDir = src.dataDir.trim();
  }

  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Fill missing env vars from the user config. Env wins; we never overwrite a
 * value the operator already set.
 */
export function applyUserServerConfigToEnv(
  configPath?: string,
  contextOverride?: string
): UserServerConfig | undefined {
  const cfg = loadUserServerConfig(configPath, contextOverride ?? process.env.LOBU_CONTEXT);
  if (!cfg) return undefined;

  if (cfg.databaseUrl && !process.env.DATABASE_URL?.trim()) {
    process.env.DATABASE_URL = cfg.databaseUrl;
  }
  if (cfg.port && !process.env.PORT?.trim()) {
    process.env.PORT = String(cfg.port);
  }
  if (cfg.host && !process.env.HOST?.trim()) {
    process.env.HOST = cfg.host;
  }
  if (cfg.dataDir && !process.env.LOBU_DATA_DIR?.trim()) {
    process.env.LOBU_DATA_DIR = cfg.dataDir;
  }

  return cfg;
}
