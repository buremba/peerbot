/**
 * Shared primitives for the `~/.config/lobu/credentials.json` store — the
 * v2, context-keyed credential file written by `lobu login`.
 *
 * Two consumers read/refresh/write this store: the CLI
 * (`packages/cli/src/internal/credentials.ts`) and the embedded server's
 * managed-connector resolver (`packages/server/src/connect/cloud-credential.ts`).
 * This module is the single implementation of the file format + refresh grant so
 * the two can't drift. It is pure file I/O + a plain refresh_token POST — the
 * CLI layers its own concerns (per-process caching, in-flight refresh dedup,
 * local-init, context resolution) on top.
 */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface OAuthClientInfo {
  clientId: string;
  clientSecret?: string;
  /** Cached so refresh/logout don't have to re-discover. */
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  userinfoEndpoint?: string;
}

/**
 * The auth-relevant fields every stored credential carries. Consumers may store
 * extra fields alongside these (e.g. the CLI's `email` / `userId` /
 * `localWorkerToken`); the `C` type parameter preserves them through read/write.
 */
export interface BaseCredential {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt?: number;
  /** Registered OAuth client + endpoints used to mint/refresh these tokens. */
  oauth?: OAuthClientInfo;
}

export interface CredentialStore<C extends BaseCredential = BaseCredential> {
  version: 2;
  contexts: Record<string, C>;
}

/** Refresh the access token when it expires within this window. */
export const CREDENTIAL_REFRESH_BUFFER_MS = 60_000;

export function normalizeCredential<C extends BaseCredential = BaseCredential>(
  value: Partial<C> | null | undefined
): C | null {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.accessToken !== "string"
  ) {
    return null;
  }
  return { ...(value as C), accessToken: value.accessToken };
}

function isCredentialStore(value: unknown): value is CredentialStore {
  return (
    !!value &&
    typeof value === "object" &&
    "contexts" in value &&
    !!(value as { contexts?: unknown }).contexts &&
    typeof (value as { contexts?: unknown }).contexts === "object"
  );
}

/**
 * Read + normalize the whole store. A legacy single-context file (pre-v2: the
 * bare credential object at the top level) is migrated under `defaultContextName`.
 * Missing or corrupt files yield an empty store rather than throwing.
 */
export async function readCredentialStore<
  C extends BaseCredential = BaseCredential,
>(file: string, defaultContextName: string): Promise<CredentialStore<C>> {
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (isCredentialStore(parsed)) {
      const contexts: Record<string, C> = {};
      for (const [name, value] of Object.entries(parsed.contexts)) {
        const norm = normalizeCredential<C>(value as Partial<C>);
        if (norm) contexts[name] = norm;
      }
      return { version: 2, contexts };
    }
    const legacy = normalizeCredential<C>(parsed as Partial<C>);
    return {
      version: 2,
      contexts: legacy ? { [defaultContextName]: legacy } : {},
    };
  } catch {
    return { version: 2, contexts: {} };
  }
}

/** Read one context's credential (null when absent/corrupt). */
export async function readContextCredential<
  C extends BaseCredential = BaseCredential,
>(
  file: string,
  contextName: string,
  defaultContextName: string
): Promise<C | null> {
  const store = await readCredentialStore<C>(file, defaultContextName);
  return store.contexts[contextName] ?? null;
}

/**
 * Write one context's credential into the store, preserving other contexts.
 * `writeFile`'s `mode` only applies on creation, so `chmod` afterwards makes the
 * 0600 perms unconditional even if the file pre-existed with looser perms.
 */
export async function writeContextCredential<
  C extends BaseCredential = BaseCredential,
>(
  file: string,
  contextName: string,
  defaultContextName: string,
  credential: C
): Promise<void> {
  const store = await readCredentialStore<C>(file, defaultContextName);
  store.contexts[contextName] = credential;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 2), { mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
}

/** Remove one context. Deletes the file entirely when no contexts remain. */
export async function deleteContextCredential<
  C extends BaseCredential = BaseCredential,
>(
  file: string,
  contextName: string,
  defaultContextName: string
): Promise<void> {
  const store = await readCredentialStore<C>(file, defaultContextName);
  delete store.contexts[contextName];
  if (Object.keys(store.contexts).length === 0) {
    await rm(file).catch(() => undefined);
    return;
  }
  await writeFile(file, JSON.stringify(store, null, 2), { mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
}

export function credentialNeedsRefresh(
  cred: BaseCredential,
  bufferMs = CREDENTIAL_REFRESH_BUFFER_MS
): boolean {
  return (
    typeof cred.expiresAt === "number" &&
    cred.expiresAt - bufferMs <= Date.now()
  );
}

export function credentialCanRefresh<C extends BaseCredential = BaseCredential>(
  cred: C
): cred is C & {
  refreshToken: string;
  oauth: OAuthClientInfo & { tokenEndpoint: string };
} {
  return Boolean(
    cred.refreshToken && cred.oauth?.tokenEndpoint && cred.oauth.clientId
  );
}

export interface RefreshedToken {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until expiry, when the issuer returns `expires_in`. */
  expiresIn?: number;
}

/**
 * Plain RFC 6749 refresh_token grant against the issuer token endpoint (JSON
 * body). Returns null on any network / non-2xx / parse failure. The issuer may
 * rotate the refresh token, so callers MUST persist the returned `refreshToken`
 * when present.
 */
export async function refreshOAuthToken(
  tokenEndpoint: string,
  client: { clientId: string; clientSecret?: string },
  refreshToken: string
): Promise<RefreshedToken | null> {
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.clientId,
  };
  if (client.clientSecret) body.client_secret = client.clientSecret;

  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
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
  if (!data || typeof data.access_token !== "string") return null;
  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expiresIn:
      typeof data.expires_in === "number" ? data.expires_in : undefined,
  };
}
