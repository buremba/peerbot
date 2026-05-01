import { getDb } from '../db/client';
import { generateSlug } from './entity-management';

export type AuthProfileKind =
  | 'env'
  | 'oauth_app'
  | 'oauth_account'
  | 'browser_session'
  | 'interactive';
export type AuthProfileStatus = 'active' | 'pending_auth' | 'error' | 'revoked';

export interface AuthProfileRow {
  id: number;
  organization_id: string;
  slug: string;
  display_name: string;
  connector_key: string;
  profile_kind: AuthProfileKind;
  status: AuthProfileStatus;
  auth_data: Record<string, unknown>;
  account_id: string | null;
  provider: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface BrowserSessionSummary {
  auth_mode: 'cdp' | 'cookies' | 'empty';
  cookie_count: number;
  captured_at: string | null;
  auth_cookie_name: string | null;
  expires_at: string | null;
  is_expired: boolean;
  cdp_url: string | null;
}

interface BrowserSessionReadiness extends BrowserSessionSummary {
  usable: boolean;
  resolved_cdp_url: string | null;
}

export function normalizeAuthValues(raw: unknown): Record<string, string> {
  if (typeof raw === 'string') {
    try {
      return normalizeAuthValues(JSON.parse(raw));
    } catch {
      return {};
    }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    normalized[key] = trimmed;
  }

  return normalized;
}

function normalizeAuthData(
  profileKind: AuthProfileKind,
  raw: unknown
): Record<string, unknown> {
  if (profileKind === 'env' || profileKind === 'oauth_app') {
    return normalizeAuthValues(raw);
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  return raw as Record<string, unknown>;
}

type BrowserCookie = {
  name?: string;
  expires?: number;
};

function scoreAuthCookie(cookie: BrowserCookie, connectorKey?: string | null): number {
  const name = cookie.name?.toLowerCase() ?? '';
  if (!name) return Number.NEGATIVE_INFINITY;

  if (connectorKey === 'linkedin' && name === 'li_at') return 1_000;
  if (connectorKey === 'x' && name === 'auth_token') return 1_000;

  if (/^(lang|li_theme|timezone|theme|locale|tz|visitor_id|guest_id)$/.test(name)) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;
  if (/(auth|token|session|sess|sid|jwt)/.test(name)) score += 100;
  if (/_at$/.test(name)) score += 80;
  if ((cookie.expires ?? 0) > 0) score += 5;
  return score;
}

function findLikelyBrowserAuthCookie(
  authData: Record<string, unknown> | null | undefined,
  connectorKey?: string | null
): BrowserCookie | null {
  const cookies = Array.isArray(authData?.cookies) ? (authData.cookies as BrowserCookie[]) : [];
  const sorted = [...cookies].sort(
    (a, b) => scoreAuthCookie(b, connectorKey) - scoreAuthCookie(a, connectorKey)
  );
  const best = sorted[0];
  return best && scoreAuthCookie(best, connectorKey) > 0 ? best : null;
}

export function summarizeBrowserSessionAuthData(
  authData: Record<string, unknown> | null | undefined,
  connectorKey?: string | null
): BrowserSessionSummary {
  const cookies = Array.isArray(authData?.cookies) ? authData.cookies : [];
  const cdpUrl =
    typeof authData?.cdp_url === 'string' && authData.cdp_url.trim().length > 0
      ? authData.cdp_url.trim()
      : null;
  const authCookie = findLikelyBrowserAuthCookie(authData, connectorKey);
  const expiresAt =
    authCookie && typeof authCookie.expires === 'number' && authCookie.expires > 0
      ? new Date(authCookie.expires * 1000).toISOString()
      : null;

  return {
    auth_mode: cdpUrl ? 'cdp' : cookies.length > 0 ? 'cookies' : 'empty',
    cookie_count: cookies.length,
    captured_at: typeof authData?.captured_at === 'string' ? authData.captured_at : null,
    auth_cookie_name: typeof authCookie?.name === 'string' ? authCookie.name : null,
    expires_at: expiresAt,
    is_expired: expiresAt ? new Date(expiresAt).getTime() < Date.now() : false,
    cdp_url: cdpUrl,
  };
}

async function resolveReachableBrowserSessionCdpUrl(cdpUrl: string | null): Promise<string | null> {
  const configuredUrl = cdpUrl?.trim();
  if (!configuredUrl) return null;

  try {
    const { fetchCdpVersionInfo, resolveCdpUrl } = await import('@lobu/connector-sdk');

    if (configuredUrl.toLowerCase() === 'auto') {
      return await resolveCdpUrl('auto');
    }

    const normalizedUrl = configuredUrl.replace(/\/+$/, '');
    const info = await fetchCdpVersionInfo(normalizedUrl);
    return info ? normalizedUrl : null;
  } catch {
    return null;
  }
}

export async function getBrowserSessionReadiness(
  authData: Record<string, unknown> | null | undefined,
  connectorKey?: string | null
): Promise<BrowserSessionReadiness> {
  const summary = summarizeBrowserSessionAuthData(authData, connectorKey);
  if (summary.cdp_url) {
    const resolvedCdpUrl = await resolveReachableBrowserSessionCdpUrl(summary.cdp_url);
    return {
      ...summary,
      usable: !!resolvedCdpUrl,
      resolved_cdp_url: resolvedCdpUrl,
    };
  }

  return {
    ...summary,
    usable: summary.cookie_count > 0 && !!summary.auth_cookie_name && !summary.is_expired,
    resolved_cdp_url: null,
  };
}

export function browserSessionIsUsable(
  authData: Record<string, unknown> | null | undefined,
  connectorKey?: string | null
): boolean {
  const summary = summarizeBrowserSessionAuthData(authData, connectorKey);
  return summary.cookie_count > 0 && !!summary.auth_cookie_name && !summary.is_expired;
}

function sanitizeProfileSlug(value: string): string {
  const slug = generateSlug(value);
  if (!slug) {
    throw new Error('Auth profile slug must contain at least one letter or number');
  }
  if (slug.length > 80) {
    throw new Error('Auth profile slug must be at most 80 characters');
  }
  return slug;
}

export function normalizeAuthProfileSlug(value?: string | null, fallback?: string | null): string {
  const source = value?.trim() || fallback?.trim() || '';
  return sanitizeProfileSlug(source);
}

export async function ensureUniqueAuthProfileSlug(params: {
  organizationId: string;
  slug: string;
  excludeId?: number | null;
}): Promise<string> {
  const sql = getDb();
  const baseSlug = sanitizeProfileSlug(params.slug);
  let candidate = baseSlug;
  let suffix = 2;

  for (;;) {
    const rows = await sql`
      SELECT id
      FROM auth_profiles
      WHERE organization_id = ${params.organizationId}
        AND slug = ${candidate}
        AND (${params.excludeId ?? null}::bigint IS NULL OR id <> ${params.excludeId ?? null}::bigint)
      LIMIT 1
    `;

    if (rows.length === 0) {
      return candidate;
    }

    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
}

const AUTH_PROFILE_COLUMNS = `
  id, organization_id, slug, display_name, connector_key,
  profile_kind, status, auth_data, account_id, provider,
  created_by, created_at, updated_at
` as const;

export async function listAuthProfiles(params: {
  organizationId: string;
  connectorKey?: string | null;
  profileKind?: AuthProfileKind | null;
  provider?: string | null;
}): Promise<AuthProfileRow[]> {
  const sql = getDb();

  // oauth_app profiles are provider-scoped — include them when filtering by connector_key
  // if the connector has an OAuth provider
  const rows = await sql`
    SELECT ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
    FROM auth_profiles
    WHERE organization_id = ${params.organizationId}
      AND (${params.profileKind ?? null}::text IS NULL OR profile_kind = ${params.profileKind ?? null})
      AND (${params.provider ?? null}::text IS NULL OR lower(provider) = lower(${params.provider ?? null}))
      AND (
        ${params.connectorKey ?? null}::text IS NULL
        OR connector_key = ${params.connectorKey ?? null}
        OR (profile_kind = 'oauth_app' AND ${params.provider ?? null}::text IS NOT NULL AND lower(provider) = lower(${params.provider ?? null}))
      )
    ORDER BY connector_key ASC, profile_kind ASC, display_name ASC, slug ASC
  `;

  return rows as unknown as AuthProfileRow[];
}

export async function getAuthProfileBySlug(
  organizationId: string,
  slug: string
): Promise<AuthProfileRow | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
    FROM auth_profiles
    WHERE organization_id = ${organizationId}
      AND slug = ${slug}
    LIMIT 1
  `;

  return rows.length > 0 ? (rows[0] as AuthProfileRow) : null;
}

export async function getAuthProfileById(
  organizationId: string,
  id: number | null | undefined
): Promise<AuthProfileRow | null> {
  if (!id || !Number.isFinite(id)) return null;

  const sql = getDb();
  const rows = await sql`
    SELECT ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
    FROM auth_profiles
    WHERE organization_id = ${organizationId}
      AND id = ${id}
    LIMIT 1
  `;

  return rows.length > 0 ? (rows[0] as AuthProfileRow) : null;
}

export async function createAuthProfile(params: {
  organizationId: string;
  connectorKey: string;
  displayName: string;
  slug?: string | null;
  profileKind: AuthProfileKind;
  authData?: Record<string, unknown>;
  accountId?: string | null;
  provider?: string | null;
  status?: AuthProfileStatus;
  createdBy?: string | null;
}): Promise<AuthProfileRow> {
  const sql = getDb();
  const slug = await ensureUniqueAuthProfileSlug({
    organizationId: params.organizationId,
    slug: normalizeAuthProfileSlug(params.slug, params.displayName),
  });

  const rows = await sql`
    INSERT INTO auth_profiles (
      organization_id,
      slug,
      display_name,
      connector_key,
      profile_kind,
      status,
      auth_data,
      account_id,
      provider,
      created_by
    ) VALUES (
      ${params.organizationId},
      ${slug},
      ${params.displayName},
      ${params.connectorKey},
      ${params.profileKind},
      ${params.status ?? 'active'},
      ${sql.json(normalizeAuthData(params.profileKind, params.authData ?? {}))},
      ${params.accountId ?? null},
      ${params.provider ? params.provider.toLowerCase() : null},
      ${params.createdBy ?? null}
    )
    RETURNING ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
  `;

  return rows[0] as AuthProfileRow;
}

export async function updateAuthProfile(params: {
  organizationId: string;
  slug: string;
  displayName?: string;
  nextSlug?: string | null;
  authData?: Record<string, unknown>;
  status?: AuthProfileStatus;
  accountId?: string | null;
  provider?: string | null;
}): Promise<AuthProfileRow | null> {
  const existing = await getAuthProfileBySlug(params.organizationId, params.slug);
  if (!existing) return null;

  const sql = getDb();
  const nextSlug =
    params.nextSlug && params.nextSlug.trim().length > 0
      ? await ensureUniqueAuthProfileSlug({
          organizationId: params.organizationId,
          slug: normalizeAuthProfileSlug(params.nextSlug, existing.slug),
          excludeId: existing.id,
        })
      : existing.slug;

  const nextAuthData =
    params.authData === undefined
      ? normalizeAuthData(existing.profile_kind, existing.auth_data)
      : normalizeAuthData(existing.profile_kind, params.authData);

  const rows = await sql`
    UPDATE auth_profiles
    SET slug = ${nextSlug},
        display_name = COALESCE(${params.displayName ?? null}, display_name),
        auth_data = ${sql.json(nextAuthData)},
        status = COALESCE(${params.status ?? null}, status),
        account_id = COALESCE(${params.accountId ?? null}, account_id),
        provider = COALESCE(${params.provider ?? null}, provider),
        updated_at = NOW()
    WHERE organization_id = ${params.organizationId}
      AND id = ${existing.id}
    RETURNING ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
  `;

  return rows.length > 0 ? (rows[0] as AuthProfileRow) : null;
}

export async function deleteAuthProfile(
  organizationId: string,
  slug: string
): Promise<AuthProfileRow | null> {
  const sql = getDb();
  const rows = await sql`
    DELETE FROM auth_profiles
    WHERE organization_id = ${organizationId}
      AND slug = ${slug}
    RETURNING ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
  `;

  return rows.length > 0 ? (rows[0] as AuthProfileRow) : null;
}

export async function getPrimaryAuthProfileForKind(params: {
  organizationId: string;
  connectorKey: string;
  profileKind: AuthProfileKind;
  provider?: string | null;
}): Promise<AuthProfileRow | null> {
  const sql = getDb();

  if (params.profileKind === 'oauth_app' && params.provider) {
    const rows = await sql`
      SELECT ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
      FROM auth_profiles
      WHERE organization_id = ${params.organizationId}
        AND profile_kind = 'oauth_app'
        AND status = 'active'
        AND (
          connector_key = ${params.connectorKey}
          OR lower(provider) = lower(${params.provider})
        )
      ORDER BY
        CASE WHEN connector_key = ${params.connectorKey} THEN 0 ELSE 1 END,
        updated_at DESC,
        id DESC
      LIMIT 1
    `;

    return rows.length > 0 ? (rows[0] as AuthProfileRow) : null;
  }

  const rows = await sql`
    SELECT ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
    FROM auth_profiles
    WHERE organization_id = ${params.organizationId}
      AND profile_kind = ${params.profileKind}
      AND connector_key = ${params.connectorKey}
      AND status = 'active'
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `;

  return rows.length > 0 ? (rows[0] as AuthProfileRow) : null;
}

export async function resolveAuthProfileSlugToId(params: {
  organizationId: string;
  slug?: string | null;
  expectedKind?: AuthProfileKind | null;
  connectorKey?: string | null;
}): Promise<AuthProfileRow | null> {
  if (!params.slug || params.slug.trim().length === 0) return null;
  const profile = await getAuthProfileBySlug(params.organizationId, params.slug.trim());
  if (!profile) return null;
  if (params.expectedKind && profile.profile_kind !== params.expectedKind) return null;
  // oauth_app profiles are provider-scoped, so skip connector_key check for them
  if (
    params.connectorKey &&
    profile.profile_kind !== 'oauth_app' &&
    profile.connector_key !== params.connectorKey
  )
    return null;
  return profile;
}
