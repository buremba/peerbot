/**
 * Cloud credential resolver for the managed-connector runtime token fetch.
 *
 * A LOCAL Lobu instance with a `managedBy` connection fetches a fresh access
 * token for the user's cloud connection via POST /oauth/connection-token. That
 * call needs a cloud credential carrying the `connections:token` scope.
 *
 * The credential is the USER's OWN device-login — the SAME credential `lobu`
 * itself uses, stored at `~/.config/lobu/credentials.json` by the CLI's
 * `lobu login` (`packages/cli/src/internal/credentials.ts`). The login token
 * carries `connections:token` (granted at login; see auth/oauth/scopes.ts), so
 * the local resolver reuses it directly — no separate PAT to mint.
 *
 * Schema is duplicated from the CLI's credentials/context loaders rather than
 * imported to keep `@lobu/server` free of a `@lobu/cli` dependency (same policy
 * as utils/user-config.ts). The refresh request mirrors the CLI's
 * `refreshTokens` (JSON body to the issuer's token endpoint) and writes the
 * rotated tokens back so the CLI and the server stay in sync.
 *
 * Headless / CI fallback: when there is no stored login credential, fall back
 * to the instance-configured `LOBU_CLOUD_PAT` + `LOBU_CLOUD_URL` env.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import logger from '../utils/logger';

/**
 * The Lobu config dir (`~/.config/lobu` by default). `LOBU_CONFIG_DIR` overrides
 * it — the CLI uses `~/.config/lobu` directly, but a server-side override lets
 * isolated tests (and a relocated config) point at a throwaway dir instead of
 * the developer's real login.
 */
function configDir(): string {
  const override = process.env.LOBU_CONFIG_DIR?.trim();
  return override || join(homedir(), '.config', 'lobu');
}
const DEFAULT_CONTEXT_NAME = 'lobu';

const credentialsPath = () => join(configDir(), 'credentials.json');
const contextConfigPath = () => join(configDir(), 'config.json');

/** Refresh the login token when it expires within this window. */
const REFRESH_BUFFER_MS = 60_000;

/**
 * A resolved cloud credential: the bearer token to send to the cloud and the
 * cloud's base origin (no trailing path) the token-fetch endpoint lives under.
 */
export interface CloudCredential {
  /** Bearer token (`Bearer <token>`) — a login access token, or LOBU_CLOUD_PAT. */
  token: string;
  /** Cloud base origin, e.g. `https://app.lobu.ai` (no `/api/v1`, no trailing slash). */
  baseUrl: string;
}

// ----- credentials.json (mirrors packages/cli/src/internal/credentials.ts) ---

interface StoredOAuthClientInfo {
  clientId?: unknown;
  clientSecret?: unknown;
  tokenEndpoint?: unknown;
}

interface StoredCredentials {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  oauth?: StoredOAuthClientInfo;
}

interface StoredCredentialsStore {
  version?: unknown;
  contexts?: Record<string, StoredCredentials>;
}

interface NormalizedCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  oauth?: { clientId: string; clientSecret?: string; tokenEndpoint?: string };
}

// ----- config.json (context URLs; mirrors context.ts) -----------------------

interface StoredContextEntry {
  url?: unknown;
  apiUrl?: unknown;
}

interface StoredContextConfig {
  currentContext?: unknown;
  contexts?: Record<string, StoredContextEntry>;
}

/** Parse config.json once (tolerating a missing/corrupt file). */
async function loadContextConfig(): Promise<StoredContextConfig | null> {
  let raw: string;
  try {
    raw = await readFile(contextConfigPath(), 'utf-8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as StoredContextConfig;
  } catch {
    return null;
  }
}

function activeContextName(override: string | undefined, config: StoredContextConfig | null): string {
  const fromConfig =
    typeof config?.currentContext === 'string' && config.currentContext.trim()
      ? config.currentContext.trim()
      : undefined;
  return override?.trim() || process.env.LOBU_CONTEXT?.trim() || fromConfig || DEFAULT_CONTEXT_NAME;
}

/**
 * The cloud base ORIGIN for a context (the host the OAuth + connection-token
 * endpoints are mounted at the root of). The stored context URL is an API URL
 * (e.g. `https://app.lobu.ai/api/v1`); we want only its origin.
 */
function resolveContextBaseUrl(
  contextName: string,
  config: StoredContextConfig | null
): string | null {
  const entry = config?.contexts?.[contextName];
  const rawUrl =
    (typeof entry?.url === 'string' && entry.url) ||
    (typeof entry?.apiUrl === 'string' && entry.apiUrl) ||
    null;
  if (!rawUrl) {
    // The default context always resolves to the canonical cloud origin even
    // when config.json is absent (a fresh install).
    if (contextName === DEFAULT_CONTEXT_NAME) return 'https://app.lobu.ai';
    return null;
  }
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

async function readStoredCredentials(
  contextName: string
): Promise<NormalizedCredentials | null> {
  let raw: string;
  try {
    raw = await readFile(credentialsPath(), 'utf-8');
  } catch {
    return null;
  }
  let parsed: StoredCredentialsStore | StoredCredentials;
  try {
    parsed = JSON.parse(raw) as StoredCredentialsStore | StoredCredentials;
  } catch {
    return null;
  }

  const store = parsed as StoredCredentialsStore;
  const stored: StoredCredentials | undefined =
    store.contexts && typeof store.contexts === 'object'
      ? store.contexts[contextName]
      : contextName === DEFAULT_CONTEXT_NAME
        ? (parsed as StoredCredentials)
        : undefined;

  return normalizeCredentials(stored);
}

function normalizeCredentials(
  value: StoredCredentials | undefined
): NormalizedCredentials | null {
  if (!value || typeof value !== 'object' || typeof value.accessToken !== 'string') {
    return null;
  }
  const out: NormalizedCredentials = { accessToken: value.accessToken };
  if (typeof value.refreshToken === 'string') out.refreshToken = value.refreshToken;
  if (typeof value.expiresAt === 'number') out.expiresAt = value.expiresAt;
  if (value.oauth && typeof value.oauth === 'object') {
    const clientId = value.oauth.clientId;
    if (typeof clientId === 'string') {
      out.oauth = {
        clientId,
        ...(typeof value.oauth.clientSecret === 'string'
          ? { clientSecret: value.oauth.clientSecret }
          : {}),
        ...(typeof value.oauth.tokenEndpoint === 'string'
          ? { tokenEndpoint: value.oauth.tokenEndpoint }
          : {}),
      };
    }
  }
  return out;
}

function needsRefresh(creds: NormalizedCredentials): boolean {
  return typeof creds.expiresAt === 'number' && creds.expiresAt - REFRESH_BUFFER_MS <= Date.now();
}

function canRefresh(
  creds: NormalizedCredentials
): creds is NormalizedCredentials & {
  refreshToken: string;
  oauth: { clientId: string; clientSecret?: string; tokenEndpoint: string };
} {
  return Boolean(creds.refreshToken && creds.oauth?.tokenEndpoint && creds.oauth.clientId);
}

/**
 * Refresh the login token via the issuer's token endpoint (mirrors the CLI's
 * `refreshTokens`: JSON body, refresh_token grant) and write the rotated tokens
 * back to credentials.json so the CLI sees them too. Returns the refreshed
 * credential, or null on any failure (caller falls back to the stale token /
 * env PAT).
 */
async function refreshLoginCredential(
  contextName: string,
  creds: NormalizedCredentials & {
    refreshToken: string;
    oauth: { clientId: string; clientSecret?: string; tokenEndpoint: string };
  }
): Promise<NormalizedCredentials | null> {
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: creds.oauth.clientId,
  };
  if (creds.oauth.clientSecret) body.client_secret = creds.oauth.clientSecret;

  let response: Response;
  try {
    response = await fetch(creds.oauth.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const data = (await response.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  } | null;
  if (!data || typeof data.access_token !== 'string') return null;

  const updated: NormalizedCredentials = {
    ...creds,
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : creds.refreshToken,
    expiresAt:
      typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : undefined,
  };

  await writeBackCredentials(contextName, updated).catch((error) => {
    // A write-back failure is non-fatal — we still have a usable fresh token in
    // memory for this run; the next run will just refresh again.
    logger.warn({ error: String(error) }, 'Failed to write back refreshed login credential');
  });
  return updated;
}

/**
 * Persist refreshed tokens into credentials.json, preserving the version-2
 * store shape and other contexts. Best-effort 0600 perms (mirrors the CLI).
 */
async function writeBackCredentials(
  contextName: string,
  creds: NormalizedCredentials
): Promise<void> {
  let store: { version: 2; contexts: Record<string, unknown> } = {
    version: 2,
    contexts: {},
  };
  try {
    const raw = await readFile(credentialsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as StoredCredentialsStore;
    if (parsed.contexts && typeof parsed.contexts === 'object') {
      store = { version: 2, contexts: { ...parsed.contexts } };
    } else if (typeof (parsed as StoredCredentials).accessToken === 'string') {
      // Legacy single-context file → migrate the default context.
      store = { version: 2, contexts: { [DEFAULT_CONTEXT_NAME]: parsed } };
    }
  } catch {
    // Missing/corrupt file — start fresh.
  }

  // Merge onto the existing context entry so we don't drop the stored
  // oauth/client info we don't track here.
  const existing = (store.contexts[contextName] as Record<string, unknown> | undefined) ?? {};
  store.contexts[contextName] = {
    ...existing,
    accessToken: creds.accessToken,
    ...(creds.refreshToken ? { refreshToken: creds.refreshToken } : {}),
    ...(typeof creds.expiresAt === 'number' ? { expiresAt: creds.expiresAt } : {}),
  };

  await mkdir(configDir(), { recursive: true });
  await writeFile(credentialsPath(), JSON.stringify(store, null, 2), { mode: 0o600 });
  await chmod(credentialsPath(), 0o600).catch(() => undefined);
}

/**
 * Resolve the cloud credential for the managed-connector token fetch.
 *
 * Order:
 *   1. The stored device-login for the active context (`lobu login`), refreshed
 *      when near expiry. baseUrl from the context URL's origin.
 *   2. Fallback: `LOBU_CLOUD_PAT` + `LOBU_CLOUD_URL` env (headless/CI).
 *
 * Returns null when neither is available (the connection falls through to the
 * local credential path, fail-soft).
 */
export async function resolveCloudCredential(
  contextOverride?: string
): Promise<CloudCredential | null> {
  const config = await loadContextConfig();
  const contextName = activeContextName(contextOverride, config);

  let creds = await readStoredCredentials(contextName);
  if (creds) {
    if (needsRefresh(creds) && canRefresh(creds)) {
      const refreshed = await refreshLoginCredential(contextName, creds);
      if (refreshed) creds = refreshed;
    }
    const baseUrl = resolveContextBaseUrl(contextName, config);
    if (baseUrl) {
      return { token: creds.accessToken, baseUrl: baseUrl.replace(/\/+$/, '') };
    }
  }

  // Headless / CI fallback: the instance-configured cloud PAT + URL.
  const envPat = process.env.LOBU_CLOUD_PAT?.trim();
  const envUrl = process.env.LOBU_CLOUD_URL?.trim();
  if (envPat && envUrl) {
    return { token: envPat, baseUrl: envUrl.replace(/\/+$/, '') };
  }

  return null;
}
