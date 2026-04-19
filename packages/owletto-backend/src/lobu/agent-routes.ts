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

async function getClaudeOAuthRuntime() {
  const entryUrl = import.meta.resolve('@lobu/gateway');
  const distRoot = entryUrl.replace(/dist\/index\.js$/, 'dist');
  const { OAuthClient } = (await import(`${distRoot}/auth/oauth/client.js`)) as {
    OAuthClient: new (
      config: unknown
    ) => {
      generateCodeVerifier: () => string;
      buildAuthUrl: (state: string, codeVerifier: string, customRedirectUri?: string) => string;
      exchangeCodeForToken: (
        code: string,
        codeVerifier: string,
        customRedirectUri?: string,
        state?: string
      ) => Promise<{
        accessToken: string;
        refreshToken?: string;
        expiresAt?: number;
      }>;
    };
  };
  const { CLAUDE_PROVIDER } = (await import(`${distRoot}/auth/oauth/providers.js`)) as {
    CLAUDE_PROVIDER: unknown;
  };
  const { createAuthProfileLabel } = (await import(
    `${distRoot}/auth/settings/auth-profiles-manager.js`
  )) as {
    createAuthProfileLabel: (providerName: string, credential: string) => string;
  };

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
    const existingOrgId = await getAgentOrganizationId(agentId);
    if (existingOrgId === orgId) {
      return c.json({ error: 'Agent already exists' }, 409);
    }
    if (existingOrgId) {
      return c.json({ error: 'Agent ID already exists in another organization' }, 409);
    }

    // Create metadata
    await configStore.saveMetadata(agentId, {
      agentId,
      name,
      description,
      owner: { platform: 'owletto', userId: user.id },
      createdAt: Date.now(),
    });

    // Create default settings with Owletto MCP server auto-injected
    const orgSlug = c.req.param('orgSlug');
    const publicUrl =
      getConfiguredPublicOrigin() || `http://localhost:${process.env.PORT || '8787'}`;
    await configStore.saveSettings(agentId, {
      mcpServers: {
        owletto: { url: `${publicUrl}/mcp/${orgSlug}` },
      },
      updatedAt: Date.now(),
    });

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

    const { oauthClient } = await getClaudeOAuthRuntime();
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
    const { oauthClient, createAuthProfileLabel } = await getClaudeOAuthRuntime();

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
// Connection routes (nested under /:agentId/connections)
// ============================================================

// ── List connections ─────────────────────────────────────────────────────────

routes.get('/:agentId/connections', mcpAuth, async (c) => {
  return withOrg(c, async () => {
    const { agentId } = c.req.param();
    if (!(await configStore.hasAgent(agentId))) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    const chatManager = getChatInstanceManager();
    let connections = await connectionStore.listConnections({
      templateAgentId: agentId,
    });

    if (chatManager) {
      try {
        const runtimeConnections = await chatManager.listConnections({
          templateAgentId: agentId,
        });
        await Promise.all(
          runtimeConnections.map((connection: Record<string, any>) =>
            persistConnectionSnapshot(connection)
          )
        );
        if (runtimeConnections.length > 0) {
          connections = runtimeConnections;
        }
      } catch {
        // Fall back to PostgreSQL snapshot.
      }
    }

    return c.json({ connections });
  });
});

// ── Create connection ────────────────────────────────────────────────────────

routes.post('/:agentId/connections', mcpAuth, async (c) => {
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
        const connection = await chatManager.addConnection(
          platform,
          agentId,
          { platform, ...config },
          { allowGroups: true, ...settings }
        );
        await persistConnectionSnapshot(connection);
        return c.json({ connection }, 201);
      } catch (error: any) {
        return c.json({ error: error.message || 'Failed to create connection' }, 400);
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
    return c.json({ connection: { id, platform, status: 'stopped' } }, 201);
  });
});

// ── Get connection ───────────────────────────────────────────────────────────

routes.get('/:agentId/connections/:connId', mcpAuth, async (c) => {
  return withOrg(c, async () => {
    const { connId } = c.req.param();
    const chatManager = getChatInstanceManager();
    let conn = null;

    if (chatManager) {
      try {
        conn = await chatManager.getConnection(connId);
        if (conn) {
          await persistConnectionSnapshot(conn);
        }
      } catch {
        conn = null;
      }
    }

    if (!conn) {
      conn = await connectionStore.getConnection(connId);
    }

    if (!conn) return c.json({ error: 'Connection not found' }, 404);
    return c.json(conn);
  });
});

// ── Delete connection ────────────────────────────────────────────────────────

routes.delete('/:agentId/connections/:connId', mcpAuth, async (c) => {
  return withOrg(c, async () => {
    const { connId } = c.req.param();
    const conn = await connectionStore.getConnection(connId);
    if (!conn) return c.json({ error: 'Connection not found' }, 404);

    const chatManager = getChatInstanceManager();
    if (chatManager) {
      try {
        await chatManager.removeConnection(connId);
      } catch {
        // Fall through to direct store delete
      }
    }
    await connectionStore.deleteConnection(connId);
    return c.json({ success: true });
  });
});

// ── Start connection ─────────────────────────────────────────────────────────

routes.post('/:agentId/connections/:connId/start', mcpAuth, async (c) => {
  return withOrg(c, async () => {
    const { connId } = c.req.param();
    const chatManager = getChatInstanceManager();
    const conn = await connectionStore.getConnection(connId);
    if (!conn) return c.json({ error: 'Connection not found' }, 404);

    if (chatManager) {
      await chatManager.restartConnection(connId);
      const runtimeConnection = await chatManager.getConnection(connId);
      if (runtimeConnection) {
        await persistConnectionSnapshot(runtimeConnection);
        return c.json({ success: true, connection: runtimeConnection });
      }
    }

    await connectionStore.updateConnection(connId, { status: 'active' });
    return c.json({
      success: true,
      connection: await connectionStore.getConnection(connId),
    });
  });
});

// ── Stop connection ──────────────────────────────────────────────────────────

routes.post('/:agentId/connections/:connId/stop', mcpAuth, async (c) => {
  return withOrg(c, async () => {
    const { connId } = c.req.param();
    const chatManager = getChatInstanceManager();
    const conn = await connectionStore.getConnection(connId);
    if (!conn) return c.json({ error: 'Connection not found' }, 404);

    if (chatManager) {
      await chatManager.stopConnection(connId);
      const runtimeConnection = await chatManager.getConnection(connId);
      if (runtimeConnection) {
        await persistConnectionSnapshot(runtimeConnection);
        return c.json({ success: true, connection: runtimeConnection });
      }
    }

    await connectionStore.updateConnection(connId, { status: 'stopped' });
    return c.json({
      success: true,
      connection: await connectionStore.getConnection(connId),
    });
  });
});

export { routes as agentRoutes };
