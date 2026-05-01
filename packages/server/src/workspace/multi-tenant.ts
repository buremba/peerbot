import { verifyWorkerToken } from '@lobu/core';
import type { Next } from 'hono';
import { getAuthConfig as getAuthConfigFromEnv } from '../auth/config';
import { createAuth } from '../auth/index';
import { OAuthProvider } from '../auth/oauth/provider';
import type { AuthInfo } from '../auth/oauth/types';
import { PersonalAccessTokenService } from '../auth/tokens';
import { isPublicReadable } from '../auth/tool-access';
import { getDb, simpleQuery } from '../db/client';
import type { Env } from '../index';
import logger from '../utils/logger';
import { getConfiguredPublicOrigin } from '../utils/public-origin';
import { TtlCache } from '../utils/ttl-cache';
import type {
  AuthConfigData,
  HonoContext,
  OrgInfo,
  ResolvedOwner,
  WorkspaceProvider,
} from './types';

// Caches – module-level singletons (survive across requests).
const orgSlugCache = new TtlCache<{ id: string; visibility: string }>(60_000); // 60s
const memberRoleCache = new TtlCache<string | null>(60_000); // 60s
const ownerCache = new TtlCache<ResolvedOwner | null>(300_000); // 5min
const sessionCache = new TtlCache<{ user: any; session: any } | null>(30_000); // 30s

export function invalidateMembershipRoleCache(
  organizationId: string,
  userId: string | null | undefined
): void {
  if (!userId) return;
  memberRoleCache.delete(`${organizationId}:${userId}`);
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
  const rows = await simpleQuery(
    getDb()`
      SELECT role FROM "member"
      WHERE "organizationId" = ${organizationId} AND "userId" = ${userId}
      LIMIT 1
    `
  );
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
  const rows = await simpleQuery(
    getDb()`
      SELECT id, visibility FROM "organization" WHERE slug = ${slug} LIMIT 1
    `
  );
  if (rows.length === 0) return null;
  const record = {
    id: rows[0].id as string,
    visibility: (rows[0].visibility as string) ?? "private",
  };
  orgSlugCache.set(slug, record);
  return record;
}

/**
 * Direct org lookup by id. Uncached — ids are a fallback path for the sandbox's
 * `.org(slugOrId)` accessor, so the TTL cache hit rate would be near-zero.
 */
export async function getOrgById(
  organizationId: string
): Promise<{ slug: string; visibility: string } | null> {
  const rows = await simpleQuery(
    getDb()`
      SELECT slug, visibility FROM "organization" WHERE id = ${organizationId} LIMIT 1
    `
  );
  if (rows.length === 0) return null;
  return {
    slug: rows[0].slug as string,
    visibility: (rows[0].visibility as string) ?? "private",
  };
}

/**
 * Test-only: clear all multi-tenant auth caches so a freshly-reset database
 * (new org/user/token IDs) is not shadowed by TTL'd entries from the previous run.
 * Referenced from cleanupTestDatabase().
 */
export function clearMultiTenantCachesForTests(): void {
  orgSlugCache.clear();
  memberRoleCache.clear();
  ownerCache.clear();
  sessionCache.clear();
}

export class MultiTenantProvider implements WorkspaceProvider {
  async init(): Promise<void> {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required');
    }
    logger.info('[MultiTenantProvider] Initialized');
  }

  async resolveAuth(c: HonoContext, next: Next): Promise<Response | undefined> {
    const authHeader = c.req.header('Authorization');
    const sql = getDb();
    const baseUrl = getConfiguredPublicOrigin() ?? new URL(c.req.url).origin;
    const requestPath = new URL(c.req.url).pathname;
    const isMcpRoute = requestPath === '/mcp' || requestPath.startsWith('/mcp/');
    const isUnscopedMcpRoute = requestPath === '/mcp' || requestPath === '/mcp/';
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
        const orgResult = await simpleQuery(sql`
          SELECT id, visibility FROM "organization"
          WHERE slug = ${requestedOrgSlug}
          LIMIT 1
        `);
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

      const result = await simpleQuery(sql`
        SELECT role FROM "member"
        WHERE "organizationId" = ${orgId} AND "userId" = ${userId}
        LIMIT 1
      `);
      const role = result.length > 0 ? (result[0].role as string) : null;
      memberRoleCache.set(cacheKey, role);
      return role;
    }

    function setContextAndContinue(
      overrides: Partial<{
        mcpAuthInfo: AuthInfo | null;
        mcpIsAuthenticated: boolean;
        organizationId: string | null;
        memberRole: string | null;
        user: unknown;
        session: unknown;
        authSource: 'session' | 'pat' | 'oauth' | null;
      }>
    ) {
      if (overrides.mcpAuthInfo !== undefined) c.set('mcpAuthInfo', overrides.mcpAuthInfo);
      if (overrides.mcpIsAuthenticated !== undefined)
        c.set('mcpIsAuthenticated', overrides.mcpIsAuthenticated);
      if (overrides.organizationId !== undefined) c.set('organizationId', overrides.organizationId);
      if (overrides.memberRole !== undefined) c.set('memberRole', overrides.memberRole);
      if (overrides.user !== undefined) c.set('user', overrides.user as any);
      if (overrides.session !== undefined) c.set('session', overrides.session as any);
      if (overrides.authSource !== undefined) c.set('authSource', overrides.authSource);
      return next();
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
      const agentRows = await simpleQuery(sql`
        SELECT owner_user_id
        FROM agents
        WHERE id = ${tokenData.agentId}
          AND organization_id = ${requestedOrgId}
        LIMIT 1
      `);
      if (agentRows.length === 0) {
        return c.json(
          { error: 'insufficient_scope', error_description: 'Worker token is not valid for this organization' },
          403
        );
      }
      const directAuthUserId = (agentRows[0]?.owner_user_id as string | undefined) ?? tokenData.userId;
      const roleRows = await simpleQuery(sql`
        SELECT role
        FROM "member"
        WHERE "organizationId" = ${requestedOrgId}
          AND "userId" = ${directAuthUserId}
        LIMIT 1
      `);
      const directAuthRole = roleRows[0]?.role as string | undefined;
      if (!directAuthRole || !['owner', 'admin'].includes(directAuthRole)) {
        return c.json(
          { error: 'insufficient_scope', error_description: 'Agent owner is not an organization admin' },
          403
        );
      }
      await setContextAndContinue({
        mcpAuthInfo: {
          userId: directAuthUserId,
          organizationId: requestedOrgId,
          clientId: 'lobu-worker',
          scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
          expiresAt: Math.floor((tokenData.timestamp + 2 * 60 * 60 * 1000) / 1000),
          tokenType: 'pat',
        },
        mcpIsAuthenticated: true,
        organizationId: requestedOrgId,
        memberRole: directAuthRole,
        authSource: 'pat',
      });
      return undefined;
    }

    // 2) Bearer token auth (PAT or OAuth)
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const isPat = token.startsWith('owl_pat_');
      const authInfo = isPat
        ? await new PersonalAccessTokenService(sql).verify(token)
        : await new OAuthProvider(sql, baseUrl).verifyAccessToken(token);

      if (!authInfo) {
        return c.json(
          { error: 'invalid_token', error_description: 'Invalid or expired access token' },
          401,
          {
            'WWW-Authenticate': `Bearer realm="${baseUrl}/.well-known/oauth-protected-resource", error="invalid_token"`,
          }
        );
      }

      if (!authInfo.userId) {
        return c.json(
          { error: 'invalid_token', error_description: 'Token missing user context' },
          401
        );
      }

      let effectiveOrgId = requestedOrgId;

      // Token's bound org is the default. On scoped routes the URL slug must
      // match the token's binding (already enforced); on unscoped /mcp we now
      // resolve the default to the bound org instead of leaving it null. This
      // matches the contract documented in `mcp-query-run-split.md`.
      if (authInfo.organizationId) {
        if (requestedOrgId && requestedOrgId !== authInfo.organizationId) {
          return c.json(
            {
              error: 'forbidden',
              error_description: 'Token organization does not match URL organization',
            },
            403
          );
        }
        effectiveOrgId = authInfo.organizationId;
      }

      if (!effectiveOrgId) {
        if (isUnscopedMcpRoute) {
          await setContextAndContinue({
            mcpAuthInfo: authInfo,
            mcpIsAuthenticated: true,
            organizationId: null,
            memberRole: null,
            authSource: isPat ? 'pat' : 'oauth',
          });
          return undefined;
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
        const userRows = await simpleQuery(sql`
          SELECT id, email, name, "emailVerified"
          FROM "user"
          WHERE id = ${authInfo.userId}
          LIMIT 1
        `);
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

      await setContextAndContinue({
        mcpAuthInfo: authInfo,
        mcpIsAuthenticated: true,
        organizationId: effectiveOrgId,
        memberRole: role,
        user: bearerUser,
        authSource: isPat ? 'pat' : 'oauth',
      });
      return undefined;
    }

    // 2) Session cookie auth (web app)
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
        if (sessionCacheKey) {
          sessionCache.set(sessionCacheKey, session ?? null);
        }
      }

      if (session?.user && session.session) {
        if (!requestedOrgId) {
          if (isUnscopedMcpRoute) {
            await setContextAndContinue({
              mcpIsAuthenticated: true,
              organizationId: null,
              memberRole: null,
              user: session.user,
              session: session.session,
              authSource: 'session',
            });
            return undefined;
          }
          return c.json(
            { error: 'invalid_request', error_description: 'Organization slug is required in URL' },
            400
          );
        }

        const role = await getMembershipRole(requestedOrgId, session.session.userId);
        if (role) {
          await setContextAndContinue({
            mcpIsAuthenticated: true,
            organizationId: requestedOrgId,
            memberRole: role,
            user: session.user,
            session: session.session,
            authSource: 'session',
          });
          return undefined;
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
        await setContextAndContinue({
          mcpIsAuthenticated: false,
          organizationId: requestedOrgId,
          memberRole: null,
          user: session.user,
          session: session.session,
          authSource: 'session',
        });
        return undefined;
      }
    } catch {
      // Session validation failed, continue to anonymous
    }

    // 3) Anonymous: allow through with null org for discovery (tools/list, initialize)
    //    tools/call will enforce org context at the handler level.
    if (!requestedOrgId) {
      await setContextAndContinue({ organizationId: null, memberRole: null });
      return undefined;
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

    await setContextAndContinue({
      organizationId: requestedOrgId,
      memberRole: null,
    });
    return undefined;
  }

  async listOrganizations(search?: string, userId?: string | null): Promise<OrgInfo[]> {
    const sql = getDb();

    if (!userId) {
      const params: string[] = [];
      const searchClause = search ? `AND o.name ILIKE $${params.push(`%${search}%`)}` : '';

      return simpleQuery(
        sql.unsafe(
          `SELECT o.id, o.name, o.slug, o.logo, o.description, o."createdAt" as created_at, false as is_member, o.visibility
         FROM "organization" o
         WHERE o.visibility = 'public' ${searchClause}
         ORDER BY o.name ASC`,
          params
        )
      );
    }

    const params: string[] = [userId];
    const searchClause = search ? `AND o.name ILIKE $${params.push(`%${search}%`)}` : '';

    return simpleQuery(
      sql.unsafe(
        `SELECT o.id, o.name, o.slug, o.logo, o.description, o."createdAt" as created_at,
              (m."userId" IS NOT NULL) as is_member, o.visibility
       FROM "organization" o
       LEFT JOIN "member" m ON o.id = m."organizationId" AND m."userId" = $1
       WHERE (m."userId" IS NOT NULL OR o.visibility = 'public') ${searchClause}
       ORDER BY o.name ASC`,
        params
      )
    );
  }

  async getAuthConfig(env: Env): Promise<AuthConfigData> {
    return getAuthConfigFromEnv(env);
  }

  async getOrgSlug(orgId: string): Promise<string | null> {
    const sql = getDb();
    const rows = await simpleQuery(sql`
      SELECT slug FROM "organization" WHERE id = ${orgId} LIMIT 1
    `);
    return rows[0]?.slug ?? null;
  }

  async getOrgSlugs(orgIds: string[]): Promise<Map<string, string>> {
    if (orgIds.length === 0) return new Map();
    const sql = getDb();
    const placeholders = orgIds.map((_, i) => `$${i + 1}`).join(', ');
    const rows = await simpleQuery(
      sql.unsafe<{ id: string; slug: string }>(
        `SELECT id, slug FROM "organization" WHERE id IN (${placeholders})`,
        orgIds
      )
    );
    return new Map(rows.map((row) => [row.id, row.slug]));
  }

  async resolveOwner(slug: string, type: 'user' | 'organization'): Promise<ResolvedOwner | null> {
    const cacheKey = `${type}:${slug}`;
    const cached = ownerCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const sql = getDb();
    const rows = await simpleQuery(sql`
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
    `);
    if (rows.length === 0) {
      // Fallback: namespace entry may be missing, query organization table directly
      if (type === 'organization') {
        const orgRows = await simpleQuery(sql`
          SELECT id, name, slug FROM organization WHERE slug = ${slug} LIMIT 1
        `);
        if (orgRows.length > 0) {
          const org = orgRows[0] as { id: string; name: string; slug: string };
          // Self-heal: backfill the missing namespace entry
          await simpleQuery(sql`
            INSERT INTO namespace (slug, type, ref_id)
            VALUES (${slug}, 'organization', ${org.id})
            ON CONFLICT (slug) DO NOTHING
          `);
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
