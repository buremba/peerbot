import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export interface OpenClawOAuthSession {
  mcpUrl: string;
  issuer: string;
  org?: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
  tokenType?: string;
  scope?: string;
  updatedAt: string;
}

interface OpenClawAuthStore {
  version: 1;
  activeServer?: string;
  sessions: Record<string, OpenClawOAuthSession>;
}

const DEFAULT_STORE_PATH = resolve(homedir(), '.owletto', 'openclaw-auth.json');

function defaultStore(): OpenClawAuthStore {
  return {
    version: 1,
    sessions: {},
  };
}

export function normalizeMcpUrl(input: string): string {
  const url = new URL(input);
  url.hash = '';
  url.search = '';
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/mcp';
  }
  return url.toString().replace(/\/+$/, '');
}

/** Strip org suffix from an MCP URL for session lookup: /mcp/acme → /mcp */
export function baseMcpUrl(input: string): string {
  const url = new URL(input);
  url.hash = '';
  url.search = '';
  url.pathname = '/mcp';
  return url.toString().replace(/\/+$/, '');
}

export function deriveMcpUrl(apiUrl: string): string {
  return new URL('/mcp', apiUrl).toString();
}

/** Build an org-scoped MCP URL: `https://host/mcp/{org}` */
export function mcpUrlForOrg(baseMcpUrl: string, org: string): string {
  const url = new URL(normalizeMcpUrl(baseMcpUrl));
  url.pathname = `/mcp/${org}`;
  return url.toString().replace(/\/+$/, '');
}

/** Extract org slug from a /mcp/{org} URL, or null if bare /mcp */
export function orgFromMcpUrl(mcpUrl: string): string | null {
  try {
    const { pathname } = new URL(mcpUrl);
    const match = pathname.match(/^\/mcp\/([^/]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function getOpenClawAuthStorePath(customPath?: string): string {
  return customPath ? resolve(customPath) : DEFAULT_STORE_PATH;
}

/** Load and migrate the auth store (handles old field names). */
function loadOpenClawAuthStore(storePath?: string): OpenClawAuthStore {
  const path = getOpenClawAuthStorePath(storePath);
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as any;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !parsed.sessions ||
      typeof parsed.sessions !== 'object'
    ) {
      return defaultStore();
    }
    // Migrate old field names
    const store: OpenClawAuthStore = {
      version: 1,
      activeServer: parsed.activeServer ?? parsed.activeContext,
      sessions: {},
    };
    for (const [key, session] of Object.entries(parsed.sessions)) {
      const s = session as any;
      store.sessions[key] = {
        ...s,
        org: s.org ?? s.organizationSlug,
      };
      delete (store.sessions[key] as any).organizationSlug;
    }
    return store;
  } catch {
    return defaultStore();
  }
}

function saveOpenClawAuthStore(store: OpenClawAuthStore, storePath?: string) {
  const path = getOpenClawAuthStorePath(storePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
}

function getStoredSession(
  mcpUrl: string,
  storePath?: string
): { session: OpenClawOAuthSession | null; path: string } {
  const path = getOpenClawAuthStorePath(storePath);
  const store = loadOpenClawAuthStore(path);
  // Try exact match first, then fall back to base /mcp (strip org suffix)
  const key = normalizeMcpUrl(mcpUrl);
  const session = store.sessions[key] || store.sessions[baseMcpUrl(mcpUrl)] || null;
  return { session, path };
}

export function upsertStoredSession(session: OpenClawOAuthSession, storePath?: string) {
  const path = getOpenClawAuthStorePath(storePath);
  const store = loadOpenClawAuthStore(path);
  // Tokens are org-scoped, so store per org-scoped URL
  const key = normalizeMcpUrl(session.mcpUrl);
  store.sessions[key] = { ...session, mcpUrl: key };
  store.activeServer = key;
  saveOpenClawAuthStore(store, path);
}

export function getActiveSession(storePath?: string): {
  session: OpenClawOAuthSession | null;
  key: string | null;
  path: string;
} {
  const path = getOpenClawAuthStorePath(storePath);
  const store = loadOpenClawAuthStore(path);
  // If only one session, use it regardless of activeServer
  const keys = Object.keys(store.sessions);
  if (keys.length === 1) {
    const key = keys[0];
    return { session: store.sessions[key] || null, key, path };
  }
  const key = store.activeServer || null;
  if (!key) {
    return { session: null, key: null, path };
  }
  return {
    session: store.sessions[key] || null,
    key,
    path,
  };
}

export function setActiveOrg(orgSlug: string, storePath?: string) {
  const path = getOpenClawAuthStorePath(storePath);
  const store = loadOpenClawAuthStore(path);

  if (Object.keys(store.sessions).length === 0) {
    throw new Error('No active session. Run: owletto login');
  }

  if (!/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/i.test(orgSlug)) {
    throw new Error(
      `Invalid organization slug "${orgSlug}". Slugs may only contain alphanumeric characters, hyphens, and underscores.`
    );
  }

  // URL match takes priority over org field
  const match =
    Object.entries(store.sessions).find(([key]) => orgFromMcpUrl(key) === orgSlug) ||
    Object.entries(store.sessions).find(([, session]) => session.org === orgSlug);
  if (!match) {
    const available = Object.entries(store.sessions)
      .map(([key, s]) => orgFromMcpUrl(key) || s.org)
      .filter(Boolean);
    throw new Error(
      `No session for org "${orgSlug}". Available: ${available.join(', ') || '(none)'}. Run: owletto login <server-url>/mcp/${orgSlug}`
    );
  }

  store.activeServer = match[0];
  saveOpenClawAuthStore(store, path);
}

/** Find a session for the given org slug (URL match takes priority over org field). */
export function getSessionForOrg(
  orgSlug: string,
  storePath?: string
): { session: OpenClawOAuthSession; key: string; path: string } | null {
  const path = getOpenClawAuthStorePath(storePath);
  const store = loadOpenClawAuthStore(path);
  // Prefer URL-based match (authoritative) over org field match
  const urlMatch = Object.entries(store.sessions).find(([key]) => orgFromMcpUrl(key) === orgSlug);
  if (urlMatch) return { session: urlMatch[1], key: urlMatch[0], path };
  const fieldMatch = Object.entries(store.sessions).find(([, session]) => session.org === orgSlug);
  if (fieldMatch) return { session: fieldMatch[1], key: fieldMatch[0], path };
  return null;
}

/**
 * Resolve which server URL to use.
 * Priority: explicit url arg > OWLETTO_URL env > active session server.
 */
export function resolveServerUrl(urlFlag?: string, storePath?: string): string | null {
  if (urlFlag) return normalizeMcpUrl(urlFlag);
  if (process.env.OWLETTO_URL) return normalizeMcpUrl(process.env.OWLETTO_URL);
  const { key } = getActiveSession(storePath);
  return key;
}

/**
 * Resolve which org to use.
 * Priority: explicit org arg > OWLETTO_ORG env > session default org.
 */
export function resolveOrg(
  orgFlag?: string,
  session?: OpenClawOAuthSession | null
): string | undefined {
  if (orgFlag) return orgFlag;
  if (process.env.OWLETTO_ORG) return process.env.OWLETTO_ORG;
  return session?.org;
}

function isTokenFresh(session: OpenClawOAuthSession): boolean {
  if (!session.accessToken) return false;
  if (!session.accessTokenExpiresAt) return true;
  const expiresAt = new Date(session.accessTokenExpiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000;
}

function computeExpiryIso(expiresInSeconds?: number): string | undefined {
  if (!expiresInSeconds || !Number.isFinite(expiresInSeconds)) return undefined;
  return new Date(Date.now() + Math.max(0, Math.floor(expiresInSeconds)) * 1000).toISOString();
}

async function refreshAccessToken(session: OpenClawOAuthSession): Promise<OpenClawOAuthSession> {
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: session.clientId,
    refresh_token: session.refreshToken,
  };
  if (session.clientSecret) {
    body.client_secret = session.clientSecret;
  }

  const res = await fetch(`${session.issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth refresh failed: ${res.status} ${text}`);
  }

  const token = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!token.access_token) {
    throw new Error('OAuth refresh response missing access_token');
  }

  return {
    ...session,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || session.refreshToken,
    scope: token.scope || session.scope,
    tokenType: token.token_type || session.tokenType || 'Bearer',
    accessTokenExpiresAt: computeExpiryIso(token.expires_in),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Resolve a usable access token from the auth store.
 * Refreshes the token if expired. Returns null if no session exists.
 */
export async function getUsableToken(
  mcpUrl?: string,
  storePath?: string
): Promise<{ token: string; session: OpenClawOAuthSession; storePath: string } | null> {
  let session: OpenClawOAuthSession | null = null;
  let path: string;

  if (mcpUrl) {
    const result = getStoredSession(mcpUrl, storePath);
    session = result.session;
    path = result.path;
  } else {
    const active = getActiveSession(storePath);
    session = active.session;
    path = active.path;
  }

  if (!session) return null;

  if (isTokenFresh(session)) {
    return { token: session.accessToken as string, session, storePath: path };
  }

  const refreshed = await refreshAccessToken(session);
  upsertStoredSession(refreshed, path);
  if (!refreshed.accessToken) return null;

  return { token: refreshed.accessToken, session: refreshed, storePath: path };
}
