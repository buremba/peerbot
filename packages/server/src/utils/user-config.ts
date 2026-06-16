/**
 * User-level config loader for the embedded server.
 *
 * Reads `~/.config/lobu/config.json` (owned by the CLI's
 * `packages/cli/src/internal/context.ts`) and returns the current context's
 * managed-server launch settings. The Mac app writes this file so a stable
 * local server can be started for a selected context without per-project `.env`
 * plumbing.
 *
 * Sync on purpose — embedded-runtime.ts reads env at module-load time, so this has
 * to resolve before the first env read. Cost is one ~1KB JSON file per boot.
 *
 * Schema is duplicated from the CLI's context loader rather than imported to
 * keep `@lobu/server` free of a `@lobu/cli` dependency.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface UserServerConfig {
  port?: number;
  host?: string;
  cwd?: string;
  /// "managed" → the Mac menubar (or another lifecycle owner) spawns
  /// `lobu run` for this context. "external" → just connect; never
  /// spawn or kill. Absent → infer only at the lifecycle owner.
  lifecycle?: "managed" | "external";
}

interface StoredEntry {
  url?: unknown;
  apiUrl?: unknown;
  lifecycle?: unknown;
  cwd?: unknown;
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

  return deriveManagedServerConfig(entry);
}

function deriveManagedServerConfig(entry: StoredEntry): UserServerConfig | undefined {
  const lifecycle = normalizeLifecycle(entry.lifecycle) ?? normalizeLegacyLifecycle(entry.server);
  if (lifecycle !== 'managed') return undefined;

  const rawUrl = normalizeString(entry.url) ?? normalizeString(entry.apiUrl);
  const out: UserServerConfig = { lifecycle };
  const cwd = normalizeString(entry.cwd) ?? normalizeLegacyCwd(entry.server);
  if (cwd) out.cwd = cwd;

  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      // An explicit `:port` wins; otherwise fall back to the protocol default
      // (80 for http, 443 for https) so a scheme-only context URL like
      // `https://example.com/api/v1` doesn't drop the implied port.
      const port = parsed.port
        ? Number.parseInt(parsed.port, 10)
        : parsed.protocol === 'http:'
          ? 80
          : parsed.protocol === 'https:'
            ? 443
            : undefined;
      if (port && Number.isInteger(port) && port > 0 && port <= 65535) {
        out.port = port;
      }
      // `new URL("http://[::1]:8787").hostname` keeps the brackets, which
      // Node's `httpServer.listen({ host })` rejects with ENOTFOUND — strip
      // them before exporting HOST.
      const host = parsed.hostname.replace(/^\[|\]$/g, '');
      if (host) out.host = host;
    } catch {
      // Ignore malformed hand-edited URLs; context validation lives in the CLI.
    }
  }

  return Object.keys(out).length === 0 ? undefined : out;
}

function normalizeLegacyLifecycle(raw: unknown): "managed" | "external" | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return normalizeLifecycle((raw as Record<string, unknown>).lifecycle);
}

function normalizeLegacyCwd(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return normalizeString((raw as Record<string, unknown>).cwd);
}

function normalizeLifecycle(value: unknown): "managed" | "external" | undefined {
  return value === 'managed' || value === 'external' ? value : undefined;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

  if (cfg.port && !process.env.PORT?.trim()) {
    process.env.PORT = String(cfg.port);
  }
  if (cfg.host && !process.env.HOST?.trim()) {
    process.env.HOST = cfg.host;
  }

  return cfg;
}
