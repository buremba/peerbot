/**
 * Agent CRUD routes for the embedded Lobu gateway.
 *
 * All routes are org-scoped via mcpAuth middleware and orgContext.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SkillConfig } from '@lobu/core';
import { Hono } from 'hono';
import { mcpAuth } from '../auth/middleware';
import { getDb } from '../db/client';
import { OAuthClient } from '../gateway/auth/oauth/client';
import { CLAUDE_PROVIDER } from '../gateway/auth/oauth/providers';
import { createAuthProfileLabel } from '../gateway/auth/settings/auth-profiles-manager';
import type { Env } from '../index';
import { getConfiguredPublicOrigin } from '../utils/public-origin';
import { countRuntimeMessagingClientsByAgent } from './client-routes';
import { getChatInstanceManager, getLobuCoreServices } from './gateway';
import {
  AGENT_ID_PATTERN,
  createPostgresAgentConfigStore,
  createPostgresAgentConnectionStore,
  getAgentOrganizationId,
} from './stores';
import { orgContext } from './stores/org-context';

const routes = new Hono<{ Bindings: Env }>();

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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    return [];
  }
}

async function buildSkillsCatalogResponse(installedSkills: SkillConfig[]) {
  return { catalog: [], installedSkills };
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

async function persistConnectionSnapshot(connection: Record<string, any>): Promise<void> {
  if (!connection?.id) return;

  await connectionStore.saveConnection({
    id: connection.id,
    platform: connection.platform,
    templateAgentId: connection.templateAgentId,
    config: (connection.config ?? {}) as Record<string, any>,
    settings: (connection.settings ?? {}) as Record<string, any>,
    metadata: (connection.metadata ?? {}) as Record<string, any>,
    status: connection.status ?? 'stopped',
    errorMessage: connection.errorMessage,
    createdAt: connection.createdAt ?? Date.now(),
    updatedAt: connection.updatedAt ?? Date.now(),
  });
}

// Wrap handler with org context
function withOrg(c: any, fn: () => Promise<Response>): Promise<Response> {
  const orgId = c.get('organizationId');
  if (!orgId) return Promise.resolve(c.json({ error: 'Organization required' }, 401));
  return orgContext.run({ organizationId: orgId }, fn);
}

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

// ── List agents ──────────────────────────────────────────────────────────────

routes.get('/', mcpAuth, async (c) => {
  return withOrg(c, async () => {
    const agents = await configStore.listAgents();
    // Filter out sandbox agents
    const filtered = agents.filter((a) => !a.parentConnectionId);

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

    const persistedClientRows = await sql`
      SELECT template_agent_id as agent_id, id
      FROM agents
      WHERE organization_id = ${orgId}
        AND parent_connection_id IS NOT NULL
        AND template_agent_id IS NOT NULL
    `;
    const clientCountMap = new Map<string, Set<string>>();
    for (const row of persistedClientRows as Array<{
      agent_id: string;
      id: string;
    }>) {
      let ids = clientCountMap.get(row.agent_id);
      if (!ids) {
        ids = new Set<string>();
        clientCountMap.set(row.agent_id, ids);
      }
      ids.add(row.id);
    }

    const runtimeClientCounts = await countRuntimeMessagingClientsByAgent(orgId);
    for (const [agentId, runtimeIds] of runtimeClientCounts.entries()) {
      let ids = clientCountMap.get(agentId);
      if (!ids) {
        ids = new Set<string>();
        clientCountMap.set(agentId, ids);
      }
      for (const clientId of runtimeIds) ids.add(clientId);
    }

    return c.json({
      agents: filtered.map((a) => ({
        ...a,
        connectionCount: countMap.get(a.agentId) ?? 0,
        activeConnectionCount: activeCountMap.get(a.agentId) ?? 0,
        clientCount: clientCountMap.get(a.agentId)?.size ?? 0,
        status: (activeCountMap.get(a.agentId) ?? 0) > 0 ? 'active' : 'idle',
      })),
    });
  });
});

// ── Create agent ─────────────────────────────────────────────────────────────

routes.post('/', mcpAuth, async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  return withOrg(c, async () => {
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
      owletto: { url: `${publicUrl}/mcp/${orgSlug}` },
    };
    const inserted = await sql`
      INSERT INTO agents (
        id, organization_id, name, description, owner_platform, owner_user_id,
        mcp_servers, created_at, updated_at
      )
      VALUES (
        ${agentId}, ${orgId}, ${name}, ${description ?? null},
        'owletto', ${user.id},
        ${sql.json(ownerMcpServers)}, ${now}, ${now}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;

    if (inserted.length === 0) {
      // Another writer (or a previous apply cycle) already owns this id.
      // If they're in this org → idempotent 200. If another org → 409.
      const existingOrgId = await getAgentOrganizationId(agentId);
      if (existingOrgId === orgId) {
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
      return c.json({ error: 'Agent ID already exists in another organization' }, 409);
    }

    return c.json({ agentId, name, description }, 201);
  });
});

// ── Get agent detail ─────────────────────────────────────────────────────────

routes.get('/:agentId', mcpAuth, async (c) => {
  return withOrg(c, async () => {
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
      WHERE agent_id = ${agentId}
    `;
    const persistedClientRows = await sql`
      SELECT id
      FROM agents
      WHERE organization_id = ${organizationId}
        AND template_agent_id = ${agentId}
        AND parent_connection_id IS NOT NULL
    `;
    const clientIds = new Set((persistedClientRows as Array<{ id: string }>).map((row) => row.id));
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
});

// ── Update agent metadata ────────────────────────────────────────────────────

routes.patch('/:agentId', mcpAuth, async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  return withOrg(c, async () => {
    const { agentId } = c.req.param();
    const body = await c.req.json<{ name?: string; description?: string }>();

    if (!(await configStore.hasAgent(agentId))) {
      return c.json({ error: 'Agent not found' }, 404);
    }

    await configStore.updateMetadata(agentId, body);
    return c.json({ success: true });
  });
});

// ── Delete agent ─────────────────────────────────────────────────────────────

routes.delete('/:agentId', mcpAuth, async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  return withOrg(c, async () => {
    const { agentId } = c.req.param();

    if (!(await configStore.hasAgent(agentId))) {
      return c.json({ error: 'Agent not found' }, 404);
    }

    // Cascade handled by FK ON DELETE CASCADE
    await configStore.deleteMetadata(agentId);
    return c.json({ success: true });
  });
});

// ── Get agent config (settings) ──────────────────────────────────────────────

routes.get('/:agentId/config', mcpAuth, async (c) => {
  return withOrg(c, async () => {
    const { agentId } = c.req.param();
    const settings = await configStore.getSettings(agentId);
    if (!settings) return c.json({ error: 'Agent not found' }, 404);
    return c.json(settings);
  });
});

// ── Get provider catalog and model options ───────────────────────────────────

routes.get('/:agentId/config/providers/catalog', mcpAuth, async (c) => {
  return withOrg(c, async () => {
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
});

// ── Get skills catalog ───────────────────────────────────────────────────────

routes.get('/config/skills/catalog', mcpAuth, async (c) => {
  return withOrg(c, async () => {
    return c.json(await buildSkillsCatalogResponse([]));
  });
});

routes.get('/:agentId/config/skills/catalog', mcpAuth, async (c) => {
  return withOrg(c, async () => {
    const { agentId } = c.req.param();
    const settings = await configStore.getSettings(agentId);
    if (!settings) return c.json({ error: 'Agent not found' }, 404);

    const installedSkills: SkillConfig[] = settings.skillsConfig?.skills ?? [];
    return c.json(await buildSkillsCatalogResponse(installedSkills));
  });
});

// ── Start provider OAuth login ───────────────────────────────────────────────

routes.get('/:agentId/providers/:providerId/oauth/start', mcpAuth, async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  return withOrg(c, async () => {
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
      context: { platform: 'owletto-web', channelId: agentId },
    });

    return c.redirect(oauthClient.buildAuthUrl(state, codeVerifier));
  });
});

// ── Complete provider OAuth login ────────────────────────────────────────────

routes.post('/:agentId/providers/:providerId/oauth/code', mcpAuth, async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  return withOrg(c, async () => {
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
});

// ── Update agent config (settings) ───────────────────────────────────────────

routes.patch('/:agentId/config', mcpAuth, async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  return withOrg(c, async () => {
    const { agentId } = c.req.param();
    const updates = await c.req.json();

    if (!(await configStore.hasAgent(agentId))) {
      return c.json({ error: 'Agent not found' }, 404);
    }

    await configStore.updateSettings(agentId, updates);
    return c.json({ success: true });
  });
});

// ============================================================
// Platform routes (nested under /:agentId/platforms)
//
// Storage internals still live in the `agent_connections` table — the rename
// is user-facing only. ChatInstanceManager and the connection store keep
// their existing names because they're used by other (chat-side) callers.
// ============================================================

// ── List platforms ───────────────────────────────────────────────────────────

routes.get('/:agentId/platforms', mcpAuth, async (c) => {
  return withOrg(c, async () => {
    const { agentId } = c.req.param();
    if (!(await configStore.hasAgent(agentId))) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    const chatManager = getChatInstanceManager();
    let platforms = await connectionStore.listConnections({
      templateAgentId: agentId,
    });

    if (chatManager) {
      try {
        const runtimePlatforms = await chatManager.listConnections({
          templateAgentId: agentId,
        });
        await Promise.all(
          runtimePlatforms.map((platform: Record<string, any>) =>
            persistConnectionSnapshot(platform)
          )
        );
        if (runtimePlatforms.length > 0) {
          platforms = runtimePlatforms;
        }
      } catch {
        // Fall back to PostgreSQL snapshot.
      }
    }

    return c.json({ platforms });
  });
});

// ── Create platform ──────────────────────────────────────────────────────────

routes.post('/:agentId/platforms', mcpAuth, async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  return withOrg(c, async () => {
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
        await persistConnectionSnapshot(created);
        return c.json({ platform: created }, 201);
      } catch (error: any) {
        return c.json({ error: error.message || 'Failed to create platform' }, 400);
      }
    }

    // Fallback: store directly if ChatInstanceManager not available
    const id = `${platform}-${agentId}-${Date.now()}`;
    const now = Date.now();
    await connectionStore.saveConnection({
      id,
      platform,
      templateAgentId: agentId,
      config: config as Record<string, any>,
      settings: settings as any,
      metadata: {},
      status: 'stopped',
      createdAt: now,
      updatedAt: now,
    });
    return c.json({ platform: { id, platform, status: 'stopped' } }, 201);
  });
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

routes.put('/:agentId/platforms/by-stable-id/:stableId', mcpAuth, async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  return withOrg(c, async () => {
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
      if (existing && existing.templateAgentId && existing.templateAgentId !== agentId) {
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
        const claimed = await sql`
          INSERT INTO agent_connections (
            id, agent_id, platform, config, settings, metadata, status, created_at, updated_at
          )
          VALUES (
            ${stableId}, ${agentId}, ${platform},
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
              await persistConnectionSnapshot(created);
              return c.json({ platform: created }, 201);
            } catch (error: any) {
              // Roll back the placeholder so a retry doesn't see a half-baked
              // row that fails the `existing.templateAgentId` check inconsistently.
              try {
                await connectionStore.deleteConnection(stableId);
              } catch {
                // best-effort
              }
              return c.json({ error: error.message || 'Failed to create platform' }, 400);
            }
          }

          // Fallback path mirrors the POST handler's no-manager branch but uses
          // the supplied stable ID instead of a synthesized one. Platform is kept
          // in config (matching the manager path) so subsequent idempotent PUTs
          // see a stable previousConfig. Settings default `allowGroups: true` to
          // match the manager-path default — symmetric with the noop comparison
          // below so a follow-up PUT with no settings field round-trips as noop.
          const fallbackNow = Date.now();
          await connectionStore.saveConnection({
            id: stableId,
            platform,
            templateAgentId: agentId,
            config: { platform, ...config } as Record<string, any>,
            settings: { allowGroups: true, ...settings } as any,
            metadata: {},
            status: 'stopped',
            createdAt: fallbackNow,
            updatedAt: fallbackNow,
          });
          return c.json(
            { platform: { id: stableId, platform, status: 'stopped' } },
            201
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
        if (reread.templateAgentId && reread.templateAgentId !== agentId) {
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
          await persistConnectionSnapshot(updated);
          return c.json(
            { updated: true, willRestart: true, platform: updated },
            200
          );
        } catch (error: any) {
          return c.json({ error: error.message || 'Failed to update platform' }, 400);
        }
      }

      // Fallback when ChatInstanceManager is not available (e.g. boot races,
      // tests). Persist the merged config directly.
      await connectionStore.saveConnection({
        id: stableId,
        platform,
        templateAgentId: agentId,
        config: merged as Record<string, any>,
        settings: { allowGroups: true, ...settings } as any,
        metadata: current.metadata ?? {},
        status: current.status ?? 'stopped',
        createdAt: current.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      });
      const refreshed = await connectionStore.getConnection(stableId);
      return c.json(
        { updated: true, willRestart: true, platform: refreshed },
        200
      );
    });
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

function platformBelongsToAgent(platform: { templateAgentId?: string | null }, agentId: string) {
  return platform.templateAgentId === agentId;
}

async function getStoredPlatformForAgent(agentId: string, platformId: string) {
  const platform = await connectionStore.getConnection(platformId);
  if (!platform || !platformBelongsToAgent(platform, agentId)) return null;
  return platform;
}

routes.get('/:agentId/platforms/:platformId', mcpAuth, async (c) => {
  return withOrg(c, async () => {
    const { agentId, platformId } = c.req.param();
    if (!(await configStore.hasAgent(agentId))) {
      return c.json({ error: 'Agent not found' }, 404);
    }

    const storedPlatform = await getStoredPlatformForAgent(agentId, platformId);
    if (!storedPlatform) return c.json({ error: 'Platform not found' }, 404);

    const chatManager = getChatInstanceManager();
    if (chatManager) {
      try {
        const runtimePlatform = await chatManager.getConnection(platformId);
        if (runtimePlatform && platformBelongsToAgent(runtimePlatform, agentId)) {
          await persistConnectionSnapshot(runtimePlatform);
          return c.json(runtimePlatform);
        }
      } catch {
        // Fall back to the org-scoped PostgreSQL snapshot.
      }
    }

    return c.json(storedPlatform);
  });
});

// ── Delete platform ──────────────────────────────────────────────────────────

routes.delete('/:agentId/platforms/:platformId', mcpAuth, async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  return withOrg(c, async () => {
    const { agentId, platformId } = c.req.param();
    if (!(await configStore.hasAgent(agentId))) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    const platform = await getStoredPlatformForAgent(agentId, platformId);
    if (!platform) return c.json({ error: 'Platform not found' }, 404);

    const chatManager = getChatInstanceManager();
    if (chatManager) {
      try {
        await chatManager.removeConnection(platformId);
      } catch {
        // Fall through to direct store delete
      }
    }
    await connectionStore.deleteConnection(platformId);
    return c.json({ success: true });
  });
});

// ── Start platform ───────────────────────────────────────────────────────────

routes.post('/:agentId/platforms/:platformId/start', mcpAuth, async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  return withOrg(c, async () => {
    const { agentId, platformId } = c.req.param();
    if (!(await configStore.hasAgent(agentId))) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    const chatManager = getChatInstanceManager();
    const platform = await getStoredPlatformForAgent(agentId, platformId);
    if (!platform) return c.json({ error: 'Platform not found' }, 404);

    if (chatManager) {
      await chatManager.restartConnection(platformId);
      const runtimePlatform = await chatManager.getConnection(platformId);
      if (runtimePlatform && platformBelongsToAgent(runtimePlatform, agentId)) {
        await persistConnectionSnapshot(runtimePlatform);
        return c.json({ success: true, platform: runtimePlatform });
      }
    }

    await connectionStore.updateConnection(platformId, { status: 'active' });
    return c.json({
      success: true,
      platform: await connectionStore.getConnection(platformId),
    });
  });
});

// ── Stop platform ────────────────────────────────────────────────────────────

routes.post('/:agentId/platforms/:platformId/stop', mcpAuth, async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  return withOrg(c, async () => {
    const { agentId, platformId } = c.req.param();
    if (!(await configStore.hasAgent(agentId))) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    const chatManager = getChatInstanceManager();
    const platform = await getStoredPlatformForAgent(agentId, platformId);
    if (!platform) return c.json({ error: 'Platform not found' }, 404);

    if (chatManager) {
      await chatManager.stopConnection(platformId);
      const runtimePlatform = await chatManager.getConnection(platformId);
      if (runtimePlatform && platformBelongsToAgent(runtimePlatform, agentId)) {
        await persistConnectionSnapshot(runtimePlatform);
        return c.json({ success: true, platform: runtimePlatform });
      }
    }

    await connectionStore.updateConnection(platformId, { status: 'stopped' });
    return c.json({
      success: true,
      platform: await connectionStore.getConnection(platformId),
    });
  });
});

export { routes as agentRoutes };
