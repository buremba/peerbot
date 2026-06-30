import { verifyWorkerToken } from '@lobu/core';
import { getAuthConfig as getAuthConfigFromEnv } from '../auth/config';
import { createAuth } from '../auth/index';
import { OAuthProvider } from '../auth/oauth/provider';
import type { AuthInfo } from '../auth/oauth/types';
import { PersonalAccessTokenService } from '../auth/tokens';
import { isPublicReadable } from '../auth/tool-access';
import { getDb } from '../db/client';
import type { Env } from '../index';
import logger from '../utils/logger';
import { getConfiguredPublicOrigin } from '../utils/public-origin';
import type {
  AuthConfigData,
  HonoContext,
  OrgInfo,
  ResolveAuthNext,
  ResolvedOwner,
  WorkspaceProvider,
} from './types';
import {
  clearMultiTenantCachesForTests as clearMultiTenantCachesForTestsShared,
  memberRoleCache,
  orgSlugCache,
  ownerCache,
  sessionCache,
} from './multi-tenant-caches';

// Re-export the test-only cache clearer so existing imports
// (`from '../workspace/multi-tenant'`) keep working; the cache instances
// themselves live in `./multi-tenant-caches` to keep test cleanup off this
// file's heavy import graph.
export const clearMultiTenantCachesForTests = clearMultiTenantCachesForTestsShared;

/**
 * Path namespaces that don't carry an org context. Authenticated requests to
 * these resolve to "authenticated user, no active org" instead of failing on
 * a missing orgSlug. The bare `/mcp` endpoint is handled separately because
 * it's an exact-match, not a prefix.
 *
 * `/api/workers/` is here because device workers (Lobu for Mac/iPhone) poll
 * those endpoints with a user token that may not be bound to any org — the
 * `/api/workers/*` middleware in index.ts does the per-endpoint authz and
 * falls back to the user's personal org.
 */
const UNSCOPED_PATH_PREFIXES = ['/mcp/', '/api/me/', '/api/workers/'];

export function invalidateMembershipRoleCache(
  organizationId: string,
  userId: string | null | undefined
): void {
  if (!userId) return;
  memberRoleCache.delete(`${organizationId}:${userId}`);
}

export function invalidateOrgSlugCache(slug: string | null | undefined): void {
  if (!slug) return;
  orgSlugCache.delete(slug);
}

/**
 * Cache-backed membership-role lookup. Reuses the same 60s cache the auth
 * middleware populates so writes on the `member` table that call
 * `invalidateMembershipRoleCache` take effect for sandbox callers too.
 */
export async function getCachedMembershipRole(
  organizationId: string,
  userId: string | null
): Promise<string | null> {
  if (!userId) return null;
  const key = `${organizationId}:${userId}`;
  const cached = memberRoleCache.get(key);
  if (cached !== undefined) return cached;
  const rows = await getDb()`
      SELECT role FROM "member"
      WHERE "organizationId" = ${organizationId} AND "userId" = ${userId}
      LIMIT 1
    `;
  const role = rows.length > 0 ? (rows[0].role as string) : null;
  memberRoleCache.set(key, role);
  return role;
}

/**
 * Cache-backed org lookup by slug. Returns `null` for unknown slugs.
 */
export async function getCachedOrgBySlug(
  slug: string
): Promise<{ id: string; visibility: string } | null> {
  const cached = orgSlugCache.get(slug);
  if (cached) return cached;
  const rows = await getDb()`
      SELECT id, visibility FROM "organization" WHERE slug = ${slug} LIMIT 1
    `;
  if (rows.length === 0) return null;
  const record = {
    id: rows[0].id as string,
    visibility: (rows[0].visibility as string) ?? "private",
  };
  orgSlugCache.set(slug, record);
  return record;
}

/// Bootstrap identity constants — must match the constants in
/// `packages/server/src/embedded-runtime.ts` (BOOTSTRAP_USER_ID + BOOTSTRAP_ORG_ID).
/**
 * Direct org lookup by id. Uncached — ids are a fallback path for the sandbox's
 * `.org(slugOrId)` accessor, so the TTL cache hit rate would be near-zero.
 */
export async function getOrgById(
  organizationId: string
): Promise<{ slug: string; visibility: string } | null> {
  const rows = await getDb()`
      SELECT slug, visibility FROM "organization" WHERE id = ${organizationId} LIMIT 1
    `;
  if (rows.length === 0) return null;
  return {
    slug: rows[0].slug as string,
    visibility: (rows[0].visibility as string) ?? "private",
  };
}


export class MultiTenantProvider implements WorkspaceProvider {
  async init(): Promise<void> {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required');
    }
    logger.info('[MultiTenantProvider] Initialized');
  }

  async resolveAuth(c: HonoContext, next: ResolveAuthNext): Promise<Response | undefined> {
    const authHeader = c.req.header('Authorization');
    const sql = getDb();
    const baseUrl = getConfiguredPublicOrigin() ?? new URL(c.req.url).origin;
    const requestPath = new URL(c.req.url).pathname;
    const isMcpRoute = requestPath === '/mcp' || requestPath.startsWith('/mcp/');
    // Routes that don't carry an org context resolve to "authenticated user,
    // no active org" instead of failing on a missing orgSlug. Two cases today:
    //   - the bare /mcp endpoint (MCP discovery / initialization)
    //   - the user-scoped /api/me/* namespace (current user's accounts,
    //     devices, web-session handoff, etc.)
    const isUnscopedRoute =
      UNSCOPED_PATH_PREFIXES.some((prefix) => requestPath.startsWith(prefix)) ||
      requestPath === '/mcp';
    const requestedOrgSlug = c.req.param('orgSlug') || c.get('subdomainOrg') || null;
    const requestedToolName = c.req.param('toolName') || null;

    c.set('mcpAuthInfo', null);
    c.set('mcpIsAuthenticated', false);
    c.set('organizationId', null);
    c.set('memberRole', null);
    c.set('user', null);
    c.set('session', null);
    c.set('authSource', null);

    let requestedOrgId: string | null = null;
    let requestedOrgVisibility: string | null = null;
    if (requestedOrgSlug) {
      const cached = orgSlugCache.get(requestedOrgSlug);
      if (cached) {
        requestedOrgId = cached.id;
        requestedOrgVisibility = cached.visibility;
      } else {
        const orgResult = await sql`
          SELECT id, visibility FROM "organization"
          WHERE slug = ${requestedOrgSlug}
          LIMIT 1
        `;
        if (orgResult.length === 0) {
          return c.json(
            {
              error: 'invalid_request',
              error_description: `Organization '${requestedOrgSlug}' not found`,
            },
            404
          );
        }
        requestedOrgId = orgResult[0].id as string;
        requestedOrgVisibility = (orgResult[0].visibility as string) ?? 'private';
        orgSlugCache.set(requestedOrgSlug, {
          id: requestedOrgId,
          visibility: requestedOrgVisibility,
        });
      }
    }

    async function canAccessPublicOrgRequest(): Promise<boolean> {
      if (!requestedToolName) return false;
      if (isMcpRoute) return false;
      if (!['POST', 'PUT', 'PATCH'].includes(c.req.method.toUpperCase())) return false;

      const contentType = c.req.header('content-type') || '';
      if (!contentType.toLowerCase().includes('application/json')) return false;

      try {
        const payload = await c.req.raw.clone().json();
        const args =
          payload && typeof payload === 'object' && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : {};
        return isPublicReadable(requestedToolName, args);
      } catch {
        return false;
      }
    }

    const allowOrgLevelPublicRead =
      requestedOrgVisibility === 'public' && (await canAccessPublicOrgRequest());

    const allowAnonymousPublicOrgMcp = isMcpRoute && requestedOrgVisibility === 'public';

    async function getMembershipRole(
      orgId: string,
      userId: string,
      options?: { bypassCache?: boolean }
    ): Promise<string | null> {
      const cacheKey = `${orgId}:${userId}`;
      if (!options?.bypassCache) {
        const cached = memberRoleCache.get(cacheKey);
        if (cached !== undefined) return cached;
      }

      const result = await sql`
        SELECT role FROM "member"
        WHERE "organizationId" = ${orgId} AND "userId" = ${userId}
        LIMIT 1
      `;
      const role = result.length > 0 ? (result[0].role as string) : null;
      memberRoleCache.set(cacheKey, role);
      return role;
    }

    async function setContextAndContinue(
      overrides: Partial<{
        mcpAuthInfo: AuthInfo | null;
        mcpIsAuthenticated: boolean;
        organizationId: string | null;
        memberRole: string | null;
        user: unknown;
        session: unknown;
        authSource: 'session' | 'pat' | 'oauth' | null;
      }>
    ): Promise<Response | undefined> {
      if (overrides.mcpAuthInfo !== undefined) c.set('mcpAuthInfo', overrides.mcpAuthInfo);
      if (overrides.mcpIsAuthenticated !== undefined)
        c.set('mcpIsAuthenticated', overrides.mcpIsAuthenticated);
      if (overrides.organizationId !== undefined) c.set('organizationId', overrides.organizationId);
      if (overrides.memberRole !== undefined) c.set('memberRole', overrides.memberRole);
      if (overrides.user !== undefined) c.set('user', overrides.user as any);
      if (overrides.session !== undefined) c.set('session', overrides.session as any);
      if (overrides.authSource !== undefined) c.set('authSource', overrides.authSource);
      // The cb (workers/* gating mw) may return a Response to short-circuit;
      // Hono's plain `Next` returns void. `next()` resolves to one of those —
      // pass it back to the caller so a short-circuit Response actually
      // reaches Hono compose and gets installed as c.res. See Bug B fix doc.
      return (await next()) ?? undefined;
    }

    // 1) Embedded worker direct-auth for the in-process lobu-memory MCP.
    // The gateway MCP proxy sets this header after validating/issuing the worker
    // token. Treat it as an internal admin-scoped MCP session for the URL org so
    // unattended watcher runs can use memory tools without a second OAuth loop.
    if (authHeader?.startsWith('Bearer ') && c.req.header('x-lobu-memory-direct-auth') === '1') {
      const workerToken = authHeader.slice(7);
      const tokenData = verifyWorkerToken(workerToken);
      if (!tokenData) {
        return c.json(
          { error: 'invalid_token', error_description: 'Invalid or expired worker token' },
          401,
          {
            'WWW-Authenticate': `Bearer realm="${baseUrl}/.well-known/oauth-protected-resource", error="invalid_token"`,
          }
        );
      }
      if (!requestedOrgId) {
        return c.json(
          { error: 'invalid_request', error_description: 'Organization slug required in URL' },
          400
        );
      }
      if (!tokenData.agentId) {
        return c.json(
          { error: 'invalid_token', error_description: 'Worker token missing agent context' },
          401,
          {
            'WWW-Authenticate': `Bearer realm="${baseUrl}/.well-known/oauth-protected-resource", error="invalid_token"`,
          }
        );
      }
      const agentRows = await sql`
        SELECT owner_user_id
        FROM agents
        WHERE id = ${tokenData.agentId}
          AND organization_id = ${requestedOrgId}
        LIMIT 1
      `;
      if (agentRows.length === 0) {
        return c.json(
          { error: 'insufficient_scope', error_description: 'Worker token is not valid for this organization' },
          403
        );
      }
      // For a builder admin turn (per-run token carries `adminTools`), attribute
      // the call to the verified per-turn admin (`tokenData.userId`, bound to the
      // authenticated owner/admin at session create) rather than the agent's
      // provisioning owner — so the role check and audit reflect the actual
      // actor. Non-builder worker direct-auth keeps the agent-owner attribution.
      const isBuilderAdminTurn = !!tokenData.adminTools?.length;
      const directAuthUserId = isBuilderAdminTurn
        ? tokenData.userId
        : (agentRows[0]?.owner_user_id as string | undefined) ?? tokenData.userId;
      const roleRows = await sql`
        SELECT role
        FROM "member"
        WHERE "organizationId" = ${requestedOrgId}
          AND "userId" = ${directAuthUserId}
        LIMIT 1
      `;
      const directAuthRole = roleRows[0]?.role as string | undefined;
      if (!directAuthRole || !['owner', 'admin'].includes(directAuthRole)) {
        return c.json(
          { error: 'insufficient_scope', error_description: 'Agent owner is not an organization admin' },
          403
        );
      }
      return setContextAndContinue({
        mcpAuthInfo: {
          userId: directAuthUserId,
          organizationId: requestedOrgId,
          clientId: 'lobu-worker',
          scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
          expiresAt: Math.floor((tokenData.timestamp + 2 * 60 * 60 * 1000) / 1000),
          tokenType: 'pat',
          agentId: tokenData.agentId,
          sourceContext: {
            platform: tokenData.platform || undefined,
            conversationId: tokenData.conversationId || undefined,
            channelId: tokenData.channelId || undefined,
            teamId: tokenData.teamId || undefined,
            connectionId: tokenData.connectionId || undefined,
            userId: tokenData.userId || undefined,
            source: tokenData.source || undefined,
          },
          // Builder admin-tool grant rides the per-run worker token (set only
          // for the system agent on an owner/admin turn). Carried through so the
          // execute gate lets the builder call its allowlisted internal tools.
          adminTools: tokenData.adminTools ?? null,
        },
        mcpIsAuthenticated: true,
        organizationId: requestedOrgId,
        memberRole: directAuthRole,
        authSource: 'pat',
      });
    }

    // 2) Bearer token auth (PAT or OAuth)
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const isPat = token.startsWith('owl_pat_');
      const authInfo = isPat
        ? await new PersonalAccessTokenService(sql).verify(token)
        : await new OAuthProvider(sql, baseUrl).verifyAccessToken(token);

      if (!authInfo) {
        // PATs are recognisable by their `owl_pat_` prefix — if one is sent
        // and verify fails, it's truly invalid, refuse fast. For everything
        // else (a bearer that's not a PAT and not an OAuth access token),
        // fall through to the session-cookie branch below: the bearer()
        // plugin will translate Authorization: Bearer <session-token> into
        // a session lookup, so menu-bar / CLI clients holding a session
        // token from POST /api/local-init resolve there.
        if (isPat) {
          return c.json(
            { error: 'invalid_token', error_description: 'Invalid or expired access token' },
            401,
            {
              'WWW-Authenticate': `Bearer realm="${baseUrl}/.well-known/oauth-protected-resource", error="invalid_token"`,
            }
          );
        }
        // Fall through — DO NOT return.
      } else {

      if (!authInfo.userId) {
        return c.json(
          { error: 'invalid_token', error_description: 'Token missing user context' },
          401
        );
      }

      let effectiveOrgId = requestedOrgId;

      // Token's bound org is the default. PATs are intentionally org-scoped:
      // a PAT minted for org A must never be usable against org B even if the
      // owner has membership in both, so the URL slug must match the bound
      // org strictly. OAuth tokens bind to whichever org the user picked at
      // consent time but the user often has memberships in many orgs; the
      // membership check below is the real authorization gate, so for OAuth
      // we trust the URL slug and let membership decide. Without this, a
      // user logged in via `lobu login` (which OAuths into one org) cannot
      // hit cross-org admin routes like POST /api/:slug/tokens — the very
      // call needed to bootstrap a PAT for the second org. On unscoped /mcp
      // we still resolve the default to the bound org instead of leaving it
      // null, matching the contract in `mcp-query-run-split.md`.
      if (authInfo.organizationId) {
        if (requestedOrgId && requestedOrgId !== authInfo.organizationId) {
          if (isPat) {
            return c.json(
              {
                error: 'forbidden',
                error_description: 'Token organization does not match URL organization',
              },
              403
            );
          }
          effectiveOrgId = requestedOrgId;
        } else {
          effectiveOrgId = authInfo.organizationId;
        }
      }

      if (!effectiveOrgId) {
        if (isUnscopedRoute) {
          return setContextAndContinue({
            mcpAuthInfo: authInfo,
            mcpIsAuthenticated: true,
            organizationId: null,
            memberRole: null,
            authSource: isPat ? 'pat' : 'oauth',
          });
        }
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Organization slug required in URL (e.g. /mcp/{org})',
          },
          400
        );
      }

      const role = await getMembershipRole(effectiveOrgId, authInfo.userId, { bypassCache: true });
      const allowPublicOrgWithoutMembership =
        !role &&
        requestedOrgId === effectiveOrgId &&
        requestedOrgVisibility === 'public' &&
        isMcpRoute;

      if (!role && !allowPublicOrgWithoutMembership) {
        return c.json(
          {
            error: 'forbidden',
            error_description: 'Token owner is not a member of this organization',
          },
          403
        );
      }

      // Populate `user` for PAT/OAuth-bearer paths so REST routes that read
      // `c.get('user')` (e.g. POST /agents owner attribution) have a value.
      let bearerUser: { id: string; email: string; name: string; emailVerified: boolean } | null =
        null;
      try {
        const userRows = await sql`
          SELECT id, email, name, "emailVerified"
          FROM "user"
          WHERE id = ${authInfo.userId}
          LIMIT 1
        `;
        if (userRows.length > 0) {
          const row = userRows[0] as {
            id: string;
            email: string;
            name: string;
            emailVerified: boolean | string | number | null;
          };
          bearerUser = {
            id: row.id,
            email: row.email ?? '',
            name: row.name ?? '',
            emailVerified:
              typeof row.emailVerified === 'boolean'
                ? row.emailVerified
                : row.emailVerified === 't' ||
                  row.emailVerified === 'true' ||
                  row.emailVerified === 1,
          };
        }
      } catch {
        bearerUser = null;
      }

      return setContextAndContinue({
        mcpAuthInfo: authInfo,
        mcpIsAuthenticated: true,
        organizationId: effectiveOrgId,
        memberRole: role,
        user: bearerUser,
        authSource: isPat ? 'pat' : 'oauth',
      });
      } // end of `else` branch (PAT/OAuth verify hit)
    }

    // 2) Session cookie auth (web app) — also handles
    //    `Authorization: Bearer <session-token>` via Better Auth's bearer
    //    plugin, which translates the header into a session lookup before
    //    `auth.api.getSession` runs below.
    try {
      // Extract session token for cache key
      const cookieHeader = c.req.header('Cookie') || '';
      const sessionTokenMatch = cookieHeader.match(
        /(?:__Secure-)?better-auth\.session_token=([^;]+)/
      );
      const sessionCacheKey = sessionTokenMatch?.[1] || null;

      let session: { user: any; session: any } | null = null;
      let cacheHit = false;
      if (sessionCacheKey) {
        const cached = sessionCache.get(sessionCacheKey);
        if (cached !== undefined) {
          session = cached;
          cacheHit = true;
        }
      }
      if (!cacheHit) {
        const auth = await createAuth(c.env);
        session = await auth.api.getSession({ headers: c.req.raw.headers });
        // Only cache valid sessions. Caching `null` would let an explicitly
        // revoked or expired session continue to resolve to "no auth" for
        // the cache TTL (30s) instead of returning the upstream's fresh
        // verdict — fine on its own, but it also masks the inverse case
        // where the user just logged in: the prior `null` answer keeps
        // them logged out until the entry expires.
        if (sessionCacheKey && session?.user && session.session) {
          sessionCache.set(sessionCacheKey, session);
        }
      }

      if (session?.user && session.session) {
        if (!requestedOrgId) {
          if (isUnscopedRoute) {
            return setContextAndContinue({
              mcpIsAuthenticated: true,
              organizationId: null,
              memberRole: null,
              user: session.user,
              session: session.session,
              authSource: 'session',
            });
          }
          return c.json(
            { error: 'invalid_request', error_description: 'Organization slug is required in URL' },
            400
          );
        }

        const role = await getMembershipRole(requestedOrgId, session.session.userId);
        if (role) {
          return setContextAndContinue({
            mcpIsAuthenticated: true,
            organizationId: requestedOrgId,
            memberRole: role,
            user: session.user,
            session: session.session,
            authSource: 'session',
          });
        }

        // Non-member: only allow through for public-readable endpoints
        if (!allowOrgLevelPublicRead && !allowAnonymousPublicOrgMcp) {
          return c.json(
            {
              error: 'forbidden',
              error_description: 'You are not a member of this organization',
            },
            403
          );
        }
        return setContextAndContinue({
          mcpIsAuthenticated: false,
          organizationId: requestedOrgId,
          memberRole: null,
          user: session.user,
          session: session.session,
          authSource: 'session',
        });
      }
    } catch {
      // Session validation failed, continue to anonymous
    }

    // If the client sent `Authorization: Bearer …` and we got here, it
    // wasn't a valid PAT, OAuth access token, or Better Auth session token —
    // all three resolution paths above bailed. Return the RFC 6750
    // `invalid_token` error (not the generic anonymous fall-through), so
    // standards-compliant clients surface "bad token" rather than mistaking
    // it for "no auth needed."
    if (authHeader?.startsWith('Bearer ')) {
      return c.json(
        { error: 'invalid_token', error_description: 'Invalid or expired access token' },
        401,
        {
          'WWW-Authenticate': `Bearer realm="${baseUrl}/.well-known/oauth-protected-resource", error="invalid_token"`,
        }
      );
    }

    // 3) Anonymous: allow through with null org for discovery (tools/list, initialize)
    //    tools/call will enforce org context at the handler level.
    if (!requestedOrgId) {
      return setContextAndContinue({ organizationId: null, memberRole: null });
    }

    if (!allowOrgLevelPublicRead && !allowAnonymousPublicOrgMcp) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Authentication required. Use OAuth or API key.',
        },
        401,
        { 'WWW-Authenticate': `Bearer realm="${baseUrl}/.well-known/oauth-protected-resource"` }
      );
    }

    return setContextAndContinue({
      organizationId: requestedOrgId,
      memberRole: null,
    });
  }

  async listOrganizations(search?: string, userId?: string | null): Promise<OrgInfo[]> {
    const sql = getDb();

    if (!userId) {
      const params: string[] = [];
      const searchClause = search ? `AND o.name ILIKE $${params.push(`%${search}%`)}` : '';

      return sql.unsafe(
        `SELECT o.id, o.name, o.slug, o.logo, o.description, o."createdAt" as created_at, false as is_member, o.visibility
         FROM "organization" o
         WHERE o.visibility = 'public' ${searchClause}
         ORDER BY o.name ASC`,
        params
      );
    }

    const params: string[] = [userId];
    const searchClause = search ? `AND o.name ILIKE $${params.push(`%${search}%`)}` : '';

    return sql.unsafe(
      `SELECT o.id, o.name, o.slug, o.logo, o.description, o."createdAt" as created_at,
              (m."userId" IS NOT NULL) as is_member, o.visibility
       FROM "organization" o
       LEFT JOIN "member" m ON o.id = m."organizationId" AND m."userId" = $1
       WHERE (m."userId" IS NOT NULL OR o.visibility = 'public') ${searchClause}
       ORDER BY o.name ASC`,
      params
    );
  }

  async getAuthConfig(env: Env): Promise<AuthConfigData> {
    return getAuthConfigFromEnv(env);
  }

  async getOrgSlug(orgId: string): Promise<string | null> {
    const sql = getDb();
    const rows = await sql`
      SELECT slug FROM "organization" WHERE id = ${orgId} LIMIT 1
    `;
    return rows[0]?.slug ?? null;
  }

  async getOrgSlugs(orgIds: string[]): Promise<Map<string, string>> {
    if (orgIds.length === 0) return new Map();
    const sql = getDb();
    const placeholders = orgIds.map((_, i) => `$${i + 1}`).join(', ');
    const rows = await sql.unsafe<{ id: string; slug: string }>(
      `SELECT id, slug FROM "organization" WHERE id IN (${placeholders})`,
      orgIds
    );
    return new Map(rows.map((row) => [row.id, row.slug]));
  }

  async resolveOwner(slug: string, type: 'user' | 'organization'): Promise<ResolvedOwner | null> {
    const cacheKey = `${type}:${slug}`;
    const cached = ownerCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const sql = getDb();
    const rows = await sql`
      SELECT
        n.slug,
        n.type,
        n.ref_id,
        u.name as user_name,
        o.name as org_name
      FROM namespace n
      LEFT JOIN "user" u ON n.type = 'user' AND n.ref_id = u.id
      LEFT JOIN organization o ON n.type = 'organization' AND n.ref_id = o.id
      WHERE n.slug = ${slug}
        AND n.type = ${type}
    `;
    if (rows.length === 0) {
      // Fallback: namespace entry may be missing, query organization table directly
      if (type === 'organization') {
        const orgRows = await sql`
          SELECT id, name, slug FROM organization WHERE slug = ${slug} LIMIT 1
        `;
        if (orgRows.length > 0) {
          const org = orgRows[0] as { id: string; name: string; slug: string };
          // Self-heal: backfill the missing namespace entry
          await sql`
            INSERT INTO namespace (slug, type, ref_id)
            VALUES (${slug}, 'organization', ${org.id})
            ON CONFLICT (slug) DO NOTHING
          `;
          const result: ResolvedOwner = {
            slug: org.slug,
            type: 'organization',
            id: org.id,
            name: org.name,
          };
          ownerCache.set(cacheKey, result);
          return result;
        }
      }
      ownerCache.set(cacheKey, null);
      return null;
    }
    const row = rows[0] as {
      slug: string;
      type: 'user' | 'organization';
      ref_id: string;
      user_name: string | null;
      org_name: string | null;
    };
    const result: ResolvedOwner = {
      slug: row.slug,
      type: row.type,
      id: row.ref_id,
      name: row.type === 'user' ? row.user_name : row.org_name,
    };
    ownerCache.set(cacheKey, result);
    return result;
  }
}
