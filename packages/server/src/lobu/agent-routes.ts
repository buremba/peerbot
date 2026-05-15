/**
 * Agent CRUD routes for the embedded Lobu gateway.
 *
 * All routes are org-scoped via mcpAuth middleware and orgContext.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encrypt, type AuthProfile, type SkillConfig } from '@lobu/core';
import { Hono } from 'hono';
import { mcpAuth } from '../auth/middleware';
import { getDb } from '../db/client';
import { providerOrgSecretName } from './stores/provider-secrets';
import { OAuthClient } from '../gateway/auth/oauth/client';
import { CLAUDE_PROVIDER } from '../gateway/auth/oauth/providers';
import { ChannelBindingService } from '../gateway/channels/binding-service';
import { createAuthProfileLabel } from '../gateway/auth/settings/auth-profiles-manager';
import type { Env } from '../index';
import { getConfiguredPublicOrigin } from '../utils/public-origin';
import { countRuntimeMessagingClientsByAgent } from './client-routes';
import { getChatInstanceManager, getLobuCoreServices } from './gateway';
import {
  AGENT_ID_PATTERN,
  createPostgresAgentConfigStore,
  createPostgresAgentConnectionStore,
} from './stores/postgres-stores';
import { orgContext } from './stores/org-context';

const routes = new Hono<{ Bindings: Env }>();

/**
 * Coerce an `array_agg` result into a real `string[]`. With the `::text` cast
 * the driver returns a JS array, but if some schema still hands back a raw
 * Postgres array literal (`'{telegram,slack}'`) we parse it rather than letting
 * a string leak to the UI, where `.map` would throw.
 */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    const inner = value.replace(/^\{/, '').replace(/\}$/, '').trim();
    if (!inner) return [];
    return inner.split(',').map((s) => s.replace(/^"|"$/g, '').trim());
  }
  return [];
}

const configStore = createPostgresAgentConfigStore();
const connectionStore = createPostgresAgentConnectionStore();

type ProviderAuthType = 'oauth' | 'device-code' | 'api-key';

type ProviderModelOption = {
  label: string;
  value: string;
  description?: string;
};

type CatalogProvider = {
  providerId: string;
  name: string;
  iconUrl: string;
  authType: ProviderAuthType;
  supportedAuthTypes: ProviderAuthType[];
  apiKeyInstructions: string;
  apiKeyPlaceholder: string;
  description: string;
  systemAvailable: boolean;
  models: ProviderModelOption[];
};

type ProvidersConfigFile = {
  providers?: Array<{
    id?: string;
    name?: string;
    description?: string;
    providers?: Array<{
      displayName?: string;
      iconUrl?: string;
      envVarName?: string;
      upstreamBaseUrl?: string;
      apiKeyInstructions?: string;
      apiKeyPlaceholder?: string;
      defaultModel?: string;
    }>;
  }>;
};

const DEFAULT_PROVIDER_REGISTRY_CONFIG_PATH = resolve(process.cwd(), 'config/providers.json');

function getProviderRegistryConfigPath(): string {
  return process.env.LOBU_PROVIDER_REGISTRY_PATH?.trim() || DEFAULT_PROVIDER_REGISTRY_CONFIG_PATH;
}

const FALLBACK_PROVIDER_CATALOG: CatalogProvider[] = [
  {
    providerId: 'claude',
    name: 'Claude',
    iconUrl: 'https://www.google.com/s2/favicons?domain=anthropic.com&sz=128',
    authType: 'oauth',
    supportedAuthTypes: ['oauth', 'api-key'],
    apiKeyInstructions:
      'Enter your <a href="https://console.anthropic.com/settings/keys" target="_blank" class="text-blue-600 underline">Anthropic API key</a>:',
    apiKeyPlaceholder: 'sk-ant-...',
    description: "Anthropic's Claude AI with OAuth authentication",
    systemAvailable: Boolean(
      process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN
    ),
    models: [
      { label: 'Claude Sonnet 4', value: 'claude-sonnet-4-20250514' },
      { label: 'Claude Opus 4', value: 'claude-opus-4-20250514' },
      { label: 'Claude Haiku 3.5', value: 'claude-haiku-3-5-20241022' },
    ],
  },
  {
    providerId: 'chatgpt',
    name: 'ChatGPT',
    iconUrl: 'https://www.google.com/s2/favicons?domain=chatgpt.com&sz=128',
    authType: 'device-code',
    supportedAuthTypes: ['device-code', 'api-key'],
    apiKeyInstructions:
      'Enter your <a href="https://platform.openai.com/api-keys" target="_blank" class="text-blue-600 underline">OpenAI API key</a>:',
    apiKeyPlaceholder: 'sk-...',
    description: "OpenAI's ChatGPT with device code authentication",
    systemAvailable: Boolean(process.env.OPENAI_API_KEY),
    models: [],
  },
];

function mergeCatalogProviders(
  primaryProviders: CatalogProvider[],
  secondaryProviders: CatalogProvider[]
): CatalogProvider[] {
  const byId = new Map(primaryProviders.map((provider) => [provider.providerId, provider]));

  for (const provider of secondaryProviders) {
    if (!byId.has(provider.providerId)) {
      byId.set(provider.providerId, provider);
    }
  }

  return Array.from(byId.values());
}

async function loadConfigDrivenProviderCatalog(): Promise<CatalogProvider[]> {
  const configPath = getProviderRegistryConfigPath();

  try {
    const rawConfig = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(rawConfig) as ProvidersConfigFile;

    return (parsed.providers ?? [])
      .flatMap((entry) => {
        const providerConfig = entry.providers?.[0];
        const providerId = entry.id?.trim();
        if (!providerConfig || !providerId) return [];

        const defaultModel = providerConfig.defaultModel?.trim();

        return [
          {
            providerId,
            name: providerConfig.displayName?.trim() || entry.name?.trim() || providerId,
            iconUrl: providerConfig.iconUrl?.trim() || '',
            authType: 'api-key' as const,
            supportedAuthTypes: ['api-key' as const],
            apiKeyInstructions: providerConfig.apiKeyInstructions?.trim() || '',
            apiKeyPlaceholder: providerConfig.apiKeyPlaceholder?.trim() || '',
            description: entry.description?.trim() || '',
            systemAvailable: Boolean(
              providerConfig.envVarName && process.env[providerConfig.envVarName]
            ),
            models: defaultModel ? [{ label: defaultModel, value: defaultModel }] : [],
          } satisfies CatalogProvider,
        ];
      })
      .filter((provider) => Boolean(provider.providerId));
  } catch {
    // Missing/invalid config file → no config-driven providers; the fallback
    // catalog still applies.
    return [];
  }
}

function normalizeRuntimeProvider(provider: any, models: ProviderModelOption[]): CatalogProvider {
  return {
    providerId: provider.providerId,
    name: provider.providerDisplayName,
    iconUrl: provider.providerIconUrl || '',
    authType: provider.authType || 'api-key',
    supportedAuthTypes: provider.supportedAuthTypes || [provider.authType || 'api-key'],
    apiKeyInstructions: provider.apiKeyInstructions || '',
    apiKeyPlaceholder: provider.apiKeyPlaceholder || '',
    description: provider.catalogDescription || '',
    systemAvailable:
      typeof provider.hasSystemKey === 'function' ? Boolean(provider.hasSystemKey()) : false,
    models,
  };
}

function getClaudeOAuthRuntime() {
  return {
    oauthClient: new OAuthClient(CLAUDE_PROVIDER),
    createAuthProfileLabel,
  };
}

// ── Route-level middleware ───────────────────────────────────────────────────
//
// Every agent route is org-scoped: it requires a valid auth context (`mcpAuth`)
// and runs inside an `orgContext` keyed on the caller's organization. Both used
// to be repeated per handler (`routes.get('/', mcpAuth, …)` plus a
// `withOrg(c, …)` wrapper); they're applied once here. Registered before any
// route handler below so they wrap all of them.

routes.use('*', mcpAuth);

routes.use('*', async (c, next) => {
  const orgId = c.get('organizationId');
  if (!orgId) return c.json({ error: 'Organization required' }, 401);
  return orgContext.run({ organizationId: orgId }, next);
});

/**
 * Admin-tier auth gate.
 *
 * Admin-tier routes (agent CRUD, connection mutations, anything called by
 * `lobu apply`) accept either:
 *   - a better-auth session (`authSource === 'session'`), or
 *   - a PAT/OAuth bearer that carries the `mcp:admin` scope.
 *
 * Read-only routes (list, get) keep using `mcpAuth` alone — a `mcp:read` PAT
 * is fine for those.
 *
 * Returns a Response when the request must be rejected; returns null when the
 * caller should proceed.
 */
function requireSessionOrAdminPat(c: any): Response | null {
  const authSource = c.get('authSource') as
    | 'session'
    | 'pat'
    | 'oauth'
    | null;

  if (authSource === 'session') {
    return null;
  }

  if (authSource === 'pat' || authSource === 'oauth') {
    const authInfo = c.get('mcpAuthInfo');
    const scopes: string[] = Array.isArray(authInfo?.scopes) ? authInfo.scopes : [];
    if (scopes.includes('mcp:admin')) {
      return null;
    }
    return c.json(
      {
        error: 'forbidden',
        error_description:
          'This route requires a web session or a token with mcp:admin scope.',
      },
      403
    );
  }

  return c.json({ error: 'Authentication required' }, 401);
}

/**
 * Strip secret material from a stored auth profile before returning it to the
 * web client. `user_auth_profiles` only ever holds refs (not plaintext), but
 * we still drop `credentialRef` / `metadata.*Ref` so the UI never sees them.
 * `credential` is surfaced as an empty string to match the client type — the
 * UI uses it only as "is a key already saved?" signal, never reads its value.
 */
function sanitizeAuthProfileForClient(profile: AuthProfile) {
  const metadata = profile.metadata
    ? {
        ...(profile.metadata.email ? { email: profile.metadata.email } : {}),
        ...(typeof profile.metadata.expiresAt === 'number'
          ? { expiresAt: profile.metadata.expiresAt }
          : {}),
        ...(profile.metadata.accountId ? { accountId: profile.metadata.accountId } : {}),
      }
    : undefined;
  return {
    id: profile.id,
    provider: profile.provider,
    model: profile.model,
    credential: '',
    label: profile.label,
    authType: profile.authType,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    createdAt: profile.createdAt,
  };
}

/** Whitelist client-supplied profile metadata down to the non-secret fields. */
function sanitizeClientProfileMetadata(
  metadata: AuthProfile['metadata']
): AuthProfile['metadata'] | undefined {
  if (!metadata) return undefined;
  const next = {
    ...(metadata.email ? { email: metadata.email } : {}),
    ...(typeof metadata.expiresAt === 'number' ? { expiresAt: metadata.expiresAt } : {}),
    ...(metadata.accountId ? { accountId: metadata.accountId } : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Reconcile the user-scoped auth profiles for `(userId, agentId)` against the
 * list the web client just submitted in a `PATCH /config` body.
 *
 *   - entries in `desired` that carry a non-empty `credential` are upserted
 *     first (the secret is written to the secret store, the ref to the profile
 *     JSON) — done before any removal so a failed write can't leave the user
 *     with fewer credentials than they started with.
 *   - profiles in the store but absent from `desired` are then removed (with
 *     their secrets), so deleting a provider row in the UI actually deletes it.
 *   - entries with an empty/absent `credential` are unchanged rows the client
 *     round-tripped — left as-is so the stored secret is preserved.
 *
 * Throws if the auth-profiles manager is unavailable; the caller surfaces that
 * rather than reporting a save that was dropped.
 */
async function reconcileAgentAuthProfiles(
  agentId: string,
  userId: string,
  desired: AuthProfile[]
): Promise<void> {
  const manager = getLobuCoreServices()?.getAuthProfilesManager?.();
  if (!manager) {
    throw new Error('Auth profile store is not available — retry once startup completes');
  }
  const store = manager.getUserAuthProfileStore();
  for (const profile of desired) {
    const credential = typeof profile.credential === 'string' ? profile.credential.trim() : '';
    if (!credential) continue;
    const metadata = sanitizeClientProfileMetadata(profile.metadata);
    await manager.upsertProfile({
      userId,
      agentId,
      id: profile.id,
      provider: profile.provider,
      credential,
      authType: profile.authType,
      label: profile.label,
      model: profile.model,
      ...(metadata ? { metadata } : {}),
      makePrimary: true,
    });
  }
  const desiredIds = new Set(desired.map((profile) => profile.id).filter(Boolean));
  const current = await store.list(userId, agentId);
  for (const existing of current) {
    if (!desiredIds.has(existing.id)) {
      await store.remove(userId, agentId, {
        provider: existing.provider,
        profileId: existing.id,
      });
    }
  }
}

/** True if the submitted profile list contains at least one fresh credential. */
function hasFreshCredential(profiles: AuthProfile[]): boolean {
  return profiles.some(
    (profile) => typeof profile.credential === 'string' && profile.credential.trim().length > 0
  );
}

// ── List agents ──────────────────────────────────────────────────────────────

routes.get('/', async (c) => {
  const agents = await configStore.listAgents();

  // Count connections per agent
  const sql = getDb();
  const orgId = c.get('organizationId')!;
  const connCounts = await sql`
    SELECT c.agent_id, count(*)::int as count
    FROM agent_connections c
    JOIN agents a ON a.id = c.agent_id
    WHERE a.organization_id = ${orgId}
    GROUP BY c.agent_id
  `;
  const countMap = new Map(connCounts.map((r: any) => [r.agent_id, r.count]));

  const activeConnCounts = await sql`
    SELECT c.agent_id, count(*)::int as count
    FROM agent_connections c
    JOIN agents a ON a.id = c.agent_id
    WHERE a.organization_id = ${orgId}
      AND c.status = 'active'
    GROUP BY c.agent_id
  `;
  const activeCountMap = new Map(activeConnCounts.map((r: any) => [r.agent_id, r.count]));

  const clientCountMap = new Map<string, Set<string>>();
  const runtimeClientCounts = await countRuntimeMessagingClientsByAgent(orgId);
  for (const [agentId, runtimeIds] of runtimeClientCounts.entries()) {
    let ids = clientCountMap.get(agentId);
    if (!ids) {
      ids = new Set<string>();
      clientCountMap.set(agentId, ids);
    }
    for (const clientId of runtimeIds) ids.add(clientId);
  }

  // Watchers owned by each agent (active only).
  const watcherCounts = await sql`
    SELECT agent_id, count(*)::int as count
    FROM watchers
    WHERE organization_id = ${orgId} AND status = 'active' AND agent_id IS NOT NULL
    GROUP BY agent_id
  `;
  const watcherCountMap = new Map(watcherCounts.map((r: any) => [r.agent_id, r.count]));

  // Distinct end-users per agent across messaging platforms.
  const userCounts = await sql`
    SELECT u.agent_id, count(DISTINCT (u.platform, u.user_id))::int as count
    FROM agent_users u
    JOIN agents a ON a.id = u.agent_id
    WHERE a.organization_id = ${orgId}
    GROUP BY u.agent_id
  `;
  const userCountMap = new Map(userCounts.map((r: any) => [r.agent_id, r.count]));

  // Distinct connection platforms per agent. Cast to text so the driver always
  // returns a JS array — array_agg over an enum/varchar column can come back as
  // a raw `'{telegram,slack}'` string when postgres.js has no array parser for
  // the element OID, which then blows up `.map` in the UI.
  const platformRows = await sql`
    SELECT c.agent_id, array_agg(DISTINCT c.platform::text) as platforms
    FROM agent_connections c
    JOIN agents a ON a.id = c.agent_id
    WHERE a.organization_id = ${orgId}
    GROUP BY c.agent_id
  `;
  const platformsMap = new Map(
    platformRows.map((r: any) => [r.agent_id, toStringArray(r.platforms)])
  );

  // Provider ids per agent, from the agent row's installed_providers list
  // (the canonical "which providers does this agent have" set).
  const providerRows = await sql`
    SELECT id, installed_providers
    FROM agents
    WHERE organization_id = ${orgId}
  `;
  const providersMap = new Map<string, string[]>();
  for (const r of providerRows) {
    const set = new Set<string>();
    for (const p of ((r as any).installed_providers ?? []) as any[]) {
      const id = p?.providerId ?? p?.provider;
      if (id) set.add(String(id));
    }
    providersMap.set((r as any).id, [...set]);
  }

  return c.json({
    agents: agents.map((a) => ({
      ...a,
      connectionCount: countMap.get(a.agentId) ?? 0,
      activeConnectionCount: activeCountMap.get(a.agentId) ?? 0,
      clientCount: clientCountMap.get(a.agentId)?.size ?? 0,
      watcherCount: watcherCountMap.get(a.agentId) ?? 0,
      userCount: userCountMap.get(a.agentId) ?? 0,
      platforms: platformsMap.get(a.agentId) ?? [],
      providers: providersMap.get(a.agentId) ?? [],
      status: (activeCountMap.get(a.agentId) ?? 0) > 0 ? 'active' : 'idle',
    })),
  });
});

// ── Create agent ─────────────────────────────────────────────────────────────

routes.post('/', async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  const body = await c.req.json<{
    agentId: string;
    name: string;
    description?: string;
  }>();
  const user = c.get('user');
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const { agentId, name, description } = body;
  if (!agentId || !name) return c.json({ error: 'agentId and name are required' }, 400);

  // Validate agentId format
  if (!AGENT_ID_PATTERN.test(agentId)) {
    return c.json(
      {
        error:
          'agentId must be 3-60 lowercase alphanumeric chars with hyphens, starting with a letter',
      },
      400
    );
  }

  const orgId = c.get('organizationId') as string;

  // Atomic create + auto-inject. Two concurrent `lobu apply` runs from the
  // same operator can both reach this endpoint with the same agentId. The
  // previous version did INSERT-then-saveSettings as two separate writes:
  // a "loser" returning 200 in the idempotent branch could see the row
  // before the winner's saveSettings landed, then immediately PATCH
  // `mcpServers` with operator config — only for the winner's deferred
  // saveSettings to clobber it moments later. Folding `mcp_servers` into
  // the same INSERT statement closes that gap: the row + auto-injected
  // MCP server land atomically and the loser's idempotent 200 already
  // reflects fully-initialized state.
  const sql = getDb();
  const now = new Date();
  const orgSlug = c.req.param('orgSlug');
  const publicUrl =
    getConfiguredPublicOrigin() || `http://localhost:${process.env.PORT || '8787'}`;
  const ownerMcpServers = {
    'lobu-memory': { url: `${publicUrl}/mcp/${orgSlug}`, type: 'streamable-http' },
  };
  const ownerPreApprovedTools = ['/mcp/lobu-memory/tools/*'];
  const inserted = await sql`
    INSERT INTO agents (
      id, organization_id, name, description, owner_platform, owner_user_id,
      mcp_servers, pre_approved_tools, created_at, updated_at
    )
    VALUES (
      ${agentId}, ${orgId}, ${name}, ${description ?? null},
      'lobu', ${user.id},
      ${sql.json(ownerMcpServers)}, ${sql.json(ownerPreApprovedTools)}, ${now}, ${now}
    )
    ON CONFLICT (organization_id, id) DO NOTHING
    RETURNING id
  `;

  if (inserted.length === 0) {
    // Another writer (or a previous apply cycle) already owns this id in
    // *this* org. Return idempotent 200 with the existing row's metadata.
    // Cross-org collisions are no longer possible — the PK is per-org now.
    const existing = await configStore.getMetadata(agentId);
    if (!existing) {
      return c.json({ error: 'Agent metadata missing' }, 500);
    }
    return c.json(
      {
        agentId,
        name: existing.name,
        description: existing.description,
      },
      200
    );
  }

  return c.json({ agentId, name, description }, 201);
});

// ── Get agent detail ─────────────────────────────────────────────────────────

routes.get('/:agentId', async (c) => {
  const { agentId } = c.req.param();
  const metadata = await configStore.getMetadata(agentId);
  if (!metadata) return c.json({ error: 'Agent not found' }, 404);

  const settings = await configStore.getSettings(agentId);
  const sql = getDb();
  const organizationId = c.get('organizationId') as string;
  const [connectionStats] = await sql`
    SELECT
      count(*)::int as connection_count,
      count(*) FILTER (WHERE status = 'active')::int as active_connection_count
    FROM agent_connections
    WHERE agent_id = ${agentId} AND organization_id = ${organizationId}
  `;
  const clientIds = new Set<string>();
  const runtimeClientCounts = await countRuntimeMessagingClientsByAgent(organizationId);
  for (const runtimeClientId of runtimeClientCounts.get(agentId) ?? []) {
    clientIds.add(runtimeClientId);
  }

  return c.json({
    ...metadata,
    settings,
    connectionCount: connectionStats?.connection_count ?? 0,
    activeConnectionCount: connectionStats?.active_connection_count ?? 0,
    clientCount: clientIds.size,
    status: (connectionStats?.active_connection_count ?? 0) > 0 ? 'active' : 'idle',
  });
});

// ── Update agent metadata ────────────────────────────────────────────────────

routes.patch('/:agentId', async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  const { agentId } = c.req.param();
  const body = await c.req.json<{ name?: string; description?: string }>();

  if (!(await configStore.hasAgent(agentId))) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  await configStore.updateMetadata(agentId, body);
  return c.json({ success: true });
});

// ── Delete agent ─────────────────────────────────────────────────────────────

routes.delete('/:agentId', async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  const { agentId } = c.req.param();

  if (!(await configStore.hasAgent(agentId))) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  // Cascade handled by FK ON DELETE CASCADE
  await configStore.deleteMetadata(agentId);
  return c.json({ success: true });
});

// ── Get agent config (settings) ──────────────────────────────────────────────

routes.get('/:agentId/config', async (c) => {
  const { agentId } = c.req.param();
  const settings = await configStore.getSettings(agentId);
  if (!settings) return c.json({ error: 'Agent not found' }, 404);

  // `configStore` doesn't carry auth profiles (they live in
  // `user_auth_profiles`, keyed by the requesting user). Merge the caller's
  // sanitized profiles in so the agent settings UI can show which providers
  // already have a credential connected.
  const user = c.get('user');
  const authProfilesManager = getLobuCoreServices()?.getAuthProfilesManager?.();
  const authProfiles =
    user?.id && authProfilesManager
      ? (await authProfilesManager.getUserAuthProfileStore().list(user.id, agentId)).map(
          sanitizeAuthProfileForClient
        )
      : [];

  return c.json({ ...settings, authProfiles });
});

// ── Get provider catalog and model options ───────────────────────────────────

routes.get('/:agentId/config/providers/catalog', async (c) => {
  const { agentId } = c.req.param();
  const settings = await configStore.getSettings(agentId);
  if (!settings) return c.json({ error: 'Agent not found' }, 404);

  const user = c.get('user');
  const installedProviders = settings.installedProviders ?? [];
  const installedIds = new Set(installedProviders.map((provider) => provider.providerId));

  const coreServices = getLobuCoreServices();
  const providerCatalogService = coreServices?.getProviderCatalogService?.();
  const catalogProviders = providerCatalogService?.listCatalogProviders?.() ?? [];

  const runtimeModels = Object.fromEntries(
    await Promise.all(
      catalogProviders.map(async (provider: any) => {
        try {
          if (typeof provider?.getModelOptions !== 'function' || !user?.id) {
            return [provider.providerId, []];
          }
          const options = await provider.getModelOptions(agentId, user.id);
          return [provider.providerId, Array.isArray(options) ? options : []];
        } catch {
          return [provider.providerId, []];
        }
      })
    )
  );
  const runtimeCatalog = catalogProviders.map((provider: any) =>
    normalizeRuntimeProvider(provider, runtimeModels[provider.providerId] ?? [])
  );
  const fallbackCatalog = mergeCatalogProviders(
    FALLBACK_PROVIDER_CATALOG,
    await loadConfigDrivenProviderCatalog()
  );
  const mergedCatalog = mergeCatalogProviders(runtimeCatalog, fallbackCatalog);
  const models = Object.fromEntries(
    mergedCatalog.map((provider) => [provider.providerId, provider.models])
  );
  const catalog = mergedCatalog.map(({ models: _models, ...provider }) => ({
    ...provider,
    installed: installedIds.has(provider.providerId),
  }));

  return c.json({
    catalog,
    installedProviders,
    models,
  });
});

// ── Get skills catalog ───────────────────────────────────────────────────────

routes.get('/config/skills/catalog', async (c) => {
  return c.json({ catalog: [], installedSkills: [] });
});

routes.get('/:agentId/config/skills/catalog', async (c) => {
  const { agentId } = c.req.param();
  const settings = await configStore.getSettings(agentId);
  if (!settings) return c.json({ error: 'Agent not found' }, 404);

  const installedSkills: SkillConfig[] = settings.skillsConfig?.skills ?? [];
  return c.json({ catalog: [], installedSkills });
});

// ── Start provider OAuth login ───────────────────────────────────────────────

routes.get('/:agentId/providers/:providerId/oauth/start', async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  const { agentId, providerId } = c.req.param();
  const user = c.get('user');
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  if (!(await configStore.hasAgent(agentId))) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  if (providerId !== 'claude') {
    return c.json({ error: 'OAuth start is not supported for this provider' }, 400);
  }

  const coreServices = getLobuCoreServices();
  const oauthStateStore = coreServices?.getOAuthStateStore?.();
  if (!oauthStateStore) {
    return c.json({ error: 'Embedded Lobu auth is not available' }, 503);
  }

  const { oauthClient } = getClaudeOAuthRuntime();
  const codeVerifier = oauthClient.generateCodeVerifier();
  const state = await oauthStateStore.create({
    userId: user.id,
    agentId,
    codeVerifier,
    context: { platform: 'web', channelId: agentId },
  });

  return c.redirect(oauthClient.buildAuthUrl(state, codeVerifier));
});

// ── Complete provider OAuth login ────────────────────────────────────────────

routes.post('/:agentId/providers/:providerId/oauth/code', async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  const { agentId, providerId } = c.req.param();
  const user = c.get('user');
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  if (!(await configStore.hasAgent(agentId))) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  if (providerId !== 'claude') {
    return c.json({ error: 'OAuth code exchange is not supported for this provider' }, 400);
  }

  const body = (await c.req.json<{ code?: string }>().catch(() => ({}))) as { code?: string };
  const input = body.code?.trim();
  if (!input) return c.json({ error: 'Missing OAuth code' }, 400);

  const parts = input.split('#');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return c.json({ error: 'OAuth code must be in code#state format' }, 400);
  }

  const coreServices = getLobuCoreServices();
  const authProfilesManager = coreServices?.getAuthProfilesManager?.();
  const oauthStateStore = coreServices?.getOAuthStateStore?.();
  if (!authProfilesManager || !oauthStateStore) {
    return c.json({ error: 'Embedded Lobu auth is not available' }, 503);
  }

  const stateData = await oauthStateStore.consume(parts[1].trim());
  if (!stateData) {
    return c.json({ error: 'OAuth state expired or is invalid' }, 400);
  }

  if (stateData.agentId !== agentId || stateData.userId !== user.id) {
    return c.json({ error: 'OAuth state does not match this agent session' }, 403);
  }
  const { oauthClient, createAuthProfileLabel } = getClaudeOAuthRuntime();

  try {
    const credentials = await oauthClient.exchangeCodeForToken(
      parts[0].trim(),
      stateData.codeVerifier,
      'https://console.anthropic.com/oauth/code/callback',
      parts[1].trim()
    );

    await authProfilesManager.upsertProfile({
      agentId,
      provider: providerId,
      credential: credentials.accessToken,
      authType: 'oauth',
      label: createAuthProfileLabel('Claude', credentials.accessToken),
      metadata: {
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
      },
      makePrimary: true,
    });

    return c.json({ success: true });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : 'OAuth exchange failed',
      },
      400
    );
  }
});

// ── Set the org-shared API key for a provider ────────────────────────────────
//
// Writes (or rotates) the org-wide API key declared via `lobu apply` from
// `[[agents.<id>.providers]] key = "$VAR"`. The key lands in `agent_secrets`
// under `provider:<id>:apiKey`, scoped to the org. The worker's credential
// resolution (base-provider-module.ts) checks per-user `auth_profiles` first,
// then this row, then `process.env` — so per-user BYOK still wins.
//
// `:agentId` is in the path so the auth/admin gate matches the rest of this
// router; the secret itself is org-scoped, not per-agent (one z-ai key for the
// whole org). PUT is idempotent; same name overwrites.

routes.put('/:agentId/providers/:providerId/api-key', async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  const { agentId, providerId } = c.req.param();

  if (!(await configStore.hasAgent(agentId))) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  let body: { value?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid or missing JSON body' }, 400);
  }
  const value = typeof body.value === 'string' ? body.value : '';
  if (!value) {
    return c.json({ error: 'Body must include a non-empty `value` string' }, 400);
  }

  const ciphertext = encrypt(value);
  const name = providerOrgSecretName(providerId);
  const orgId = (c.get('organizationId') as string | undefined) ?? null;
  if (!orgId) {
    return c.json({ error: 'Organization context not available' }, 500);
  }

  const sql = getDb();
  await sql`
    INSERT INTO agent_secrets (organization_id, name, ciphertext, created_at, updated_at)
    VALUES (${orgId}, ${name}, ${ciphertext}, now(), now())
    ON CONFLICT (organization_id, name) DO UPDATE SET
      ciphertext = EXCLUDED.ciphertext,
      updated_at = now()
  `;
  return c.json({ success: true, name });
});

// ── Update agent config (settings) ───────────────────────────────────────────

routes.patch('/:agentId/config', async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  const { agentId } = c.req.param();
  const updates = await c.req.json();

  if (!(await configStore.hasAgent(agentId))) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  // Auth profiles aren't part of the agent settings row — they're
  // user-scoped and live in `user_auth_profiles` with secrets in the secret
  // store. Pull them out of the settings patch and persist them through the
  // proper path; otherwise an api-key typed into the UI is silently dropped.
  const { authProfiles, ...settingsUpdates } = updates as {
    authProfiles?: AuthProfile[];
  } & Record<string, unknown>;
  if (Array.isArray(authProfiles)) {
    const user = c.get('user');
    if (!user?.id) {
      // Admin-PAT callers (`lobu apply`) manage declared-agent credentials
      // out of band; reject only if they actually tried to set one here.
      if (hasFreshCredential(authProfiles)) {
        return c.json(
          { error: 'Setting agent auth profiles requires a web session' },
          403
        );
      }
    } else {
      try {
        await reconcileAgentAuthProfiles(agentId, user.id, authProfiles);
      } catch (error) {
        return c.json(
          {
            error:
              error instanceof Error ? error.message : 'Failed to persist auth profiles',
          },
          503
        );
      }
    }
  }

  await configStore.updateSettings(agentId, settingsUpdates);
  return c.json({ success: true });
});

// ============================================================
// Channel bindings (chat channels/DMs routed to this agent)
//
// A binding is created by `/lobu link <code>` in a hosted preview workspace,
// by `lobu apply` (declarative connections), or by an admin. These routes let
// the agent's owner see "where is this agent reachable" and unbind a channel.
// Storage: `public.agent_channel_bindings` — see ChannelBindingService.
// ============================================================

const channelBindings = new ChannelBindingService();

routes.get('/:agentId/channel-bindings', async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  const { agentId } = c.req.param();
  if (!(await configStore.hasAgent(agentId))) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  const bindings = await channelBindings.listBindings(agentId);
  return c.json({
    bindings: bindings.map((b) => ({
      platform: b.platform,
      channelId: b.channelId,
      teamId: b.teamId ?? null,
      createdAt: b.createdAt,
    })),
  });
});

routes.delete('/:agentId/channel-bindings', async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  const { agentId } = c.req.param();
  if (!(await configStore.hasAgent(agentId))) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  let body: { platform?: string; channelId?: string; teamId?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid or missing JSON body' }, 400);
  }
  const platform = typeof body.platform === 'string' ? body.platform.trim() : '';
  const channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
  if (!platform || !channelId) {
    return c.json({ error: 'platform and channelId are required' }, 400);
  }
  const teamId =
    typeof body.teamId === 'string' && body.teamId.trim() ? body.teamId.trim() : undefined;
  const deleted = await channelBindings.deleteBinding(agentId, platform, channelId, teamId);
  if (!deleted) return c.json({ error: 'Binding not found for this agent' }, 404);
  return c.json({ success: true });
});

// ============================================================
// Platform routes (nested under /:agentId/platforms)
//
// Storage internals still live in the `agent_connections` table — the rename
// is user-facing only. ChatInstanceManager and the connection store keep
// their existing names because they're used by other (chat-side) callers.
// ============================================================

// ── List platforms ───────────────────────────────────────────────────────────

routes.get('/:agentId/platforms', async (c) => {
  const { agentId } = c.req.param();
  if (!(await configStore.hasAgent(agentId))) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  const chatManager = getChatInstanceManager();
  let platforms = await connectionStore.listConnections({
    agentId,
  });

  if (chatManager) {
    try {
      const runtimePlatforms = await chatManager.listConnections({
        agentId,
      });
      if (runtimePlatforms.length > 0) {
        platforms = runtimePlatforms;
      }
    } catch {
      // Fall back to PostgreSQL snapshot.
    }
  }

  return c.json({ platforms });
});

// ── Create platform ──────────────────────────────────────────────────────────

routes.post('/:agentId/platforms', async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  const { agentId } = c.req.param();
  if (!(await configStore.hasAgent(agentId))) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  const body = await c.req.json<{
    platform: string;
    config?: Record<string, unknown>;
    settings?: { allowFrom?: string[]; allowGroups?: boolean };
  }>();
  const { platform, config = {}, settings = {} } = body;
  if (!platform) return c.json({ error: 'platform is required' }, 400);

  const chatManager = getChatInstanceManager();
  if (chatManager) {
    try {
      const created = await chatManager.addConnection(
        platform,
        agentId,
        { platform, ...config },
        { allowGroups: true, ...settings }
      );
      return c.json({ platform: created }, 201);
    } catch (error: any) {
      return c.json({ error: error.message || 'Failed to create platform' }, 400);
    }
  }

  // No ChatInstanceManager — refuse the write rather than persist
  // plaintext secrets directly. Secret normalization (`secret://` ref
  // indirection) lives on the manager; bypassing it would leak bot
  // tokens into the agent_connections.config JSON.
  return c.json(
    { error: 'platform manager unavailable — retry once startup completes' },
    503
  );
});

// ── Upsert platform by stable ID ─────────────────────────────────────────────
//
// `lobu apply` derives a deterministic ID from `(agentId, type, name)` via
// buildStablePlatformId() and PUTs to this endpoint so re-runs converge:
// matching config → noop; changed config → update + restart; missing → create
// with the supplied ID (not random). The route trusts the stable ID — it's
// computed by the CLI from the same lobu.toml that produced the body.

// Namespace for pg_advisory_xact_lock(int4, int4). Kept in the signed int32
// range required by PostgreSQL's two-key advisory lock overload. Distinct
// from other advisory-lock namespaces in this codebase (e.g. personal-org
// has its own) so the locks never collide cross-feature.
const STABLE_PLATFORM_LOCK_NAMESPACE = 0x73746263; // "stbc"

/**
 * FNV-1a 32-bit hash of the stable ID. Computed in JS (rather than calling
 * Postgres's `hashtext()`) so the parameter passed to pg_advisory_xact_lock
 * is a plain int — postgres-js's parameter type inference and PGlite's
 * extended-query plan cache get tangled when nesting `hashtext(text)::int`
 * inside the lock's `(int, int)` signature. The deterministic JS hash gives
 * us the same contract: same stable ID → same lock key.
 */
function hashStableId(stableId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < stableId.length; i++) {
    hash ^= stableId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0; // signed int32
}

// In-process Promise chain for concurrent PUTs against the same stable ID.
// Lobu runs embedded-only (single Node process), so a per-key chain is
// strictly correct — every PUT enqueues against the previous PUT's
// completion before entering its critical section. We back this up with a
// Postgres advisory lock at the top of each entry as a structured signal
// (visible in `pg_locks`) and as defense-in-depth for hypothetical future
// multi-host writers.
const stablePlatformLockChains: Map<string, Promise<unknown>> = new Map();

/**
 * Run `fn` while serializing concurrent callers that pass the same `stableId`.
 *
 * Combines two layers:
 *
 *   1. **In-process per-stableId Promise chain** — primary serialization for
 *      the embedded single-process deployment. Strictly FIFO; no DB
 *      round-trips on the hot path beyond what `fn` itself does.
 *   2. **`pg_advisory_xact_lock(NAMESPACE, hashStableId(stableId))`** —
 *      acquired and released around a short-lived `BEGIN; ...; COMMIT;` at
 *      the top of each chain entry. Auto-releases on commit (per the
 *      `_xact_` semantics), which means the lock is gone before `fn` runs;
 *      we don't depend on it for serialization. It still gives us:
 *        - a structured `pg_locks` trace for diagnostics.
 *        - cross-process serialization if a future scale-out runs two
 *          gateway processes against the same DB.
 *
 * Wrapping the whole flow in a single `sql.begin(...)` is not viable: the
 * tx connection plus parent-pool writes via `connectionStore` /
 * `chatManager.addConnection` would self-deadlock both on the pglite-mode
 * serialized-client queue and on row-level locks against an uncommitted
 * placeholder row from a different connection.
 */
async function withStablePlatformLock<T>(stableId: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = hashStableId(stableId);
  const previous = stablePlatformLockChains.get(stableId) ?? Promise.resolve();
  const work = previous.then(async () => {
    // Touch the DB-side advisory lock so multi-host writers serialize too.
    // Inlined via unsafe() because the `(int, int)` overload confuses
    // PGlite's extended-query plan cache when other queries on the same
    // backend cycle through different parameter type oids; both inputs are
    // validated int32s, no SQL injection surface. Failure here is non-fatal —
    // the in-process chain still serializes for the embedded case.
    try {
      await getDb().unsafe(
        `BEGIN; SELECT pg_advisory_xact_lock(${STABLE_PLATFORM_LOCK_NAMESPACE}, ${lockKey}); COMMIT;`
      );
    } catch {
      // best-effort
    }
    return fn();
  });
  // Replace the chain head with a settled-Promise wrapper so a rejected `fn`
  // doesn't poison subsequent callers (they only need completion order, not
  // success). Drop the entry once it's the tail to keep the map bounded.
  const chainTail: Promise<void> = work.then(
    () => undefined,
    () => undefined
  );
  stablePlatformLockChains.set(stableId, chainTail);
  void chainTail.then(() => {
    if (stablePlatformLockChains.get(stableId) === chainTail) {
      stablePlatformLockChains.delete(stableId);
    }
  });
  return (await work) as T;
}

routes.put('/:agentId/platforms/by-stable-id/:stableId', async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  const { agentId, stableId } = c.req.param();
  if (!(await configStore.hasAgent(agentId))) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  const body = await c.req.json<{
    platform: string;
    config?: Record<string, unknown>;
    settings?: { allowFrom?: string[]; allowGroups?: boolean };
  }>();
  const { platform, config = {}, settings = {} } = body;
  if (!platform) return c.json({ error: 'platform is required' }, 400);

  // Serialize concurrent PUTs for the same stable ID. The PR-466 atomic-claim
  // INSERT (below) is sufficient when ChatInstanceManager is unavailable —
  // both PUTs see a row exists and converge on the update path. With a real
  // manager, a "loser" can still re-read the just-created row mid-
  // `addConnection` and call `updateConnection` against a half-initialized
  // state — potentially double-spawning the chat instance or fighting the
  // first writer. The lock keyed on the caller-supplied stable ID
  // queues subsequent PUTs at the chain entry; they only proceed after the
  // first one's manager-side work has fully committed.
  return await withStablePlatformLock(stableId, async () => {
    let existing = await connectionStore.getConnection(stableId);
    if (existing && existing.agentId && existing.agentId !== agentId) {
      return c.json(
        { error: 'Stable ID already used by a different agent' },
        409
      );
    }

    const chatManager = getChatInstanceManager();

    if (!existing) {
      // Atomic claim. The advisory lock above already serializes concurrent
      // PUTs for this stableId in-process, but ON CONFLICT DO NOTHING is
      // kept as defense-in-depth against any caller that bypasses this
      // route (e.g. a previous apply cycle that crashed between INSERT and
      // the manager call).
      const sql = getDb();
      const claimNow = new Date();
      const claimOrgId = c.get('organizationId') as string;
      const claimed = await sql`
        INSERT INTO agent_connections (
          id, organization_id, agent_id, platform, config, settings, metadata, status, created_at, updated_at
        )
        VALUES (
          ${stableId}, ${claimOrgId}, ${agentId}, ${platform},
          ${sql.json({})}, ${sql.json({})}, ${sql.json({})},
          'stopped', ${claimNow}, ${claimNow}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;

      if (claimed.length > 0) {
        // We won the create race. Run the full create flow; both the manager
        // and fallback paths re-write the row via saveConnection (ON CONFLICT
        // DO UPDATE), so updating our placeholder is the same path they'd
        // take on a freshly-inserted row.
        if (chatManager) {
          try {
            const created = await chatManager.addConnection(
              platform,
              agentId,
              { platform, ...config },
              { allowGroups: true, ...settings },
              {},
              stableId
            );
            return c.json({ platform: created }, 201);
          } catch (error: any) {
            // Roll back the placeholder so a retry doesn't see a half-baked
            // row that fails the `existing.agentId` check inconsistently.
            try {
              await connectionStore.deleteConnection(stableId);
            } catch {
              // best-effort
            }
            return c.json({ error: error.message || 'Failed to create platform' }, 400);
          }
        }

        // No ChatInstanceManager — same reasoning as the POST handler:
        // refuse the write so plaintext secrets aren't persisted into
        // agent_connections.config bypassing secret-ref normalization.
        return c.json(
          { error: 'platform manager unavailable — retry once startup completes' },
          503
        );
      }

      // Lost the create race — someone else inserted the row between our
      // initial read and INSERT. With the advisory lock held we shouldn't
      // reach this in the same-process case, but keep the re-read as
      // defense-in-depth against multi-host writers that bypass the route.
      const reread = await connectionStore.getConnection(stableId);
      if (!reread) {
        return c.json({ error: 'Platform vanished after conflict' }, 500);
      }
      if (reread.agentId && reread.agentId !== agentId) {
        return c.json(
          { error: 'Stable ID already used by a different agent' },
          409
        );
      }
      existing = reread;
    }

    // Update path. `existing` is guaranteed non-null at this point — either we
    // saw it on the first read, or we re-read after losing the create race.
    const current = existing;

    // Compute the merged config the way ChatInstanceManager.updateConnection
    // does: skip `***...` placeholders so a sanitized round-trip from the
    // GET endpoint doesn't trigger a spurious "changed" classification.
    const previousConfig = (current.config ?? {}) as Record<string, unknown>;
    const submittedConfig = { platform, ...config } as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...previousConfig };
    for (const [key, value] of Object.entries(submittedConfig)) {
      if (typeof value === 'string' && value.startsWith('***')) continue;
      merged[key] = value;
    }
    merged.platform = platform;

    const configChanged = !configsShallowEqual(merged, previousConfig);
    // Settings (allowFrom, allowGroups, etc.) are persisted alongside the
    // platform config and are part of "did anything change?" — a
    // settings-only update must trigger willRestart, not be silently noop'd.
    const previousSettings = (current.settings ?? {}) as Record<string, unknown>;
    const mergedSettings = { allowGroups: true, ...settings } as Record<string, unknown>;
    const settingsChanged = !configsShallowEqual(mergedSettings, previousSettings);

    if (!configChanged && !settingsChanged) {
      return c.json({ noop: true, platform: current }, 200);
    }

    if (chatManager) {
      try {
        const updated = await chatManager.updateConnection(stableId, {
          config: { platform, ...config },
          settings: { allowGroups: true, ...settings },
        });
        return c.json(
          { updated: true, willRestart: true, platform: updated },
          200
        );
      } catch (error: any) {
        return c.json({ error: error.message || 'Failed to update platform' }, 400);
      }
    }

    // No ChatInstanceManager — refuse rather than persist plaintext
    // secrets directly into agent_connections.config.
    return c.json(
      { error: 'platform manager unavailable — retry once startup completes' },
      503
    );
  });
});

// Shallow equality check matching ChatInstanceManager.configsEqual semantics.
function configsShallowEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// ── Get platform ─────────────────────────────────────────────────────────────

function platformBelongsToAgent(platform: { agentId?: string | null }, agentId: string) {
  return platform.agentId === agentId;
}

async function getStoredPlatformForAgent(agentId: string, platformId: string) {
  const platform = await connectionStore.getConnection(platformId);
  if (!platform || !platformBelongsToAgent(platform, agentId)) return null;
  return platform;
}

type StoredPlatform = NonNullable<Awaited<ReturnType<typeof getStoredPlatformForAgent>>>;

/**
 * Shared preamble for the single-platform routes (GET / DELETE / start / stop):
 * 404 if the agent doesn't exist, 404 if the platform doesn't exist or belongs
 * to a different agent, otherwise the stored platform row. Returns either the
 * row (under `platform`) or the `Response` the caller should return.
 */
async function requireStoredPlatform(
  c: any,
  agentId: string,
  platformId: string
): Promise<{ platform: StoredPlatform } | { response: Response }> {
  if (!(await configStore.hasAgent(agentId))) {
    return { response: c.json({ error: 'Agent not found' }, 404) };
  }
  const platform = await getStoredPlatformForAgent(agentId, platformId);
  if (!platform) return { response: c.json({ error: 'Platform not found' }, 404) };
  return { platform };
}

/**
 * Shared body for `POST .../start` and `.../stop`: drive the chat manager (when
 * present) and confirm the runtime row still belongs to this agent; otherwise
 * fall back to flipping the stored connection's status directly.
 */
async function changePlatformRunState(
  c: any,
  agentId: string,
  platformId: string,
  managerAction: 'restartConnection' | 'stopConnection',
  fallbackStatus: 'active' | 'stopped'
): Promise<Response> {
  const guard = await requireStoredPlatform(c, agentId, platformId);
  if ('response' in guard) return guard.response;

  const chatManager = getChatInstanceManager();
  if (chatManager) {
    await chatManager[managerAction](platformId);
    const runtimePlatform = await chatManager.getConnection(platformId);
    if (runtimePlatform && platformBelongsToAgent(runtimePlatform, agentId)) {
      return c.json({ success: true, platform: runtimePlatform });
    }
  }

  await connectionStore.updateConnection(platformId, { status: fallbackStatus });
  return c.json({
    success: true,
    platform: await connectionStore.getConnection(platformId),
  });
}

routes.get('/:agentId/platforms/:platformId', async (c) => {
  const { agentId, platformId } = c.req.param();
  const guard = await requireStoredPlatform(c, agentId, platformId);
  if ('response' in guard) return guard.response;
  const storedPlatform = guard.platform;

  const chatManager = getChatInstanceManager();
  if (chatManager) {
    try {
      const runtimePlatform = await chatManager.getConnection(platformId);
      if (runtimePlatform && platformBelongsToAgent(runtimePlatform, agentId)) {
        return c.json(runtimePlatform);
      }
    } catch {
      // Fall back to the org-scoped PostgreSQL snapshot.
    }
  }

  return c.json(storedPlatform);
});

// ── Delete platform ──────────────────────────────────────────────────────────

routes.delete('/:agentId/platforms/:platformId', async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  const { agentId, platformId } = c.req.param();
  const guard = await requireStoredPlatform(c, agentId, platformId);
  if ('response' in guard) return guard.response;

  const chatManager = getChatInstanceManager();
  if (chatManager) {
    // Manager handles the safe cascade (history → secrets → row).
    // Surface its failure to the caller instead of forcing the row
    // deletion ourselves — orphaning history/secrets without an
    // anchoring row is worse than a 500 the caller can retry.
    try {
      await chatManager.removeConnection(platformId);
    } catch (error: any) {
      return c.json(
        { error: error.message || 'Failed to remove platform' },
        500
      );
    }
    return c.json({ success: true });
  }

  // No manager — direct row delete is the only option. Any history
  // rows pinned to this connection id will be cleaned up by the
  // standard sweep; no secrets to clean since the no-manager path
  // never persists any (writes were refused above).
  await connectionStore.deleteConnection(platformId);
  return c.json({ success: true });
});

// ── Sync declarative channel bindings ────────────────────────────────────────
//
// `lobu apply` POSTs the `channels` declared on a Slack platform here; we
// reconcile `agent_channel_bindings` to match — for this agent, on the
// teams referenced in the list. Channels bound ad-hoc (`/lobu link`) on
// other teams/connections are untouched. Each entry is `"<teamId>/<channelId>"`.

routes.post('/:agentId/platforms/:platformId/sync-channels', async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  const { agentId, platformId } = c.req.param();
  const guard = await requireStoredPlatform(c, agentId, platformId);
  if ('response' in guard) return guard.response;
  if (guard.platform.platform !== 'slack') {
    return c.json(
      { error: 'sync-channels is only supported for Slack connections' },
      400
    );
  }

  let body: { channels?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid or missing JSON body' }, 400);
  }
  if (!Array.isArray(body.channels)) {
    return c.json({ error: 'channels must be an array' }, 400);
  }

  // Parse "<teamId>/<channelId>" → canonical `slack:<channelId>` keyed by team.
  const desired = new Map<string, { teamId: string; channelId: string }>();
  for (const entry of body.channels) {
    if (typeof entry !== 'string') {
      return c.json({ error: 'channel entries must be strings' }, 400);
    }
    const m = entry.trim().match(/^([^/\s]+)\/([^/\s]+)$/);
    if (!m) {
      return c.json(
        {
          error: `invalid channel entry "${entry}" — expected "<teamId>/<channelId>" (e.g. "T0ABCDEF/C0123ABCD")`,
        },
        400
      );
    }
    const teamId = m[1]!;
    const channelId = m[2]!.startsWith('slack:') ? m[2]! : `slack:${m[2]}`;
    desired.set(`${teamId} ${channelId}`, { teamId, channelId });
  }
  const desiredTeams = new Set([...desired.values()].map((d) => d.teamId));

  const sql = getDb();
  const existing = (await sql`
    SELECT channel_id, team_id FROM agent_channel_bindings
    WHERE agent_id = ${agentId} AND platform = 'slack'
  `) as Array<{ channel_id: string; team_id: string | null }>;

  const bound: string[] = [];
  for (const { teamId, channelId } of desired.values()) {
    await sql`
      INSERT INTO agent_channel_bindings (agent_id, platform, channel_id, team_id, created_at)
      VALUES (${agentId}, 'slack', ${channelId}, ${teamId}, now())
      ON CONFLICT (platform, channel_id, team_id) DO UPDATE SET agent_id = EXCLUDED.agent_id
    `;
    bound.push(`${teamId}/${channelId}`);
  }

  const removed: string[] = [];
  for (const row of existing) {
    if (!row.team_id || !desiredTeams.has(row.team_id)) continue;
    if (desired.has(`${row.team_id} ${row.channel_id}`)) continue;
    await sql`
      DELETE FROM agent_channel_bindings
      WHERE agent_id = ${agentId} AND platform = 'slack'
        AND channel_id = ${row.channel_id} AND team_id = ${row.team_id}
    `;
    removed.push(`${row.team_id}/${row.channel_id}`);
  }

  return c.json({ bound, removed });
});

// ── Start platform ───────────────────────────────────────────────────────────

routes.post('/:agentId/platforms/:platformId/start', async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  const { agentId, platformId } = c.req.param();
  return changePlatformRunState(c, agentId, platformId, 'restartConnection', 'active');
});

// ── Stop platform ────────────────────────────────────────────────────────────

routes.post('/:agentId/platforms/:platformId/stop', async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  const { agentId, platformId } = c.req.param();
  return changePlatformRunState(c, agentId, platformId, 'stopConnection', 'stopped');
});

export { routes as agentRoutes };
