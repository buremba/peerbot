/**
 * Canonical access-control predicates shared by tool handlers.
 *
 * `executeTool` (REST/MCP boundary) and `routeAction` (per-action admin tool
 * dispatch) enforce the same role + MCP-scope policy with caller-specific
 * error copy; the decision logic lives here so the two paths cannot drift.
 */

import { hasRequiredMcpScope, type ToolAccessLevel } from '../auth/tool-access';

/** The minimal slice of ToolContext/AuthContext these predicates need. */
interface AccessControlContext {
  isAuthenticated: boolean;
  userId: string | null;
  memberRole: string | null;
}

/**
 * Watcher reactions and other in-process system calls run with
 * `userId=null + isAuthenticated=true` and no member role. They bypass
 * role/scope policy checks at the handler boundary.
 */
export function isSystemContext(ctx: AccessControlContext): boolean {
  return ctx.isAuthenticated === true && ctx.userId === null && ctx.memberRole === null;
}

/** True when the role grants admin-tier access (owner or admin). */
export function isAdminOrOwnerRole(memberRole: string | null | undefined): boolean {
  return memberRole === 'owner' || memberRole === 'admin';
}

/**
 * Caller-specific denial copy. `writeRole` is optional: the MCP/REST boundary
 * handles missing-membership writes via its public-readability branch instead,
 * so it omits the message and skips that check.
 */
interface AccessDenialMessages {
  adminRole: string;
  writeRole?: string;
  readScope: string;
  writeScope: string;
  adminScope: string;
}

/**
 * Enforce the role + MCP-scope policy for a required access level.
 * Throws the caller-provided message on denial; returns on success.
 */
export function enforceRoleScopeAccess(
  requiredAccess: ToolAccessLevel,
  memberRole: string | null,
  scopes: string[] | null | undefined,
  messages: AccessDenialMessages
): void {
  if (requiredAccess === 'admin' && !isAdminOrOwnerRole(memberRole)) {
    throw new Error(messages.adminRole);
  }

  if (requiredAccess === 'write' && messages.writeRole && !memberRole) {
    throw new Error(messages.writeRole);
  }

  if (!hasRequiredMcpScope(requiredAccess, scopes)) {
    if (requiredAccess === 'read') {
      throw new Error(messages.readScope);
    }
    if (requiredAccess === 'write') {
      throw new Error(messages.writeScope);
    }
    throw new Error(messages.adminScope);
  }
}
