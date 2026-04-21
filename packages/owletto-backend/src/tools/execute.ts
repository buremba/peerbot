/**
 * Shared tool execution with access control.
 *
 * Used by both the MCP Streamable HTTP handler and the REST API proxy.
 */

import type { Context } from 'hono';
import { getRequiredAccessLevel, isPublicReadable } from '../auth/tool-access';
import type { Env } from '../index';
import { trackMCPToolCall } from '../sentry';
import { getConfiguredPublicOrigin } from '../utils/public-origin';
import { joinOrganization, listOrganizations, switchOrganization } from './organizations';
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
}

/**
 * Extract auth context from a Hono request context.
 */
export function extractAuthContext(c: Context<{ Bindings: Env }>): AuthContext {
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
  };
}

/**
 * Check access control for a tool call. Throws on denial.
 */
const ORG_AGNOSTIC_TOOLS = new Set(['list_organizations', 'switch_organization']);

function hasRequiredMcpScope(
  requiredAccess: 'read' | 'write' | 'admin',
  scopes: string[] | null | undefined
): boolean {
  if (scopes == null) return true;
  if (scopes.length === 0) return false;
  const scopeSet = new Set(scopes);
  if (requiredAccess === 'read') {
    return scopeSet.has('mcp:read') || scopeSet.has('mcp:write') || scopeSet.has('mcp:admin');
  }
  if (requiredAccess === 'write') {
    return scopeSet.has('mcp:write') || scopeSet.has('mcp:admin');
  }
  return scopeSet.has('mcp:admin');
}

export function checkToolAccess(toolName: string, args: unknown, authCtx: AuthContext): void {
  if (ORG_AGNOSTIC_TOOLS.has(toolName)) {
    if (!authCtx.isAuthenticated) {
      throw new Error('Authentication required.');
    }
    if (authCtx.scopedToOrg) {
      throw new Error(`Tool '${toolName}' is only available on the unscoped /mcp endpoint.`);
    }
    return;
  }

  if (!authCtx.organizationId) {
    throw new Error('Organization context required. Authenticate with OAuth or API key.');
  }

  const tool = getTool(toolName);
  if (!tool) throw new Error(`Tool not found: ${toolName}`);

  const isReadOnly = tool.annotations?.readOnlyHint === true;
  const { memberRole: role } = authCtx;
  const requiredAccess = getRequiredAccessLevel(toolName, args, isReadOnly);

  if (!role && !isPublicReadable(toolName, args)) {
    if (authCtx.userId) {
      throw new Error(
        'This public workspace is read-only for your account. Call the `join_organization` tool to become a member and unlock write access (or join via the web UI).'
      );
    }
    throw new Error(
      'This public workspace is read-only for anonymous access. Sign in with an OAuth client that has write access, then call `join_organization` to become a member.'
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
        'This MCP session is read-only. If this is a public workspace, call `join_organization` first, then reconnect with write-scoped OAuth. Otherwise ask an owner to add you.'
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
  // join_organization bypasses the standard membership/role check — its whole
  // purpose is to upgrade a non-member / read-only session into a member.
  // It still requires the caller to hold at least mcp:read, so OAuth tokens
  // without any MCP scope cannot change membership. The tool itself enforces
  // public-org policy.
  if (toolName === 'join_organization') {
    if (!authCtx.userId) {
      throw new Error('Authentication required to join an organization. Sign in with OAuth first.');
    }
    if (!hasRequiredMcpScope('read', authCtx.scopes)) {
      throw new Error(
        'This MCP session does not include any mcp:* scope. Reconnect with at least read access before calling `join_organization`.'
      );
    }
    return trackMCPToolCall(toolName, args, () =>
      joinOrganization(args as any, env, {
        userId: authCtx.userId!,
        currentOrgId: authCtx.organizationId,
        scopes: authCtx.scopes ?? null,
      })
    );
  }

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
    if (toolName === 'switch_organization') {
      return trackMCPToolCall(toolName, args, () =>
        switchOrganization(args as any, env, {
          userId: authCtx.userId!,
          currentOrgId: authCtx.organizationId,
        })
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
    agentId: authCtx.agentId,
    isAuthenticated: authCtx.isAuthenticated,
    clientId: authCtx.clientId,
    requestUrl: authCtx.requestUrl,
    baseUrl: authCtx.baseUrl,
  };
}
