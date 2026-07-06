/**
 * GitHub identity normalization for server-side ACL graph builders.
 * Connector-owned — mirrors the logic in packages/connectors/src/github.ts.
 */

export function normalizeGithubLogin(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(trimmed)) return null;
  return trimmed;
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