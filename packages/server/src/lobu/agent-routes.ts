/**
 * Agent CRUD routes for the embedded Lobu gateway.
 *
 * All routes are org-scoped via mcpAuth middleware and orgContext.
 */

import { encrypt, type AuthProfile } from '@lobu/core';
import { Hono } from 'hono';
import { mcpAuth } from '../auth/middleware';
import { ensureBuilderAgent } from '../auth/builder-provisioning';
import { getDb } from '../db/client';
import { providerOrgSecretName } from './stores/provider-secrets';
import { OAuthClient } from '../gateway/auth/oauth/client';
import { CLAUDE_PROVIDER } from '../gateway/auth/oauth/providers';
import { ChannelBindingService } from '../gateway/channels/binding-service';
import { configsEqual } from '../gateway/connections/config-equal';
import { createAuthProfileLabel } from '../gateway/auth/settings/auth-profiles-manager';
import type { Env } from '../index';
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

/** Whitelist profile metadata down to the non-secret fields (email, expiresAt, accountId). */
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
 * Strip secret material from a stored auth profile before returning it to the
 * web client. `user_auth_profiles` only ever holds refs (not plaintext), but
 * we still drop `credentialRef` / `metadata.*Ref` so the UI never sees them.
 * `credential` is surfaced as an empty string to match the client type — the
 * UI uses it only as "is a key already saved?" signal, never reads its value.
 */
function sanitizeAuthProfileForClient(profile: AuthProfile) {
  const metadata = sanitizeClientProfileMetadata(profile.metadata);
  return {
    id: profile.id,
    provider: profile.provider,
    model: profile.model,
    credential: '',
    label: profile.label,
    authType: profile.authType,
    ...(metadata ? { metadata } : {}),
    createdAt: profile.createdAt,
  };
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

// ── Resolve the org's builder/system agent ───────────────────────────────────
// Server-controlled pointer (organization.system_agent_id). The web console
// mounts the builder chat against this id; null when none is provisioned.
// Registered before any `/:agentId` route so the literal path wins.
routes.get('/system-agent', async (c) => {
  const orgId = c.get('organizationId')!;
  const sql = getDb();
  // Backfill / heal the org's builder on demand. Orgs created before the
  // builder feature have no system agent yet, and an org whose builder was
  // provisioned before its providers resolved needs its providers/model filled
  // in. ensureBuilderAgent is idempotent + one SELECT on the healthy path, and
  // best-effort (never throws), so it can't break console load.
  await ensureBuilderAgent(orgId, sql);
  const rows = await sql`
    SELECT system_agent_id FROM organization WHERE id = ${orgId} LIMIT 1
  `;
  return c.json({
    systemAgentId: (rows[0]?.system_agent_id as string | null) ?? null,
  });
});

// ── List agents ──────────────────────────────────────────────────────────────

routes.get('/', async (c) => {
  const agents = await configStore.listAgents();

  // Count connections per agent
  const sql = getDb();
  const orgId = c.get('organizationId')!;
  const connCounts = await sql`
    SELECT c.agent_id,
      count(*)::int as count,
      count(*) FILTER (WHERE c.status = 'active')::int as active_count
    FROM agent_connections c
    JOIN agents a ON a.id = c.agent_id
    WHERE a.organization_id = ${orgId}
    GROUP BY c.agent_id
  `;
  const countMap = new Map(connCounts.map((r: any) => [r.agent_id, r.count]));
  const activeCountMap = new Map(connCounts.map((r: any) => [r.agent_id, r.active_count]));

  const [runtimeClientCounts, watcherCounts, userCounts, platformRows, providerRows] =
    await Promise.all([
      countRuntimeMessagingClientsByAgent(orgId),
      // Watchers owned by each agent (active only).
      sql`
        SELECT agent_id, count(*)::int as count
        FROM watchers
        WHERE organization_id = ${orgId} AND status = 'active' AND agent_id IS NOT NULL
        GROUP BY agent_id
      `,
      // Distinct end-users per agent across messaging platforms.
      sql`
        SELECT u.agent_id, count(DISTINCT (u.platform, u.user_id))::int as count
        FROM agent_users u
        JOIN agents a ON a.id = u.agent_id
        WHERE a.organization_id = ${orgId}
        GROUP BY u.agent_id
      `,
      // Distinct connection platforms per agent. Cast to text so the driver always
      // returns a JS array — array_agg over an enum/varchar column can come back as
      // a raw `'{telegram,slack}'` string when postgres.js has no array parser for
      // the element OID, which then blows up `.map` in the UI.
      sql`
        SELECT c.agent_id, array_agg(DISTINCT c.platform::text) as platforms
        FROM agent_connections c
        JOIN agents a ON a.id = c.agent_id
        WHERE a.organization_id = ${orgId}
        GROUP BY c.agent_id
      `,
      // Provider ids per agent, from the agent row's installed_providers list.
      sql`
        SELECT id, installed_providers
        FROM agents
        WHERE organization_id = ${orgId}
      `,
    ]);

  const clientCountMap = new Map<string, Set<string>>();
  for (const [agentId, runtimeIds] of runtimeClientCounts.entries()) {
    let ids = clientCountMap.get(agentId);
    if (!ids) {
      ids = new Set<string>();
      clientCountMap.set(agentId, ids);
    }
    for (const clientId of runtimeIds) ids.add(clientId);
  }
  const watcherCountMap = new Map(watcherCounts.map((r: any) => [r.agent_id, r.count]));
  const userCountMap = new Map(userCounts.map((r: any) => [r.agent_id, r.count]));
  const platformsMap = new Map(
    platformRows.map((r: any) => [r.agent_id, toStringArray(r.platforms)])
  );
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
  // before the winner's saveSettings landed, then immediately PATCH it with
  // operator config — only for the winner's deferred saveSettings to clobber
  // it moments later. Folding `pre_approved_tools` into the same INSERT
  // statement closes that gap: the row + auto-injected pre-approvals land
  // atomically and the loser's idempotent 200 already reflects
  // fully-initialized state. The `lobu-memory` MCP server itself is no longer
  // stored per-agent — it's derived at worker startup by McpConfigService.
  const sql = getDb();
  const now = new Date();
  const ownerPreApprovedTools = ['/mcp/lobu-memory/tools/*'];
  const inserted = await sql`
    INSERT INTO agents (
      id, organization_id, name, description, owner_platform, owner_user_id,
      pre_approved_tools, created_at, updated_at
    )
    VALUES (
      ${agentId}, ${orgId}, ${name}, ${description ?? null},
      'lobu', ${user.id},
      ${sql.json(ownerPreApprovedTools)}, ${now}, ${now}
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

// ── Recent guardrail trips ───────────────────────────────────────────────────
//
// Read-only audit feed for the agent's Guardrails tab. Each `guardrail-trip`
// event row is one stage a guardrail short-circuited (written by
// `recordGuardrailTrip`). The rows are append-only and never superseded, so we
// read `events` directly rather than the `current_event_records` view, which
// would force an expensive `event_embeddings` join. Org-scoped + Postgres-backed
// and therefore correct under N replicas (any pod can serve it).
routes.get('/:agentId/guardrail-trips', async (c) => {
  const { agentId } = c.req.param();
  const organizationId = c.get('organizationId') as string;

  // Clamp to a sane window — the UI asks for 50; cap so a hand-crafted query
  // can't ask for an unbounded scan.
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '50', 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 200)
    : 50;

  // Optional narrowing to a single guardrail — the per-guardrail detail view
  // asks for just that guardrail's catches.
  const guardrail = c.req.query('guardrail');

  // Optional narrowing to one conversation — the chat view asks for just the
  // trips that fired during this conversation so it can flag the affected turn.
  const conversationId = c.req.query('conversationId');

  const sql = getDb();
  // `recordGuardrailTrip` writes `created_at` (default now()) but leaves
  // `occurred_at` null, so coalesce to `created_at` — otherwise the UI shows
  // "null" for the timestamp of every real trip.
  const rows = await sql`
    SELECT id, COALESCE(occurred_at, created_at) AS occurred_at, metadata
      FROM events
     WHERE organization_id = ${organizationId}
       AND semantic_type = 'guardrail-trip'
       AND metadata->>'agent_id' = ${agentId}
       ${guardrail ? sql`AND metadata->>'guardrail' = ${guardrail}` : sql``}
       ${conversationId ? sql`AND metadata->>'conversation_id' = ${conversationId}` : sql``}
     ORDER BY COALESCE(occurred_at, created_at) DESC, id DESC
     LIMIT ${limit}
  `;

  const agentName = (await configStore.getMetadata(agentId))?.name;

  const trips = rows.map((row) => {
    const metadata = (row.metadata ?? {}) as {
      stage?: string;
      guardrail?: string;
      reason?: string | null;
      conversation_id?: string | null;
    };
    const occurredAt =
      row.occurred_at instanceof Date
        ? row.occurred_at.toISOString()
        : row.occurred_at
          ? String(row.occurred_at)
          : '';
    return {
      id: Number(row.id),
      occurredAt,
      agentId,
      ...(agentName ? { agentName } : {}),
      stage: metadata.stage,
      guardrailName: metadata.guardrail,
      ...(metadata.reason ? { reason: metadata.reason } : {}),
      ...(metadata.conversation_id
        ? { conversationId: metadata.conversation_id }
        : {}),
    };
  });

  return c.json({ trips });
});

// ── Judge model default (for custom guardrail authoring) ─────────────────────
//
// Custom guardrails are LLM judges. There is no hardcoded judge model: the
// operator sets one via `EGRESS_JUDGE_MODEL`. The create/edit UI uses this to
// either show the configured default (model optional) or require a per-guardrail
// model (when unset). Returns null when no gateway default is configured.
routes.get('/:agentId/guardrail-judge-default', async (c) => {
  return c.json({ defaultModel: process.env.EGRESS_JUDGE_MODEL?.trim() || null });
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

  const oauthClient = new OAuthClient(CLAUDE_PROVIDER);
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
  const oauthClient = new OAuthClient(CLAUDE_PROVIDER);

  try {
    const credentials = await oauthClient.exchangeCodeForToken(
      parts[0].trim(),
      stateData.codeVerifier,
      // No redirect_uri override: the exchange MUST reuse the exact redirect_uri
      // the authorize step sent (CLAUDE_PROVIDER.redirectUri, via buildAuthUrl in
      // the /start handler above). Passing a different value here — the old
      // `console.anthropic.com` callback — makes Anthropic reject the exchange
      // with `invalid_grant: Invalid 'redirect_uri'`.
      undefined,
      parts[1].trim()
    );

    await authProfilesManager.upsertProfile({
      agentId,
      // The profile is owned by the authenticated session user (the same
      // principal whose id was checked against the OAuth state above).
      // upsertProfile requires it — without it the persist throws
      // "upsertProfile requires userId" and the whole login fails AFTER a
      // successful token exchange.
      userId: user.id,
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

const GUARDRAIL_STAGES = new Set(['input', 'output', 'pre-tool', 'egress']);

/**
 * Validate a `guardrailsInline` payload before it is persisted to agent
 * settings. Returns a human-readable error string on the first invalid entry,
 * or `null` when the payload is absent or fully valid. Persisting an entry with
 * an invalid `stage` would crash the guardrail aggregator at message time, so
 * we reject malformed input at the write boundary instead.
 */
export function validateGuardrailsInline(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return 'guardrailsInline must be an array';
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (typeof entry !== 'object' || entry === null) {
      return `guardrailsInline[${i}] must be an object`;
    }
    const g = entry as Record<string, unknown>;
    if (typeof g.name !== 'string' || g.name.trim() === '') {
      return `guardrailsInline[${i}].name must be a non-empty string`;
    }
    if (typeof g.enabled !== 'boolean') {
      return `guardrailsInline[${i}].enabled must be a boolean`;
    }
    if (typeof g.stage !== 'string' || !GUARDRAIL_STAGES.has(g.stage)) {
      return `guardrailsInline[${i}].stage must be one of: input, output, pre-tool, egress`;
    }
    if (typeof g.policy !== 'string' || g.policy.trim() === '') {
      return `guardrailsInline[${i}].policy must be a non-empty string`;
    }
    if (g.model !== undefined && typeof g.model !== 'string') {
      return `guardrailsInline[${i}].model must be a string`;
    }
    if (
      g.tools !== undefined &&
      (!Array.isArray(g.tools) || g.tools.some((t) => typeof t !== 'string'))
    ) {
      return `guardrailsInline[${i}].tools must be an array of strings`;
    }
    if (
      g.domains !== undefined &&
      (!Array.isArray(g.domains) ||
        g.domains.some((d) => typeof d !== 'string'))
    ) {
      return `guardrailsInline[${i}].domains must be an array of strings`;
    }
  }
  return null;
}

routes.patch('/:agentId/config', async (c) => {
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  const { agentId } = c.req.param();
  const updates = await c.req.json();

  if (!(await configStore.hasAgent(agentId))) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  // Validate inline guardrail shape before it is persisted. An invalid `stage`
  // (or missing name/policy) would otherwise be written verbatim and then crash
  // the guardrail aggregator mid-message (it indexes `seen[stage]`).
  const guardrailError = validateGuardrailsInline(
    (updates as { guardrailsInline?: unknown }).guardrailsInline
  );
  if (guardrailError) {
    return c.json(
      { error: 'invalid_guardrail', error_description: guardrailError },
      400
    );
  }

  // Custom guardrails are LLM judges and need a model. With no gateway default
  // (`EGRESS_JUDGE_MODEL` unset), every inline guardrail must carry its own
  // `model` — otherwise it would fail closed at runtime with no model to call.
  const judgeDefault = process.env.EGRESS_JUDGE_MODEL?.trim();
  if (!judgeDefault && Array.isArray((updates as { guardrailsInline?: unknown }).guardrailsInline)) {
    const inline = (updates as { guardrailsInline: Array<{ name?: string; model?: string }> })
      .guardrailsInline;
    const missing = inline.find(
      (g) => typeof g?.model !== 'string' || g.model.trim() === ''
    );
    if (missing) {
      return c.json(
        {
          error: 'guardrail_model_required',
          error_description: `Custom guardrail "${missing.name ?? '(unnamed)'}" needs a model: the gateway has no default judge model (EGRESS_JUDGE_MODEL is unset).`,
        },
        400
      );
    }
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
 * is a plain int — postgres-js's parameter type inference gets tangled
 * when nesting `hashtext(text)::int` inside the lock's `(int, int)`
 * signature. The deterministic JS hash gives us the same contract: same
 * stable ID → same lock key.
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
// Provides per-key serialization within a single pod; multi-replica safety
// comes from the pg_advisory_xact_lock below (cross-pod writers serialize via
// Postgres). Every PUT enqueues against the previous PUT's completion before
// entering its critical section.
const stablePlatformLockChains: Map<string, Promise<unknown>> = new Map();

/**
 * Run `fn` while serializing concurrent callers that pass the same `stableId`.
 *
 * Combines two layers:
 *
 *   1. **In-process per-stableId Promise chain** — primary serialization
 *      within a single pod. Strictly FIFO; no DB round-trips on the hot path
 *      beyond what `fn` itself does.
 *   2. **`pg_advisory_xact_lock(NAMESPACE, hashStableId(stableId))`** —
 *      acquired and released around a short-lived `BEGIN; ...; COMMIT;` at
 *      the top of each chain entry. Auto-releases on commit (per the
 *      `_xact_` semantics), which means the lock is gone before `fn` runs.
 *      This is the multi-replica safety guard: N>1 pods behind ClientIP
 *      affinity can still race on `lobu apply` from a different machine.
 *      Also surfaces in `pg_locks` for diagnostics.
 *
 * Wrapping the whole flow in a single `sql.begin(...)` is not viable: the
 * tx connection plus parent-pool writes via `connectionStore` /
 * `chatManager.addConnection` would self-deadlock on row-level locks
 * against an uncommitted placeholder row from a different connection.
 */
async function withStablePlatformLock<T>(stableId: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = hashStableId(stableId);
  const previous = stablePlatformLockChains.get(stableId) ?? Promise.resolve();
  const work = previous.then(async () => {
    // Touch the DB-side advisory lock so multi-host writers serialize too.
    // Inlined via unsafe() because the `(int, int)` overload confuses
    // postgres-js's parameter type inference when other queries on the same
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

    const configChanged = !configsEqual(merged, previousConfig);
    // Settings (allowFrom, allowGroups, etc.) are persisted alongside the
    // platform config and are part of "did anything change?" — a
    // settings-only update must trigger willRestart, not be silently noop'd.
    const previousSettings = (current.settings ?? {}) as Record<string, unknown>;
    const mergedSettings = { allowGroups: true, ...settings } as Record<string, unknown>;
    const settingsChanged = !configsEqual(mergedSettings, previousSettings);

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
  //
  // The `desired` Map is keyed by `${teamId} ${channelId}` (a single space as
  // the composite delimiter). A space is collision-safe here because the
  // validation regex below (`[^/\s]+`) rejects any teamId/channelId containing
  // whitespace or `/`, so neither component can ever contain the separator —
  // distinct (team, channel) pairs always produce distinct keys. The Map is
  // also purely in-memory and request-scoped (it never persists; the DB stores
  // team_id/channel_id as separate columns), so there are no stored keys to
  // migrate. Do NOT relax the regex without re-checking this invariant.
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
