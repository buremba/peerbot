/**
 * GitHub App installation-token provider.
 *
 * Flow (100% gateway-side):
 *   1. Build a short-lived App JWT (RS256), signed with the App private key:
 *        header  { alg: 'RS256', typ: 'JWT' }
 *        claims  { iss: <App id>, iat, exp }  with exp - iat <= 600s
 *   2. Exchange it for an installation token:
 *        POST https://api.github.com/app/installations/{installation_id}/access_tokens
 *        Authorization: Bearer <jwt>
 *        Accept: application/vnd.github+json
 *      → { token, expires_at }  (token valid ~1h)
 *   3. Cache per installation id (per-pod, best-effort) and refresh before expiry.
 *
 * The private key and the JWT never leave the gateway: a worker only ever sees
 * the minted installation token (resolved at egress, like an OAuth token).
 */

import { createSign } from "node:crypto";
import { createLogger } from "@lobu/core";
import type { AppInstallationRow } from "../../lobu/stores/app-installation-store.js";
import {
  InstallationTokenError,
  type InstallationTokenProvider,
  InMemoryInstallationTokenCache,
  type MintedInstallationToken,
} from "./installation-token-provider.js";

const logger = createLogger("github-installation-token");

/** GitHub caps the App JWT at 10 minutes; we sign 9 to leave clock-skew slack. */
const APP_JWT_TTL_SECONDS = 540;
/**
 * GitHub rejects an App JWT whose `iat` is in the future relative to its clock.
 * Backdate `iat` 60s so a fast/skewed local clock never trips
 * `'iat' claim ('issued at') is in the future`.
 */
const APP_JWT_IAT_BACKDATE_SECONDS = 60;

const GITHUB_API_BASE = "https://api.github.com";

export interface GitHubInstallationTokenProviderConfig {
  /**
   * Env accessor. Defaults to `process.env`; injectable for tests so the App id
   * + private key can be supplied without touching the process environment.
   */
  env?: Record<string, string | undefined>;
  /**
   * Override the HTTP client (tests MOCK the `/access_tokens` exchange here so
   * no request ever reaches api.github.com).
   */
  fetchImpl?: typeof fetch;
  /** Override the per-pod token cache (tests inject a fresh one for isolation). */
  cache?: InMemoryInstallationTokenCache;
  /** Override the JWT clock (tests pin `iat`/`exp`); defaults to `Date.now`. */
  now?: () => number;
}

/** GitHub's `POST /access_tokens` success body (subset we consume). */
interface GitHubAccessTokenResponse {
  token: string;
  expires_at: string;
}

/**
 * base64url (no padding) — App JWT segments use it, and PEM signing output is
 * compared against GitHub's expectations byte-for-byte.
 */
function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Normalize a PEM private key sourced from an env var. Secret managers and
 * `.env` files commonly store the key with literal `\n` sequences rather than
 * real newlines; OpenSSL needs real newlines, so we restore them. A key that
 * already has real newlines is left untouched.
 */
function normalizePrivateKeyPem(raw: string): string {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

/**
 * Build and sign the App JWT (RS256). Exported for unit tests so the header /
 * claims / signing window can be asserted directly with a throwaway key.
 */
export function buildGitHubAppJwt(params: {
  appId: string;
  privateKeyPem: string;
  nowMs?: number;
}): string {
  const nowSec = Math.floor((params.nowMs ?? Date.now()) / 1000);
  const iat = nowSec - APP_JWT_IAT_BACKDATE_SECONDS;
  const exp = nowSec + APP_JWT_TTL_SECONDS;
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: params.appId, iat, exp };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claims)
  )}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = base64url(
    signer.sign(normalizePrivateKeyPem(params.privateKeyPem))
  );

  return `${signingInput}.${signature}`;
}

/**
 * Mints GitHub App installation tokens. One instance per pod; holds the per-pod
 * token cache.
 */
export class GitHubInstallationTokenProvider
  implements InstallationTokenProvider
{
  readonly provider = "github";

  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: InMemoryInstallationTokenCache;
  private readonly now: () => number;

  constructor(config: GitHubInstallationTokenProviderConfig = {}) {
    this.env = config.env ?? process.env;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.cache = config.cache ?? new InMemoryInstallationTokenCache();
    this.now = config.now ?? Date.now;
  }

  /**
   * Resolve the App id + private key for an install. The env var NAMES come from
   * the connector's `app_installation` auth method (`appIdKey` / `privateKeyKey`,
   * defaulting to `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`); the VALUES are
   * read from the gateway env (never the install row, never the worker).
   */
  private resolveAppConfig(install: AppInstallationRow): {
    appId: string;
    privateKeyPem: string;
  } {
    const appIdKey =
      (install.metadata?.appIdKey as string | undefined) || "GITHUB_APP_ID";
    const privateKeyKey =
      (install.metadata?.privateKeyKey as string | undefined) ||
      "GITHUB_APP_PRIVATE_KEY";

    const appId = this.env[appIdKey]?.trim();
    const privateKeyPem = this.env[privateKeyKey];

    if (!appId || !privateKeyPem) {
      throw new InstallationTokenError(
        "missing_app_config",
        `GitHub App config missing: set ${appIdKey} and ${privateKeyKey} in the gateway env`
      );
    }
    return { appId, privateKeyPem };
  }

  /** Cache key: provider-app-aware so two Apps over one tenant never collide. */
  private cacheKey(install: AppInstallationRow): string {
    return `github:${install.providerInstance}:${install.providerAppId}:${install.externalTenantId}`;
  }

  async mintToken(
    install: AppInstallationRow
  ): Promise<MintedInstallationToken> {
    const key = this.cacheKey(install);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const { appId, privateKeyPem } = this.resolveAppConfig(install);
    const jwt = buildGitHubAppJwt({
      appId,
      privateKeyPem,
      nowMs: this.now(),
    });

    const url = `${GITHUB_API_BASE}/app/installations/${encodeURIComponent(
      install.externalTenantId
    )}/access_tokens`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "lobu-gateway",
        },
      });
    } catch (cause) {
      throw new InstallationTokenError(
        "exchange_failed",
        `GitHub installation-token exchange request failed for installation ${install.externalTenantId}`,
        { cause }
      );
    }

    if (!response.ok) {
      // A 404 here is the classic revoked/suspended/removed install: the App
      // id is valid (the JWT passed) but the installation no longer exists.
      // Surface it as a failure so the connection error path can flag it; the
      // caller maps a missing token onto a connection error, never a crash.
      logger.warn(
        {
          status: response.status,
          installation_id: install.externalTenantId,
          install_row_id: install.id,
        },
        "GitHub installation-token exchange returned non-OK"
      );
      throw new InstallationTokenError(
        "exchange_failed",
        `GitHub installation-token exchange returned ${response.status} for installation ${install.externalTenantId}`,
        { status: response.status }
      );
    }

    let body: GitHubAccessTokenResponse;
    try {
      body = (await response.json()) as GitHubAccessTokenResponse;
    } catch (cause) {
      throw new InstallationTokenError(
        "exchange_failed",
        "GitHub installation-token exchange returned an unparseable body",
        { cause }
      );
    }

    if (!body.token || !body.expires_at) {
      throw new InstallationTokenError(
        "exchange_failed",
        "GitHub installation-token exchange body missing token/expires_at"
      );
    }

    const minted: MintedInstallationToken = {
      token: body.token,
      expiresAt: body.expires_at,
    };
    this.cache.set(key, minted);
    return minted;
  }
}
