import { getDb } from '../db/client';
import type { Env } from '../index';
import { getPrimaryAuthProfileForKind, normalizeAuthValues } from '../utils/auth-profiles';
import { TtlCache } from '../utils/ttl-cache';
import { safeParseUrl } from './base-url';

interface AuthConfig {
  social: Record<string, boolean>;
  magicLink: boolean;
  phone: boolean;
  emailPassword: boolean;
}

type TokenEndpointAuthMethod = 'client_secret_post' | 'client_secret_basic' | 'none';

interface EnabledLoginProviderConfig {
  connectorKey: string;
  provider: string;
  loginScopes: string[];
  clientIdKey: string;
  clientSecretKey: string;
  tokenUrl?: string;
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
}

interface AuthConfigOptions {
  request?: Request;
  organizationId?: string | null;
}

type OAuthMethod = {
  type: string;
  provider?: string;
  requiredScopes?: string[];
  loginScopes?: string[];
  clientIdKey?: string;
  clientSecretKey?: string;
  tokenUrl?: string;
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  loginProvisioning?: {
    autoCreateConnection?: boolean;
  };
};

type LoginProviderConfigRow = {
  key: string;
  auth_schema: { methods?: OAuthMethod[] } | string | null;
};

function normalizeScopes(scopes: readonly string[] | undefined): string[] | null {
  if (!scopes) return null;
  const normalized = scopes.map((scope) => scope.trim()).filter((scope) => scope.length > 0);
  return normalized.length > 0 ? normalized : null;
}

/**
 * Returns the login scopes declared by the connector method, or null if none.
 * Login support is connector-owned: a connector opts into sign-in by declaring
 * `loginScopes` on its oauth method. Core never assumes scopes for a provider.
 */
export function getLoginProviderScopes(
  _provider: string,
  explicitScopes?: readonly string[]
): string[] | null {
  return normalizeScopes(explicitScopes);
}

export function isSupportedLoginProvider(
  provider: string,
  explicitScopes?: readonly string[]
): boolean {
  return getLoginProviderScopes(provider, explicitScopes) !== null;
}

function getOAuthMethodsFromSchema(
  authSchema: LoginProviderConfigRow['auth_schema']
): OAuthMethod[] {
  const parsedAuthSchema =
    typeof authSchema === 'string'
      ? (() => {
          try {
            return JSON.parse(authSchema) as { methods?: OAuthMethod[] };
          } catch {
            return null;
          }
        })()
      : authSchema;

  return parsedAuthSchema?.methods ?? [];
}

function unionScopes(...scopeLists: Array<readonly string[] | null | undefined>): string[] {
  return Array.from(
    new Set(
      scopeLists
        .flatMap((scopes) => scopes ?? [])
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0)
    )
  );
}

function collectProvisioningScopesByProvider(
  rows: LoginProviderConfigRow[]
): Map<string, string[]> {
  const scopesByProvider = new Map<string, string[]>();

  for (const row of rows) {
    const methods = getOAuthMethodsFromSchema(row.auth_schema);
    for (const method of methods) {
      if (method.type !== 'oauth' || typeof method.provider !== 'string') continue;
      if (!method.loginProvisioning?.autoCreateConnection) continue;
      const provider = method.provider.trim().toLowerCase();
      if (!provider) continue;
      scopesByProvider.set(
        provider,
        unionScopes(scopesByProvider.get(provider), method.requiredScopes ?? [])
      );
    }
  }

  return scopesByProvider;
}

export function collectEnabledLoginProviderConfigs(
  rows: LoginProviderConfigRow[],
  provisioningScopesByProvider?: Map<string, string[]>
): EnabledLoginProviderConfig[] {
  const configs: EnabledLoginProviderConfig[] = [];
  const seenProviders = new Map<string, string>();

  for (const row of rows) {
    const connectorKey = String(row.key);
    const methods = getOAuthMethodsFromSchema(row.auth_schema);

    for (const method of methods) {
      if (method.type !== 'oauth' || typeof method.provider !== 'string') continue;

      const provider = method.provider.trim().toLowerCase();
      if (!provider) continue;

      const loginScopes = unionScopes(
        getLoginProviderScopes(provider, method.loginScopes),
        provisioningScopesByProvider?.get(provider)
      );
      if (loginScopes.length === 0) {
        console.warn(
          `[Auth] Ignoring login-enabled connector '${connectorKey}' for unsupported provider '${provider}'.`
        );
        continue;
      }

      const existingConnectorKey = seenProviders.get(provider);
      if (existingConnectorKey) {
        if (existingConnectorKey !== connectorKey) {
          console.warn(
            `[Auth] Multiple login-enabled connectors configured for provider '${provider}'. ` +
              `Using '${existingConnectorKey}' and ignoring '${connectorKey}'.`
          );
        }
        continue;
      }

      const providerUpper = provider.toUpperCase();
      seenProviders.set(provider, connectorKey);
      configs.push({
        connectorKey,
        provider,
        loginScopes,
        clientIdKey: hasValue(method.clientIdKey)
          ? method.clientIdKey!
          : `${providerUpper}_CLIENT_ID`,
        clientSecretKey: hasValue(method.clientSecretKey)
          ? method.clientSecretKey!
          : `${providerUpper}_CLIENT_SECRET`,
        ...(hasValue(method.tokenUrl) && { tokenUrl: method.tokenUrl }),
        ...(method.tokenEndpointAuthMethod && {
          tokenEndpointAuthMethod: method.tokenEndpointAuthMethod,
        }),
      });
    }
  }

  return configs;
}

function hasValue(value?: string): boolean {
  return Boolean(value && value.trim().length > 0);
}

const RESERVED_TOP_LEVEL_ROUTES = new Set([
  'api',
  'auth',
  'connect',
  'dashboard',
  'oauth',
  'account',
]);

function extractSlugFromPath(pathname: string): string | null {
  const firstSegment = pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)[0];
  if (!firstSegment) return null;
  if (RESERVED_TOP_LEVEL_ROUTES.has(firstSegment.toLowerCase())) return null;
  return firstSegment;
}

function addSlugFromUrl(rawUrl: string | undefined | null, target: Set<string>): void {
  const parsed = safeParseUrl(rawUrl, 'http://localhost');
  if (!parsed) return;
  const slug = extractSlugFromPath(parsed.pathname);
  if (slug) target.add(slug);

  const nestedCallbackUrl =
    parsed.searchParams.get('callbackURL') || parsed.searchParams.get('callbackUrl');
  if (nestedCallbackUrl && nestedCallbackUrl !== rawUrl) {
    addSlugFromUrl(nestedCallbackUrl, target);
  }
}

async function extractCandidateOrgSlugs(request?: Request): Promise<string[]> {
  if (!request) return [];

  const slugs = new Set<string>();
  addSlugFromUrl(request.url, slugs);
  addSlugFromUrl(request.headers.get('referer'), slugs);

  try {
    const requestUrl = new URL(request.url);
    addSlugFromUrl(requestUrl.searchParams.get('callbackURL'), slugs);
    addSlugFromUrl(requestUrl.searchParams.get('callbackUrl'), slugs);
  } catch {
    // Ignore invalid request URL.
  }

  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (request.method.toUpperCase() === 'POST' && contentType.includes('application/json')) {
    try {
      const body = (await request.clone().json()) as Record<string, unknown>;
      const callbackRaw =
        (typeof body.callbackURL === 'string' && body.callbackURL) ||
        (typeof body.callbackUrl === 'string' && body.callbackUrl) ||
        null;
      addSlugFromUrl(callbackRaw, slugs);
    } catch {
      // Ignore malformed body.
    }
  }

  return Array.from(slugs);
}

export async function resolveRequestOrganizationId(request?: Request): Promise<string | null> {
  const candidateSlugs = await extractCandidateOrgSlugs(request);
  if (candidateSlugs.length === 0) return null;

  const db = getDb();
  for (const slug of candidateSlugs) {
    const rows = await db`
      SELECT id
      FROM "organization"
      WHERE slug = ${slug}
      LIMIT 1
    `;
    if (rows.length > 0) {
      return String((rows[0] as { id: string }).id);
    }
  }

  return null;
}

export async function resolveLoginProviderCredentials(params: {
  env: Env;
  provider: string;
  connectorKey: string;
  clientIdKey?: string;
  clientSecretKey?: string;
  organizationId?: string | null;
}): Promise<{ clientId: string | null; clientSecret: string | null }> {
  const providerUpper = params.provider.toUpperCase();
  const clientIdKey = params.clientIdKey || `${providerUpper}_CLIENT_ID`;
  const clientSecretKey = params.clientSecretKey || `${providerUpper}_CLIENT_SECRET`;

  const appProfile = params.organizationId
    ? await getPrimaryAuthProfileForKind({
        organizationId: params.organizationId,
        connectorKey: params.connectorKey,
        profileKind: 'oauth_app',
        provider: params.provider,
      })
    : null;

  const authValues = normalizeAuthValues(appProfile?.auth_data ?? {});
  const envRecord = params.env as Record<string, string | undefined>;
  const clientId =
    authValues[clientIdKey] || envRecord[clientIdKey] || process.env[clientIdKey] || null;
  const clientSecret =
    authValues[clientSecretKey] ||
    envRecord[clientSecretKey] ||
    process.env[clientSecretKey] ||
    null;
  return { clientId, clientSecret };
}

/**
 * Get enabled OAuth login provider configs from connector_definitions.
 *
 * When organizationId is null (e.g. login page without org context),
 * falls back to AUTH_DEFAULT_ORGANIZATION_SLUG if configured.
 */
const loginProviderCache = new TtlCache<EnabledLoginProviderConfig[]>(60_000);
const defaultOrgCache = new TtlCache<string | null>(60_000);

export async function resolveDefaultOrganizationId(): Promise<string | null> {
  const defaultSlug = process.env.AUTH_DEFAULT_ORGANIZATION_SLUG;
  if (!defaultSlug) return null;
  const cached = defaultOrgCache.get(defaultSlug);
  if (cached !== undefined) return cached;
  const db = getDb();
  const rows = await db`SELECT id FROM "organization" WHERE slug = ${defaultSlug} LIMIT 1`;
  const id = rows.length > 0 ? String((rows[0] as { id: string }).id) : null;
  defaultOrgCache.set(defaultSlug, id);
  return id;
}

export async function getEnabledLoginProviderConfigs(
  organizationId?: string | null
): Promise<EnabledLoginProviderConfig[]> {
  let effectiveOrgId = organizationId ?? null;

  if (!effectiveOrgId) {
    effectiveOrgId = await resolveDefaultOrganizationId();
  }

  if (!effectiveOrgId) return [];

  const cacheKey = effectiveOrgId;
  const cached = loginProviderCache.get(cacheKey);
  if (cached) return cached;

  const db = getDb();
  const rows = await db`
    SELECT key, auth_schema
    FROM connector_definitions
    WHERE login_enabled = true
      AND status = 'active'
      AND organization_id = ${effectiveOrgId}
    ORDER BY key ASC
  `;
  const allActiveRows = await db`
    SELECT key, auth_schema
    FROM connector_definitions
    WHERE status = 'active'
      AND organization_id = ${effectiveOrgId}
    ORDER BY key ASC
  `;

  const configs = collectEnabledLoginProviderConfigs(
    rows as LoginProviderConfigRow[],
    collectProvisioningScopesByProvider(allActiveRows as LoginProviderConfigRow[])
  );

  loginProviderCache.set(cacheKey, configs);
  return configs;
}

/**
 * Get auth configuration by checking connector definitions and resolved OAuth credentials.
 */
export async function getAuthConfig(
  env: Env,
  options: AuthConfigOptions = {}
): Promise<AuthConfig> {
  let organizationId =
    options.organizationId !== undefined
      ? options.organizationId
      : ((await resolveRequestOrganizationId(options.request)) ?? null);
  if (!organizationId) {
    organizationId = await resolveDefaultOrganizationId();
  }
  const providerConfigs = await getEnabledLoginProviderConfigs(organizationId);
  const runtimeNodeEnv = env.NODE_ENV || process.env.NODE_ENV || 'development';
  const isProduction = runtimeNodeEnv === 'production';

  const social: AuthConfig['social'] = {};

  for (const config of providerConfigs) {
    const { clientId, clientSecret } = await resolveLoginProviderCredentials({
      env,
      provider: config.provider,
      connectorKey: config.connectorKey,
      clientIdKey: config.clientIdKey,
      clientSecretKey: config.clientSecretKey,
      organizationId,
    });
    if (hasValue(clientId ?? undefined) && hasValue(clientSecret ?? undefined)) {
      social[config.provider] = true;
    }
  }

  const magicLink = hasValue(env.RESEND_API_KEY) || !isProduction;
  const phone =
    hasValue(env.TWILIO_SID) && hasValue(env.TWILIO_TOKEN) && hasValue(env.TWILIO_WHATSAPP_NUMBER);
  const hasProviderAuthEnabled = Object.values(social).some(Boolean) || phone;
  const emailPassword =
    hasValue(env.BETTER_AUTH_SECRET) || (!isProduction && !hasProviderAuthEnabled);

  return { social, magicLink, phone, emailPassword };
}
