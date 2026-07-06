/**
 * GitHub connector identity namespaces and normalization.
 *
 * Single source of truth for github_login / github_user_id / github_repo_* rules.
 * The connector, app-webhook actor resolution, repo ACL graph, and server
 * entity-link ingestion all import from here — not from connector-sdk.
 */

/** Connector-owned identity namespaces (not SDK-global). */
export const GITHUB_IDENTITY = {
  USER_ID: 'github_user_id',
  LOGIN: 'github_login',
  REPO_ID: 'github_repo_id',
  REPO_FULL_NAME: 'github_repo_full_name',
} as const;

export type GithubIdentityNamespace =
  (typeof GITHUB_IDENTITY)[keyof typeof GITHUB_IDENTITY];

export function normalizeGithubLogin(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(trimmed)) return null;
  return trimmed;
}

function normalizeNumericId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return trimmed.replace(/^0+(?=\d)/, '');
}

export function normalizeGithubRepoFullName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  const githubName = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;
  if (!githubName.test(owner) || !githubName.test(repo)) return null;
  return `${owner}/${repo}`;
}

/**
 * Normalize a GitHub identity namespace value. Returns `undefined` when the
 * namespace is not GitHub-owned (caller should fall back to generic hygiene).
 */
export function normalizeGithubIdentityValue(
  namespace: string,
  raw: string,
): string | null | undefined {
  switch (namespace) {
    case GITHUB_IDENTITY.LOGIN:
      return normalizeGithubLogin(raw);
    case GITHUB_IDENTITY.USER_ID:
    case GITHUB_IDENTITY.REPO_ID:
      return normalizeNumericId(raw);
    case GITHUB_IDENTITY.REPO_FULL_NAME:
      return normalizeGithubRepoFullName(raw);
    default:
      return undefined;
  }
}

/** Stable `github_user_id:ID` / `github_login:login` key used by poll + webhooks. */
export function githubUserIdentityKey(params: {
  userId?: string | number | null;
  login: string;
}): string {
  const normalizedLogin =
    normalizeGithubLogin(params.login) ?? params.login.toLowerCase();
  if (params.userId != null && String(params.userId).length > 0) {
    return `${GITHUB_IDENTITY.USER_ID}:${params.userId}`;
  }
  return `${GITHUB_IDENTITY.LOGIN}:${normalizedLogin}`;
}

/** Sanitize an identity key for inclusion in `origin_id` (connector + webhook). */
export function githubKeyForOriginId(key: string): string {
  return key.replace(/[^a-z0-9]+/gi, '_');
}