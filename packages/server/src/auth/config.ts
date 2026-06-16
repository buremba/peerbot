import { getDb } from '../db/client';
import type { Env } from '../index';
import { getPrimaryAuthProfileForKind, normalizeAuthValues } from '../utils/auth-profiles';
import { listCatalogConnectorDefinitions } from '../utils/connector-catalog';
import { TtlCache } from '../utils/ttl-cache';
import { safeParseUrl } from './base-url';

interface AuthConfig {
  social: Record<string, boolean>;
  magicLink: boolean;
  phone: boolean;
  emailPassword: boolean;
  passkey: boolean;
  // True iff this deployment runs in single-user mode (LOBU_SINGLE_USER=1).
  // The SPA branches signup/sign-in copy on this — "Set up your local install"
  // vs "Sign up for Lobu" — and skips affordances that don't apply.
  singleUserMode: boolean;
  // True iff at least one (non-legacy-bootstrap) user already exists. The SPA
  // routes `/` → /sign-up when this is false in single-user mode, so the
  // operator lands on the right page on first launch without typing a URL.
  hasUser: boolean;
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

export function collectEnabledLoginProviderConfigs(
  rows: LoginProviderConfigRow[],
  // The catalog-derived baseline scans EVERY bundled connector, so it expects to
  // see OAuth connectors without login scopes (e.g. read-only feed connectors)
  // and several connectors per provider (calendar/gmail/youtube all = google).
  // Those are normal there, not misconfiguration — `quiet` suppresses the warns
  // that are only meaningful for an explicit per-org `login_enabled` set.
  options: { quiet?: boolean } = {}
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

      const loginScopes = getLoginProviderScopes(provider, method.loginScopes);
      if (!loginScopes || loginScopes.length === 0) {
        if (!options.quiet) {
          console.warn(
            `[Auth] Ignoring login-enabled connector '${connectorKey}' for unsupported provider '${provider}'.`
          );
        }
        continue;
      }

      const existingConnectorKey = seenProviders.get(provider);
      if (existingConnectorKey) {
        if (existingConnectorKey !== connectorKey && !options.quiet) {
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
 * Global baseline login providers.
 *
 * Every bundled connector that declares `loginScopes` is a login candidate on
 * every deployment, independent of any organization. Whether a candidate
 * actually renders is decided downstream by credential resolution (env vars or
 * an org's OAuth-app auth profile) — see getAuthConfig / createAuth.
 *
 * This is the connector-owned model applied globally: core still never assumes
 * scopes for a provider (the connector declares them), it just no longer needs
 * a designated "default org" to carry the standard providers. The old
 * AUTH_DEFAULT_ORGANIZATION_SLUG pointer — and the silent empty-provider page
 * for any org that hadn't enabled its own connectors — are gone.
 */
const loginProviderCache = new TtlCache<EnabledLoginProviderConfig[]>(60_000);
const baselineProviderCache = new TtlCache<EnabledLoginProviderConfig[]>(60_000);
const BASELINE_CACHE_KEY = '__baseline__';

/**
 * Drop the cached baseline + per-org provider configs. Tests that vary the
 * catalog or org connector rows between cases must call this, or a stale 60s
 * cache entry serves the wrong set.
 */
export function clearLoginProviderCachesForTests(): void {
  loginProviderCache.clear();
  baselineProviderCache.clear();
}

async function getBaselineLoginProviderConfigs(): Promise<EnabledLoginProviderConfig[]> {
  const cached = baselineProviderCache.get(BASELINE_CACHE_KEY);
  if (cached) return cached;

  // Same catalog source the connector picker uses (manage_connections passes
  // env.CONNECTOR_CATALOG_URIS); defaults to the bundled connectors next to the
  // server, which ship a prebuilt manifest so this is a cheap lookup, not a
  // cold compile of every connector.
  const defs = await listCatalogConnectorDefinitions(process.env.CONNECTOR_CATALOG_URIS);
  const rows: LoginProviderConfigRow[] = defs.map((def) => ({
    key: def.key,
    auth_schema: (def.auth_schema as LoginProviderConfigRow['auth_schema']) ?? null,
  }));
  const configs = collectEnabledLoginProviderConfigs(rows, { quiet: true });

  baselineProviderCache.set(BASELINE_CACHE_KEY, configs);
  return configs;
}

/**
 * Merge org-specific login providers onto the global baseline. An org bringing
 * its own OAuth app for a provider (e.g. `google`) shadows the global one for
 * that provider; everything else is additive. The union guarantees a branded
 * org login page can never silently end up with *fewer* providers than the
 * default — it can only add. (Narrowing to org-only — enterprise SSO-only mode
 * — would be a future explicit flag, deliberately not inferred here.)
 */
export function mergeLoginProviderConfigs(
  baseline: EnabledLoginProviderConfig[],
  orgConfigs: EnabledLoginProviderConfig[]
): EnabledLoginProviderConfig[] {
  const byProvider = new Map<string, EnabledLoginProviderConfig>();
  for (const config of baseline) byProvider.set(config.provider, config);
  for (const config of orgConfigs) byProvider.set(config.provider, config);
  return Array.from(byProvider.values());
}

export async function getEnabledLoginProviderConfigs(
  organizationId?: string | null
): Promise<EnabledLoginProviderConfig[]> {
  const baseline = await getBaselineLoginProviderConfigs();
  const orgId = organizationId ?? null;
  if (!orgId) return baseline;

  const cached = loginProviderCache.get(orgId);
  if (cached) return mergeLoginProviderConfigs(baseline, cached);

  const db = getDb();
  const rows = await db`
    SELECT key, auth_schema
    FROM connector_definitions
    WHERE login_enabled = true
      AND status = 'active'
      AND organization_id = ${orgId}
    ORDER BY key ASC
  `;
  const orgConfigs = collectEnabledLoginProviderConfigs(rows as LoginProviderConfigRow[]);

  loginProviderCache.set(orgId, orgConfigs);
  return mergeLoginProviderConfigs(baseline, orgConfigs);
}

/**
 * Get auth configuration by checking connector definitions and resolved OAuth credentials.
 */
export async function getAuthConfig(
  env: Env,
  options: AuthConfigOptions = {}
): Promise<AuthConfig> {
  const organizationId =
    options.organizationId !== undefined
      ? options.organizationId
      : ((await resolveRequestOrganizationId(options.request)) ?? null);
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

  // Magic-link requires actual email delivery. Without RESEND_API_KEY,
  // Better Auth's plugin logs the magic URL to server stdout instead of
  // emailing it — useful for debugging, useless to a real operator who's
  // staring at their inbox. Hide the "Send me a magic link" affordance
  // when delivery isn't configured. (Previously this also returned true
  // in non-production, which made local dev render a dead button that
  // appears to work then silently does nothing.)
  const magicLink = hasValue(env.RESEND_API_KEY);
  const phone =
    hasValue(env.TWILIO_SID) && hasValue(env.TWILIO_TOKEN) && hasValue(env.TWILIO_WHATSAPP_NUMBER);
  const hasProviderAuthEnabled = Object.values(social).some(Boolean) || phone;
  const emailPassword =
    hasValue(env.BETTER_AUTH_SECRET) || (!isProduction && !hasProviderAuthEnabled);
  // Passkey plugin is always wired (auth/index.tsx) — the gateway can verify
  // WebAuthn ceremonies regardless of env config.
  const passkey = true;
  const singleUserMode = env.LOBU_SINGLE_USER === '1';
  // Filter out the synthetic install_operator row (auto-provisioned at
  // boot in ensureInstallOperator) — it doesn't count as "the install
  // has a *human*". Real users include anyone signed up via the web UI.
  // See docs/install-operator-bootstrap.md.
  let hasUser = false;
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT EXISTS(
        SELECT 1 FROM "user"
         WHERE principal_kind <> 'install_operator'
      ) AS has_user
    `) as unknown as Array<{ has_user: boolean }>;
    hasUser = !!rows[0]?.has_user;
  } catch {
    // If the DB isn't reachable (very early boot / migrations still running),
    // fail closed: treat as "no user yet" so the SPA shows /sign-up. Worst
    // case is one extra page transition when the operator clicks something.
    hasUser = false;
  }

  return { social, magicLink, phone, emailPassword, passkey, singleUserMode, hasUser };
}
