/**
 * Shared tool execution with access control.
 *
 * Used by both the MCP Streamable HTTP handler and the REST API proxy.
 */

import type { Context } from 'hono';
import {
  getRequiredAccessLevel,
  hasRequiredMcpScope,
  isPublicReadable,
  SCOPE_CHECK_NOT_APPLICABLE,
} from '../auth/tool-access';
import type { Env } from '../index';
import { trackMCPToolCall } from '../sentry';
import { ToolNotRegisteredError } from '../utils/errors';
import { getConfiguredPublicOrigin } from '../utils/public-origin';
import { enforceRoleScopeAccess } from './access-control';
import { recordToolInvocationAudit } from './audit';
import { listOrganizations } from './organizations';
import { getTool, type TokenType, type ToolContext } from './registry';

export interface AuthContext {
  organizationId: string | null;
  /**
   * Raw `organization_id` from the OAuth/PAT record itself (null for legacy
   * tokens minted before the binding was required, and always null for
   * session/anonymous). Distinct from `organizationId`, which is the
   * *resolved* org for the request and may come from a URL slug on
   * `/mcp/{slug}` even when the token has no claim of its own.
   */
  tokenOrganizationId: string | null;
  userId: string | null;
  memberRole: string | null;
  agentId: string | null;
  requestedAgentId: string | null;
  isAuthenticated: boolean;
  clientId: string | null;
  scopes?: string[] | null;
  tokenType: TokenType;
  requestUrl: string;
  baseUrl: string;
  scopedToOrg: boolean;
  allowCrossOrg: boolean;
  instructions?: string;
  allowInternalTools?: boolean;
  /**
   * Per-turn allowlist of internal admin tool names this request may call even
   * on the worker (/mcp) path. Carried on the builder/system agent's per-run
   * worker token (see WorkerTokenData.adminTools); empty/null for everyone else.
   */
  adminTools?: string[] | null;
}

export function extractAuthContext(c: Context<{ Bindings: Env }>): AuthContext {
  const pathname = new URL(c.req.url).pathname;
  const mcpAuthInfo = c.var.mcpAuthInfo ?? null;
  const tokenType: TokenType =
    mcpAuthInfo?.tokenType === 'pat' ? 'pat'
    : mcpAuthInfo?.tokenType === 'access_token' ? 'oauth'
    : c.var.session?.userId ? 'session'
    : 'anonymous';
  const scopedToOrg = !!c.req.param('orgSlug');

  return {
    organizationId: c.var.organizationId,
    tokenOrganizationId: mcpAuthInfo?.organizationId ?? null,
    userId: mcpAuthInfo?.userId || c.var.session?.userId || null,
    memberRole: c.var.memberRole,
    agentId: null,
    requestedAgentId: null,
    isAuthenticated: c.var.mcpIsAuthenticated || false,
    clientId: mcpAuthInfo?.clientId ?? null,
    // Token callers (oauth/pat) carry real MCP scopes — pass them straight
    // through so `hasRequiredMcpScope` gates on the actual grant. Session and
    // anonymous callers have no scope dimension (they're gated by member role
    // + public-readability upstream), so pass the explicit not-applicable
    // sentinel rather than `null`/`undefined`, which now FAILS CLOSED in
    // `hasRequiredMcpScope`. A token minted without scopes presents `[]`,
    // which still denies — only the sentinel bypasses the scope check.
    scopes:
      mcpAuthInfo != null
        ? (mcpAuthInfo.scopes ?? [])
        : [...SCOPE_CHECK_NOT_APPLICABLE],
    tokenType,
    requestUrl: c.req.url,
    baseUrl: getConfiguredPublicOrigin() ?? '',
    scopedToOrg,
    allowCrossOrg: tokenType === 'oauth' && !scopedToOrg,
    allowInternalTools:
      !pathname.startsWith('/mcp') || c.req.header('x-lobu-memory-direct-auth') === '1',
    // Builder admin-tool grant: carried from the verified worker token through
    // mcpAuthInfo (see multi-tenant worker direct-auth). Lets the system agent
    // call its allowlisted internal tools even on the /mcp path.
    adminTools: mcpAuthInfo?.adminTools ?? null,
  };
}

/**
 * Check access control for a tool call. Throws on denial.
 */
const ORG_AGNOSTIC_TOOLS = new Set(['list_organizations']);

export function checkToolAccess(toolName: string, args: unknown, authCtx: AuthContext): void {
  if (ORG_AGNOSTIC_TOOLS.has(toolName)) {
    if (!authCtx.isAuthenticated) {
      throw new Error('Authentication required.');
    }
    // list_organizations is read-tier; OAuth tokens without `mcp:read`
    // (e.g. profile-only) must not call it.
    if (!hasRequiredMcpScope('read', authCtx.scopes)) {
      throw new Error(
        'This MCP session does not include read access. Reconnect with read access to list organizations.'
      );
    }
    return;
  }

  if (!authCtx.organizationId) {
    throw new Error('Organization context required. Authenticate with OAuth or API key.');
  }

  const tool = getTool(toolName);
  // Genuinely unregistered → typed error so the REST proxy can fire a Sentry
  // alert (registry/frontend drift). Internal-tool hidden from MCP → plain
  // Error to avoid leaking the existence of internal handlers.
  if (!tool) {
    throw new ToolNotRegisteredError(toolName);
  }
  if (tool.internal) {
    const adminAllowlist = authCtx.adminTools;
    if (adminAllowlist && adminAllowlist.length > 0) {
      // System-agent (builder) run: the per-turn allowlist is the LIMIT, not an
      // addition. It OVERRIDES the blanket `allowInternalTools` so the builder
      // can only reach its designated admin tools (manage_agents, …) — never
      // every internal tool — even though its worker traverses the direct-auth
      // path that would otherwise enable all of them. Other callers (no
      // allowlist) keep the existing `allowInternalTools` behavior unchanged.
      if (!adminAllowlist.includes(toolName)) {
        throw new Error(`Tool not found: ${toolName}`);
      }
    } else if (!authCtx.allowInternalTools) {
      throw new Error(`Tool not found: ${toolName}`);
    }
  }

  const isReadOnly = tool.annotations?.readOnlyHint === true;
  const { memberRole: role } = authCtx;
  const requiredAccess = getRequiredAccessLevel(toolName, args, isReadOnly);

  if (!role && !isPublicReadable(toolName, args)) {
    if (authCtx.userId) {
      throw new Error(
        'This public workspace is read-only for your account. Join the workspace to unlock write access.'
      );
    }
    throw new Error(
      'This public workspace is read-only for anonymous access. Sign in with an OAuth client that has write access.'
    );
  }

  // No `writeRole` message: missing-membership writes are already rejected by
  // the public-readability branch above, matching the historical behavior.
  enforceRoleScopeAccess(requiredAccess, role, authCtx.scopes, {
    adminRole:
      'This action requires admin or owner access. Ask an organization owner to grant elevated access.',
    readScope:
      'This MCP session does not include read access. Reconnect with read access for this workspace.',
    writeScope:
      'This MCP session is read-only. Reconnect with write-scoped OAuth, or ask an owner to add you.',
    adminScope:
      'This MCP session does not include admin access. Reconnect with admin access after an owner grants the role.',
  });
}

/**
 * Execute a tool by name with access control and Sentry tracking.
 * Returns the raw tool result (caller decides formatting).
 *
 * Arg validation does NOT live here: every registered handler is wrapped
 * with `withValidatedArgs` at its definition (`tools/validate-args.ts`), so
 * direct REST calls and the sandbox SDK namespaces get the same coerce +
 * validate behavior as this path (lobu#1137).
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  env: Env,
  authCtx: AuthContext
): Promise<unknown> {
  checkToolAccess(toolName, args, authCtx);

  // Org-agnostic tools get a minimal context with just userId
  if (ORG_AGNOSTIC_TOOLS.has(toolName)) {
    if (!authCtx.userId) {
      throw new Error('User context required.');
    }
    if (toolName === 'list_organizations') {
      return trackMCPToolCall(toolName, args, () =>
        listOrganizations(args as any, env, {
          userId: authCtx.userId!,
          currentOrganizationId: authCtx.organizationId,
        })
      );
    }
  }

  const tool = getTool(toolName)!;
  const toolContext = toToolContext(authCtx);
  const startTime = Date.now();

  try {
    const result = await trackMCPToolCall(toolName, args, () => tool.handler(args, env, toolContext));
    await recordToolInvocationAudit({
      toolName,
      args,
      result,
      durationMs: Date.now() - startTime,
      ctx: toolContext,
    });
    return result;
  } catch (error) {
    await recordToolInvocationAudit({
      toolName,
      args,
      error,
      durationMs: Date.now() - startTime,
      ctx: toolContext,
    });
    throw error;
  }
}

/**
 * Build a ToolContext from an AuthContext. Requires organizationId to be set.
 */
export function toToolContext(authCtx: AuthContext): ToolContext {
  if (!authCtx.organizationId) {
    throw new Error('Organization context required. Authenticate with OAuth or API key.');
  }
  return {
    organizationId: authCtx.organizationId,
    userId: authCtx.userId,
    memberRole: authCtx.memberRole,
    agentId: authCtx.agentId,
    isAuthenticated: authCtx.isAuthenticated,
    clientId: authCtx.clientId,
    scopes: authCtx.scopes,
    tokenType: authCtx.tokenType,
    scopedToOrg: authCtx.scopedToOrg,
    allowCrossOrg: authCtx.allowCrossOrg,
    requestUrl: authCtx.requestUrl,
    baseUrl: authCtx.baseUrl,
  };
}
