/**
 * Shared tool execution with access control.
 *
 * Used by both the MCP Streamable HTTP handler and the REST API proxy.
 */

import type { Context } from 'hono';
import { getRequiredAccessLevel, hasRequiredMcpScope, isPublicReadable } from '../auth/tool-access';
import type { Env } from '../index';
import { trackMCPToolCall } from '../sentry';
import { ToolNotRegisteredError } from '../utils/errors';
import { getConfiguredPublicOrigin } from '../utils/public-origin';
import { listOrganizations } from './organizations';
import { getTool, type ToolContext } from './registry';

/**
 * Auth context extracted from Hono middleware variables.
 */
export interface AuthContext {
  organizationId: string | null;
  userId: string | null;
  memberRole: string | null;
  agentId: string | null;
  requestedAgentId: string | null;
  isAuthenticated: boolean;
  clientId: string | null;
  scopes?: string[] | null;
  requestUrl: string;
  baseUrl: string;
  /** True when the MCP URL included an org slug (e.g. /mcp/acme). */
  scopedToOrg: boolean;
  /** Workspace instructions (populated after org resolution in MCP sessions). */
  instructions?: string;
  /** REST/session compatibility path may invoke tools hidden from external MCP. */
  allowInternalTools?: boolean;
}

/**
 * Extract auth context from a Hono request context.
 */
export function extractAuthContext(c: Context<{ Bindings: Env }>): AuthContext {
  const pathname = new URL(c.req.url).pathname;
  return {
    organizationId: c.var.organizationId,
    userId: c.var.mcpAuthInfo?.userId || c.var.session?.userId || null,
    memberRole: c.var.memberRole,
    agentId: null,
    requestedAgentId: null,
    isAuthenticated: c.var.mcpIsAuthenticated || false,
    clientId: c.var.mcpAuthInfo?.clientId ?? null,
    scopes: c.var.mcpAuthInfo?.scopes ?? null,
    requestUrl: c.req.url,
    baseUrl: getConfiguredPublicOrigin() ?? '',
    scopedToOrg: !!c.req.param('orgSlug'),
    allowInternalTools: !pathname.startsWith('/mcp'),
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
  if (tool.internal && !authCtx.allowInternalTools) {
    throw new Error(`Tool not found: ${toolName}`);
  }

  const isReadOnly = tool.annotations?.readOnlyHint === true;
  const { memberRole: role } = authCtx;
  const requiredAccess = getRequiredAccessLevel(toolName, args, isReadOnly);

  if (!role && !isPublicReadable(toolName, args)) {
    if (authCtx.userId) {
      throw new Error(
        'This public workspace is read-only for your account. Ask an organization owner for an invite to unlock write access.'
      );
    }
    throw new Error(
      'This public workspace is read-only for anonymous access. Sign in with an OAuth client that has write access.'
    );
  }

  if (requiredAccess === 'admin') {
    if (role !== 'owner' && role !== 'admin') {
      throw new Error(
        'This action requires admin or owner access. Ask an organization owner to grant elevated access.'
      );
    }
  }

  if (!hasRequiredMcpScope(requiredAccess, authCtx.scopes)) {
    if (requiredAccess === 'read') {
      throw new Error(
        'This MCP session does not include read access. Reconnect with read access for this workspace.'
      );
    }
    if (requiredAccess === 'write') {
      throw new Error(
        'This MCP session is read-only. Reconnect with write-scoped OAuth, or ask an owner to add you.'
      );
    }
    throw new Error(
      'This MCP session does not include admin access. Reconnect with admin access after an owner grants the role.'
    );
  }
}

/**
 * Execute a tool by name with access control and Sentry tracking.
 * Returns the raw tool result (caller decides formatting).
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
        listOrganizations(args as any, env, { userId: authCtx.userId! })
      );
    }
  }

  const tool = getTool(toolName)!;
  const toolContext = toToolContext(authCtx);

  return trackMCPToolCall(toolName, args, () => tool.handler(args, env, toolContext));
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
    requestUrl: authCtx.requestUrl,
    baseUrl: authCtx.baseUrl,
  };
}
