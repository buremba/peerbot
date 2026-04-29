/**
 * Lobu Gateway — embedded initialization
 *
 * Embeds @lobu/gateway directly into Owletto's Hono server using PostgreSQL-backed
 * stores and bridging Owletto's Better Auth sessions to Lobu's settings auth.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { Hono as HonoApp } from 'hono';
import { createAuth } from '../auth';
import { getDb } from '../db/client';
import type { Env } from '../index';
import logger from '../utils/logger';
import { getConfiguredPublicOrigin } from '../utils/public-origin';
import {
  createPostgresAgentAccessStore,
  createPostgresAgentConfigStore,
  createPostgresAgentConnectionStore,
  PostgresSecretStore,
} from './stores';

type EmbeddedSettingsSession = {
  userId: string;
  platform: string;
  exp: number;
  email?: string;
  name?: string;
  settingsMode?: 'admin' | 'user';
  isAdmin?: boolean;
};

let gateway: any = null;
let lobuApp: any = null;
let chatInstanceManager: any = null;
let coreServices: any = null;
let orchestrator: any = null;
let socketModeClient: any = null;

function ensureEmbeddedWorkerLauncher(): void {
  const shimDir = path.resolve('scripts/runtime-shims');
  const bunShim = path.join(shimDir, 'bun');
  if (!fs.existsSync(bunShim)) return;

  const currentPath = process.env.PATH || '';
  const pathSegments = currentPath.split(':').filter(Boolean);
  if (!pathSegments.includes(shimDir)) {
    process.env.PATH = [shimDir, ...pathSegments].join(':');
    logger.info({ shimDir }, '[Lobu] Prepended embedded worker launcher shim to PATH');
  }
}

async function hydratePersistedAgentSettings(agentSettingsStore: any): Promise<void> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, model, model_selection, provider_model_preferences,
           network_config, nix_config, mcp_servers, mcp_install_notified,
           soul_md, user_md, identity_md, skills_config, tools_config,
           plugins_config, auth_profiles, installed_providers,
           verbose_logging, template_agent_id
    FROM agents
    WHERE model IS NOT NULL
       OR provider_model_preferences <> '{}'::jsonb
       OR mcp_servers <> '{}'::jsonb
       OR mcp_install_notified <> '{}'::jsonb
       OR soul_md <> ''
       OR user_md <> ''
       OR identity_md <> ''
       OR skills_config <> '{"skills":[]}'::jsonb
       OR tools_config <> '{}'::jsonb
       OR plugins_config <> '{}'::jsonb
       OR jsonb_array_length(auth_profiles) > 0
       OR jsonb_array_length(installed_providers) > 0
       OR verbose_logging = true
       OR template_agent_id IS NOT NULL
  `;

  for (const row of rows as Array<Record<string, any>>) {
    await agentSettingsStore.saveSettings(row.id, {
      ...(row.model ? { model: row.model } : {}),
      ...(row.model_selection ? { modelSelection: row.model_selection } : {}),
      ...(row.provider_model_preferences
        ? { providerModelPreferences: row.provider_model_preferences }
        : {}),
      ...(row.network_config ? { networkConfig: row.network_config } : {}),
      ...(row.nix_config ? { nixConfig: row.nix_config } : {}),
      ...(row.mcp_servers ? { mcpServers: row.mcp_servers } : {}),
      ...(row.mcp_install_notified ? { mcpInstallNotified: row.mcp_install_notified } : {}),
      ...(row.soul_md ? { soulMd: row.soul_md } : {}),
      ...(row.user_md ? { userMd: row.user_md } : {}),
      ...(row.identity_md ? { identityMd: row.identity_md } : {}),
      ...(row.skills_config ? { skillsConfig: row.skills_config } : {}),
      ...(row.tools_config ? { toolsConfig: row.tools_config } : {}),
      ...(row.plugins_config ? { pluginsConfig: row.plugins_config } : {}),
      ...(row.auth_profiles ? { authProfiles: row.auth_profiles } : {}),
      ...(row.installed_providers ? { installedProviders: row.installed_providers } : {}),
      ...(row.verbose_logging !== undefined ? { verboseLogging: row.verbose_logging } : {}),
      ...(row.template_agent_id ? { templateAgentId: row.template_agent_id } : {}),
    });
  }

  logger.info({ count: rows.length }, '[Lobu] Hydrated persisted agent settings into runtime');
}

function ensureEmbeddedGatewaySecrets(): void {
  if (!process.env.ENCRYPTION_KEY) {
    if (process.env.OWLETTO_ALLOW_EPHEMERAL_ENCRYPTION_KEY === '1') {
      process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64url');
      logger.warn(
        '[Lobu] Generated ephemeral ENCRYPTION_KEY because OWLETTO_ALLOW_EPHEMERAL_ENCRYPTION_KEY=1'
      );
    } else {
      throw new Error(
        'ENCRYPTION_KEY is required when REDIS_URL enables the embedded Lobu gateway. Set ENCRYPTION_KEY explicitly or opt into ephemeral local keys with OWLETTO_ALLOW_EPHEMERAL_ENCRYPTION_KEY=1.'
      );
    }
  }

  if (!process.env.ADMIN_PASSWORD && !process.env.LOBU_ADMIN_PASSWORD) {
    process.env.ADMIN_PASSWORD = crypto.randomBytes(16).toString('base64url');
  } else if (process.env.LOBU_ADMIN_PASSWORD) {
    process.env.ADMIN_PASSWORD = process.env.LOBU_ADMIN_PASSWORD;
  }
}

/**
 * Start a Slack Socket Mode client that bridges WebSocket events into the
 * ChatInstanceManager's webhook handler. This lets the bot receive events
 * without a publicly reachable URL.
 */
async function startSlackSocketMode(manager: any): Promise<void> {
  if (!manager) return;

  const sql = getDb();
  const rows = await sql`
    SELECT id, config FROM agent_connections WHERE platform = 'slack' LIMIT 10
  `;

  for (const row of rows as Array<{ id: string; config: any }>) {
    const cfg = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    if (!cfg?.appToken) continue;

    const { SocketModeClient } = await import('@slack/socket-mode');
    const signingSecret = cfg.signingSecret || process.env.SLACK_SIGNING_SECRET || '';

    socketModeClient = new SocketModeClient({ appToken: cfg.appToken });

    socketModeClient.on('slack_event', async ({ ack, body }: any) => {
      if (ack) await ack();

      const payload = JSON.stringify(body);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const sigBase = `v0:${timestamp}:${payload}`;
      const signature = `v0=${crypto.createHmac('sha256', signingSecret).update(sigBase).digest('hex')}`;

      const request = new Request('http://localhost/slack/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: payload,
      });

      try {
        await manager.handleSlackAppWebhook(request);
      } catch (err) {
        logger.error({ error: String(err) }, '[Lobu] Socket Mode event handler error');
      }
    });

    await socketModeClient.start();
    logger.info({ connectionId: row.id }, '[Lobu] Slack Socket Mode client started');
    break; // one socket mode client is enough
  }
}

/**
 * Initialize the embedded Lobu gateway.
 * Returns the Hono app to mount, or null if Redis is not configured.
 */
export async function initLobuGateway(): Promise<Hono | null> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    logger.info('[Lobu] REDIS_URL not set — embedded gateway disabled');
    return null;
  }

  ensureEmbeddedGatewaySecrets();
  ensureEmbeddedWorkerLauncher();
  try {
    const { Gateway, buildGatewayConfig, createGatewayApp, SecretStoreRegistry } = await import(
      '@lobu/gateway'
    );
    const entryUrl = import.meta.resolve('@lobu/gateway');
    const distRoot = entryUrl.replace(/dist\/index\.js$/, 'dist');
    const { Orchestrator } = (await import(`${distRoot}/orchestration/index.js`)) as {
      Orchestrator: new (
        config: unknown
      ) => {
        start: () => Promise<void>;
        stop: () => Promise<void>;
        injectCoreServices: (
          redisClient: unknown,
          providerCatalogService: unknown,
          grantStore?: unknown
        ) => Promise<void>;
      };
    };
    const { ChatInstanceManager, ChatResponseBridge } = await import(
      '@lobu/gateway/dist/connections'
    );
    const { ApiPlatform } = await import('@lobu/gateway/dist/api');

    const publicWebUrl =
      getConfiguredPublicOrigin() || `http://localhost:${process.env.PORT || '8787'}`;
    const publicUrl = new URL('/lobu/', publicWebUrl).toString().replace(/\/$/, '');
    const env = process.env as unknown as Env;

    // Embedded gateway shares the process with the Owletto OIDC provider — use
    // it as the external auth issuer. Without MEMORY_URL set,
    // ExternalAuthClient.fromEnv() returns null and the api-auth-middleware
    // can't validate service tokens, so every dispatcher → /lobu/api/v1/agents
    // call gets a 401 (silently fails the watcher run). Point at the local
    // public origin so OIDC discovery + /oauth/userinfo resolve to ourselves.
    if (!process.env.MEMORY_URL) {
      process.env.MEMORY_URL = publicWebUrl;
      logger.info({ memoryUrl: publicWebUrl }, '[Lobu] Defaulted MEMORY_URL for embedded auth');
    }

    const gatewayConfig = buildGatewayConfig({
      queues: { connectionString: redisUrl },
      orchestration: { deploymentMode: 'embedded' },
      mcp: { publicGatewayUrl: publicUrl },
    });

    logger.info('[Lobu] Starting embedded orchestrator');
    orchestrator = new Orchestrator(gatewayConfig.orchestration);
    await orchestrator.start();
    logger.info('[Lobu] Embedded orchestrator started');

    // Create PostgreSQL-backed stores
    const configStore = createPostgresAgentConfigStore();
    const connectionStore = createPostgresAgentConnectionStore();
    const accessStore = createPostgresAgentAccessStore();
    const postgresSecretStore = new PostgresSecretStore();
    const secretStore = new SecretStoreRegistry(postgresSecretStore, {
      secret: postgresSecretStore,
    });

    gateway = new Gateway(gatewayConfig, {
      configStore,
      connectionStore,
      accessStore,
      secretStore,
    });

    // Register API platform
    gateway.registerPlatform(new ApiPlatform());

    // Start the gateway (initializes CoreServices, platforms, consumer)
    await gateway.start();

    coreServices = gateway.getCoreServices();
    await hydratePersistedAgentSettings(coreServices.getAgentSettingsStore());
    await orchestrator.injectCoreServices(
      coreServices.getQueue().getRedisClient(),
      coreServices.getProviderCatalogService(),
      coreServices.getGrantStore()
    );
    logger.info('[Lobu] Embedded orchestrator injected core services');

    // Initialize Chat SDK connection manager for platform connections
    chatInstanceManager = new ChatInstanceManager();
    try {
      await chatInstanceManager.initialize(coreServices);

      for (const adapter of chatInstanceManager.createPlatformAdapters()) {
        gateway.registerPlatform(adapter);
      }

      // Wire ChatResponseBridge into unified thread consumer
      const unifiedConsumer = gateway.getUnifiedConsumer();
      if (unifiedConsumer) {
        const bridge = new ChatResponseBridge(chatInstanceManager);
        unifiedConsumer.setChatResponseBridge(bridge);
      }
    } catch (error) {
      logger.warn(
        { error: String(error) },
        '[Lobu] ChatInstanceManager init failed — connections disabled'
      );
    }

    // Start Slack Socket Mode bridge if any connection has an appToken
    await startSlackSocketMode(chatInstanceManager);

    // Auth bridge: translate Owletto's Better Auth session → Lobu's SettingsTokenPayload
    const authProvider = (c: any): EmbeddedSettingsSession | null => {
      const user = c.get('user');
      const session = c.get('session');
      if (!user || !session) return null;
      const adminIds = (env.PLATFORM_ADMIN_USER_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const platformAdmin = adminIds.includes(user.id);

      return {
        userId: user.id,
        platform: 'external',
        exp:
          session.expiresAt instanceof Date ? session.expiresAt.getTime() : Date.now() + 86400000,
        email: user.email,
        name: user.name,
        settingsMode: platformAdmin ? 'admin' : 'user',
        isAdmin: platformAdmin,
      };
    };

    const workerGateway = coreServices.getWorkerGateway();
    logger.info(
      { hasWorkerGateway: !!workerGateway, hasGetApp: !!workerGateway?.getApp },
      '[Lobu] Worker gateway check'
    );
    const rawLobuApp = createGatewayApp({
      secretProxy: coreServices.getSecretProxy(),
      workerGateway,
      mcpProxy: coreServices.getMcpProxy(),
      interactionService: coreServices.getInteractionService(),
      platformRegistry: gateway.getPlatformRegistry(),
      coreServices,
      chatInstanceManager,
      authProvider,
    });

    // Mount worker gateway routes before wrapping in lobuApp (createGatewayApp
    // doesn't include these — they're only mounted in the standalone CLI gateway)

    // Embedded Lobu auth routes need the Owletto Better Auth session, but they are mounted
    // outside the main app's auth middleware. Hydrate the shared user/session context here.
    lobuApp = new HonoApp<{ Bindings: Env }>();
    lobuApp.use('*', async (c: any, next: any) => {
      c.set('user', null);
      c.set('session', null);

      try {
        const auth = await createAuth(c.env, c.req.raw);
        const session = await auth.api.getSession({ headers: c.req.raw.headers });
        if (session?.user && session.session) {
          c.set('user', session.user);
          c.set('session', session.session);
        }
      } catch {
        // Lobu auth routes fall back to their own unauthenticated handling.
      }

      await next();
    });
    // Worker gateway routes must be mounted first (before rawLobuApp's catch-all)
    if (workerGateway?.getApp) {
      lobuApp.route('/worker', workerGateway.getApp());
      logger.info('[Lobu] Worker gateway routes mounted at /lobu/worker/*');
    }
    lobuApp.route('/', rawLobuApp);

    logger.info('[Lobu] Embedded gateway initialized');
    return lobuApp;
  } catch (error) {
    if (orchestrator) {
      try {
        await orchestrator.stop();
      } catch (stopError) {
        logger.warn({ error: String(stopError) }, '[Lobu] Failed to stop orchestrator after init');
      }
      orchestrator = null;
    }
    logger.error({ error: String(error) }, '[Lobu] Failed to initialize embedded gateway');
    return null;
  }
}

/**
 * Stop the embedded Lobu gateway (for graceful shutdown).
 */
export async function stopLobuGateway(): Promise<void> {
  try {
    if (socketModeClient) {
      await socketModeClient.disconnect();
      socketModeClient = null;
    }
    if (chatInstanceManager) {
      await chatInstanceManager.shutdown();
    }
    if (gateway) {
      await gateway.stop();
    }
    if (orchestrator) {
      await orchestrator.stop();
    }
    orchestrator = null;
    gateway = null;
    chatInstanceManager = null;
    lobuApp = null;
    coreServices = null;
    logger.info('[Lobu] Embedded gateway stopped');
  } catch (error) {
    logger.warn({ error: String(error) }, '[Lobu] Error during gateway shutdown');
  }
}

/**
 * Check if the embedded Lobu gateway is running.
 */
export function isLobuGatewayRunning(): boolean {
  return gateway !== null && lobuApp !== null;
}

/**
 * Get the ChatInstanceManager (for connection CRUD in API routes).
 */
export function getChatInstanceManager(): any {
  return chatInstanceManager;
}

export function getLobuCoreServices(): any {
  return coreServices;
}

export { ensureEmbeddedGatewaySecrets };
