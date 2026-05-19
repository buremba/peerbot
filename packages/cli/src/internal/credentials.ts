import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_CONTEXT_NAME,
  getCurrentContextName,
  LOBU_CONFIG_DIR,
  resolveContext,
  setActiveOrg,
  setCurrentContext,
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

// In-flight refresh dedupe. Two concurrent `getToken()` callers from the same
// process would otherwise both hit the OAuth token endpoint with the same
// refresh token — and many issuers rotate refresh tokens on use, so the
// second call would land with a revoked token and force a re-login. Coalescing
// per-context so different contexts can still refresh in parallel.
const inFlightRefreshes = new Map<string, Promise<Credentials | null>>();

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
  // writeFile's `mode` only applies on file creation; if the file existed
  // with looser perms (e.g. from an older CLI release), the mode would
  // silently stay 0o644. chmod after write makes the perms unconditional.
  await chmod(CREDENTIALS_FILE, 0o600).catch(() => undefined);
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
  await chmod(CREDENTIALS_FILE, 0o600).catch(() => undefined);
}

/**
 * Get token from env var (CI/CD) or stored credentials.
 * Automatically refreshes expired tokens and clears stale credentials.
 *
 * For loopback contexts with no stored creds, transparently POSTs
 * /api/local-init to mint a fresh Better Auth session for the
 * embedded-PGlite bootstrap user — `lobu chat -c local` works without a
 * prior `lobu login`.
 */
export async function getToken(contextName?: string): Promise<string | null> {
  const envToken = process.env.LOBU_API_TOKEN;
  if (envToken) return envToken;

  let creds = await loadCredentials(contextName);
  if (!creds) {
    creds = await tryLocalInit(contextName);
  }
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

/**
 * Attempt zero-config sign-in against a local embedded server. POST
 * /api/local-init mints a Better Auth session for the bootstrap user
 * when the deployment is empty (no real signups yet) and refuses
 * proxied requests via the forwarded-* header guard, so this is safe to
 * fire unconditionally against loopback contexts.
 */
async function tryLocalInit(contextName?: string): Promise<Credentials | null> {
  const target = await resolveContext(contextName);
  if (!isLoopbackUrl(target.apiUrl)) return null;
  try {
    const res = await fetch(`${target.apiUrl}/api/local-init`, {
      method: "POST",
      headers: { "X-Lobu-Client": "cli" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      device_token?: string;
      session_token?: string;
      user?: { id?: string; email?: string; name?: string };
      organization?: { id?: string; slug?: string; name?: string };
    };
    // Prefer device_token (PAT scoped with device_worker:run + mcp:*) so
    // `lobu chat` / `lobu apply` / worker poll all pass the scope gate on
    // /api/workers/*. Fall back to session_token only against older
    // servers that don't issue a PAT.
    const token = body.device_token ?? body.session_token;
    if (!token) return null;
    const creds: Credentials = {
      accessToken: token,
      ...(body.user?.email ? { email: body.user.email } : {}),
      ...(body.user?.name ? { name: body.user.name } : {}),
      ...(body.user?.id ? { userId: body.user.id } : {}),
    };
    await saveCredentials(creds, target.name);
    // Bind the local-init org slug to the context so `lobu apply` /
    // `lobu chat` / `lobu org current` find it without a manual
    // `lobu org set <slug>`. The server's bootstrap auto-provisions the
    // single user's personal org and returns it in the response — that
    // slug is the source of truth for this loopback install.
    const orgSlug = body.organization?.slug?.trim();
    if (orgSlug) {
      await setActiveOrg(orgSlug, target.name).catch(() => undefined);
    }
    // Auto-switch the active context so subsequent `lobu apply` / `lobu chat`
    // invocations (without `-c <name>`) hit the same loopback server. Without
    // this, a user previously on the `lobu` cloud context who runs `lobu run`
    // locally still sees cloud for every other command — and the fact that a
    // local context exists is invisible. Announce on stderr so the change is
    // visible but doesn't pollute stdout pipelines.
    try {
      const current = await getCurrentContextName();
      if (current !== target.name) {
        await setCurrentContext(target.name);
        process.stderr.write(
          `Switched active context to "${target.name}" (lobu run)\n`
        );
      }
    } catch {
      // Best-effort — a write failure here shouldn't break the auth flow.
    }
    return creds;
  } catch {
    return null;
  }
}

function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
    );
  } catch {
    return false;
  }
}

export async function refreshCredentials(
  existing?: Credentials | null,
  contextName?: string
): Promise<Credentials | null> {
  const target = await resolveContext(contextName);

  // Coalesce concurrent refresh attempts for the same context — see the
  // `inFlightRefreshes` declaration for the rotation-race rationale.
  const inFlight = inFlightRefreshes.get(target.name);
  if (inFlight) return inFlight;

  const promise = doRefreshCredentials(target, existing).finally(() => {
    inFlightRefreshes.delete(target.name);
  });
  inFlightRefreshes.set(target.name, promise);
  return promise;
}

async function doRefreshCredentials(
  target: { name: string },
  existing: Credentials | null | undefined
): Promise<Credentials | null> {
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
