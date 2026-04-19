import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_CONTEXT_NAME,
  LOBU_CONFIG_DIR,
  resolveContext,
} from "./context.js";

const CREDENTIALS_FILE = join(LOBU_CONFIG_DIR, "credentials.json");

export interface Credentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
  name?: string;
  userId?: string;
  agentId?: string;
}

interface CredentialsStore {
  version: 2;
  contexts: Record<string, Credentials>;
}

export async function loadCredentials(
  contextName?: string
): Promise<Credentials | null> {
  const target = await resolveContext(contextName);

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

    return normalizeCredentials(stored);
  } catch {
    return null;
  }
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
}

export async function clearCredentials(contextName?: string): Promise<void> {
  const target = await resolveContext(contextName);
  const store = await loadCredentialStore();
  delete store.contexts[target.name];

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

  if (!needsRefresh(creds)) {
    return creds.accessToken;
  }

  if (!creds.refreshToken) {
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
  if (!creds?.refreshToken) {
    return creds ?? null;
  }

  const result = await attemptRefresh(target, creds);
  if (result) return result;

  // Retry once: another CLI process may have rotated the token concurrently.
  // Re-read from disk to pick up the freshly written credentials.
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
    freshCreds.refreshToken !== creds.refreshToken
  ) {
    return attemptRefresh(target, freshCreds);
  }

  return null;
}

async function attemptRefresh(
  target: { apiUrl: string; name: string },
  creds: Credentials
): Promise<Credentials | null> {
  try {
    const response = await fetch(`${target.apiUrl}/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Lobu-Org": "default",
      },
      body: JSON.stringify({ refreshToken: creds.refreshToken }),
    });

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as {
      accessToken: string;
      refreshToken: string;
      expiresAt?: number;
      user?: {
        email?: string;
        name?: string;
        userId?: string;
      };
    };

    const refreshed: Credentials = {
      ...creds,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken || creds.refreshToken,
      expiresAt: body.expiresAt,
      email: body.user?.email ?? creds.email,
      name: body.user?.name ?? creds.name,
      userId: body.user?.userId ?? creds.userId,
    };

    await saveCredentials(refreshed, target.name);
    return refreshed;
  } catch {
    return null;
  }
}

function needsRefresh(creds: Credentials): boolean {
  return (
    typeof creds.expiresAt === "number" &&
    creds.expiresAt - 60_000 <= Date.now()
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
    return {
      version: 2,
      contexts: {},
    };
  }
}

function isCredentialsStore(value: unknown): value is CredentialsStore {
  if (!value || typeof value !== "object") {
    return false;
  }

  return (
    "contexts" in value &&
    !!(value as { contexts?: unknown }).contexts &&
    typeof (value as { contexts?: unknown }).contexts === "object"
  );
}

function normalizeCredentials(
  value: Partial<Credentials> | null | undefined
): Credentials | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const accessToken = value.accessToken;
  if (!accessToken) {
    return null;
  }

  return {
    ...value,
    accessToken,
  };
}
