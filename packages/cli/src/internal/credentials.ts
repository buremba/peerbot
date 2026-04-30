import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_CONTEXT_NAME,
  LOBU_CONFIG_DIR,
  resolveContext,
} from "./context.js";
import { refreshTokens } from "./oauth.js";

const CREDENTIALS_FILE = join(LOBU_CONFIG_DIR, "credentials.json");

export interface OAuthClientInfo {
  clientId: string;
  clientSecret?: string;
  /** Cached so refresh/logout don't have to re-discover. */
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  userinfoEndpoint?: string;
}

export interface Credentials {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt?: number;
  email?: string;
  name?: string;
  userId?: string;
  agentId?: string;
  /** Registered OAuth client + endpoints used to mint these tokens. */
  oauth?: OAuthClientInfo;
}

interface CredentialsStore {
  version: 2;
  contexts: Record<string, Credentials>;
}

// Per-process cache. `lobu apply` calls `getToken()` once per request; without
// this, each call re-reads + re-parses ~/.config/lobu/credentials.json.
// Writes invalidate so refreshed tokens are visible immediately.
const credentialsCache = new Map<string, Credentials | null>();

export async function loadCredentials(
  contextName?: string
): Promise<Credentials | null> {
  const target = await resolveContext(contextName);
  if (credentialsCache.has(target.name)) {
    return credentialsCache.get(target.name) ?? null;
  }

  let creds: Credentials | null = null;
  try {
    const raw = await readFile(CREDENTIALS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as
      | CredentialsStore
      | (Partial<Credentials> & { accessToken?: string });

    const stored = isCredentialsStore(parsed)
      ? parsed.contexts[target.name]
      : target.name === DEFAULT_CONTEXT_NAME
        ? parsed
        : null;

    creds = normalizeCredentials(stored);
  } catch {
    creds = null;
  }

  credentialsCache.set(target.name, creds);
  return creds;
}

export async function saveCredentials(
  creds: Credentials,
  contextName?: string
): Promise<void> {
  const target = await resolveContext(contextName);
  const store = await loadCredentialStore();
  store.contexts[target.name] = creds;

  await mkdir(LOBU_CONFIG_DIR, { recursive: true });
  await writeFile(CREDENTIALS_FILE, JSON.stringify(store, null, 2), {
    mode: 0o600,
  });
  credentialsCache.set(target.name, creds);
}

export async function clearCredentials(contextName?: string): Promise<void> {
  const target = await resolveContext(contextName);
  const store = await loadCredentialStore();
  delete store.contexts[target.name];
  credentialsCache.set(target.name, null);

  if (Object.keys(store.contexts).length === 0) {
    try {
      await rm(CREDENTIALS_FILE);
    } catch {
      // File doesn't exist, nothing to clear.
    }
    return;
  }

  await writeFile(CREDENTIALS_FILE, JSON.stringify(store, null, 2), {
    mode: 0o600,
  });
}

/**
 * Get token from env var (CI/CD) or stored credentials.
 * Automatically refreshes expired tokens and clears stale credentials.
 */
export async function getToken(contextName?: string): Promise<string | null> {
  const envToken = process.env.LOBU_API_TOKEN;
  if (envToken) return envToken;

  const creds = await loadCredentials(contextName);
  if (!creds) return null;
  if (!needsRefresh(creds)) return creds.accessToken;

  if (!canRefresh(creds)) {
    await clearCredentials(contextName);
    return null;
  }

  const refreshed = await refreshCredentials(creds, contextName);
  if (!refreshed) {
    await clearCredentials(contextName);
    return null;
  }
  return refreshed.accessToken;
}

export async function refreshCredentials(
  existing?: Credentials | null,
  contextName?: string
): Promise<Credentials | null> {
  const target = await resolveContext(contextName);
  const creds = existing ?? (await loadCredentials(target.name));
  if (!creds) return null;
  if (!canRefresh(creds)) return creds;

  const result = await attemptRefresh(target, creds);
  if (result) return result;

  // Retry once: another CLI process may have rotated the token concurrently.
  // Re-read from disk to pick up the freshly written credentials.
  credentialsCache.delete(target.name);
  const freshCreds = await loadCredentials(target.name);
  if (
    freshCreds?.accessToken &&
    freshCreds.accessToken !== creds.accessToken &&
    !needsRefresh(freshCreds)
  ) {
    return freshCreds;
  }

  if (
    freshCreds?.refreshToken &&
    freshCreds.refreshToken !== creds.refreshToken &&
    canRefresh(freshCreds)
  ) {
    return attemptRefresh(target, freshCreds);
  }

  return null;
}

async function attemptRefresh(
  target: { name: string },
  creds: Credentials
): Promise<Credentials | null> {
  if (!canRefresh(creds)) return null;

  const refreshed = await refreshTokens(
    creds.oauth.tokenEndpoint,
    { clientId: creds.oauth.clientId, clientSecret: creds.oauth.clientSecret },
    creds.refreshToken
  );
  if (!refreshed) return null;

  const updated: Credentials = {
    ...creds,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? creds.refreshToken,
    expiresAt:
      typeof refreshed.expiresIn === "number"
        ? Date.now() + refreshed.expiresIn * 1000
        : undefined,
  };

  await saveCredentials(updated, target.name);
  return updated;
}

function needsRefresh(creds: Credentials): boolean {
  return (
    typeof creds.expiresAt === "number" &&
    creds.expiresAt - 60_000 <= Date.now()
  );
}

function canRefresh(creds: Credentials): creds is Credentials & {
  refreshToken: string;
  oauth: OAuthClientInfo & { tokenEndpoint: string };
} {
  return Boolean(
    creds.refreshToken && creds.oauth?.tokenEndpoint && creds.oauth.clientId
  );
}

async function loadCredentialStore(): Promise<CredentialsStore> {
  try {
    const raw = await readFile(CREDENTIALS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as
      | CredentialsStore
      | (Partial<Credentials> & { accessToken?: string });

    if (isCredentialsStore(parsed)) {
      return {
        version: 2,
        contexts: Object.fromEntries(
          Object.entries(parsed.contexts)
            .map(([name, value]) => [name, normalizeCredentials(value)])
            .filter((entry): entry is [string, Credentials] => !!entry[1])
        ),
      };
    }

    const legacy = normalizeCredentials(parsed);
    return {
      version: 2,
      contexts: legacy ? { [DEFAULT_CONTEXT_NAME]: legacy } : {},
    };
  } catch {
    return { version: 2, contexts: {} };
  }
}

function isCredentialsStore(value: unknown): value is CredentialsStore {
  return (
    !!value &&
    typeof value === "object" &&
    "contexts" in value &&
    !!(value as { contexts?: unknown }).contexts &&
    typeof (value as { contexts?: unknown }).contexts === "object"
  );
}

function normalizeCredentials(
  value: Partial<Credentials> | null | undefined
): Credentials | null {
  if (!value || typeof value !== "object" || !value.accessToken) return null;
  return { ...value, accessToken: value.accessToken };
}
