/**
 * Shared tool execution with access control.
 *
 * Used by both the MCP Streamable HTTP handler and the REST API proxy.
 */

import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { isToolError, retryWithBackoff, ToolError } from '@lobu/core';
import {
  getRequiredAccessLevel,
  hasRequiredMcpScope,
  isPublicReadable,
  SCOPE_CHECK_NOT_APPLICABLE,
} from '../auth/tool-access';
import type { Env } from '../index';
import { trackMCPToolCall } from '../sentry';
import { parseApplyId } from '../utils/apply-context';
import { ToolNotRegisteredError, ToolUserError } from '../utils/errors';
import { getConfiguredPublicOrigin } from '../utils/public-origin';
import { enforceRoleScopeAccess } from './access-control';
import { recordToolInvocationAudit } from './audit';
import { listOrganizations } from './organizations';
import { getTool, type TokenType, type ToolContext, type ToolSourceContext } from './registry';

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
  sourceContext?: ToolSourceContext | null;
  isAuthenticated: boolean;
  clientId: string | null;
  scopes?: string[] | null;
  tokenType: TokenType;
  requestUrl: string;
  baseUrl: string;
  scopedToOrg: boolean;
  allowCrossOrg: boolean;
  /**
   * Persistent MCP session id (`mcp-session-id` header) when the call arrived
   * through an MCP transport session; null for REST-proxy and internal calls.
   * Audit rows carry it so a client's activity can be grouped per session.
   */
  mcpSessionId?: string | null;
  instructions?: string;
  /** `x-lobu-apply-id` when the call belongs to a `lobu apply` run. */
  applyId?: string | null;
  /**
   * Per-turn LIMIT on which tools may execute admin-tier actions. Carried on
   * the builder/system agent's per-run worker token (see
   * WorkerTokenData.adminTools); empty/null for everyone else (no limit —
   * role × scope decide). Non-admin-tier actions are unaffected.
   */
  adminTools?: string[] | null;
}

/**
 * A resolved TOOL-level failure — the tool could not do its job — which is not
 * thrown, so the MCP boundary must mark it with `isError`. These carry a
 * top-level `error` STRING (query_sql's `{ rows: [], error }`, an action tool's
 * `{ error }`).
 *
 * Deliberately NOT a script failure. `run_sdk` / `query_sdk` execute arbitrary
 * caller code and report the outcome as DATA: `SdkScriptResultSchema` makes
 * `success` a required field and documents `error` as "the thrown error, with
 * script position" (name/message/line/column). When a script throws, the tool
 * itself ran perfectly — it executed the code and returned a faithful report.
 * Marking that `isError` conflates "the sandbox failed to run your code" with
 * "your code ran and threw", which callers must distinguish: `mcpToolsCall`
 * throws on `isError`, so it would stop tests/agents from ever reading the
 * documented `success: false` payload, and `interaction-bridge` would relabel a
 * legitimate script throw as "Tool error:" in agent-visible output.
 */
export function isSoftErrorResult(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const candidate = result as { error?: unknown };
  return typeof candidate.error === 'string' && candidate.error.length > 0;
}

export function extractAuthContext(c: Context<{ Bindings: Env }>): AuthContext {
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
    agentId: mcpAuthInfo?.agentId ?? null,
    requestedAgentId: mcpAuthInfo?.agentId ?? null,
    sourceContext: mcpAuthInfo?.sourceContext ?? null,
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
    applyId: parseApplyId(c.req.header('x-lobu-apply-id')),
    // Builder admin-tool LIMIT: only the verified worker token's per-turn
    // allowlist (the builder/system agent run) carries this. External
    // `mcp:admin` callers need no grant — every tool is reachable uniformly
    // and role × scope decide, so the old two-tool external allowlist is gone.
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
  // alert (registry/frontend drift).
  if (!tool) {
    throw new ToolNotRegisteredError(toolName);
  }

  const isReadOnly = tool.annotations?.readOnlyHint === true;
  const { memberRole: role } = authCtx;
  const requiredAccess = getRequiredAccessLevel(toolName, args, isReadOnly);

  // System-agent (builder) run: the per-turn allowlist is a LIMIT on which
  // tools may exercise ADMIN-tier actions. Read/write-tier actions follow the
  // uniform role × scope model like every other caller.
  const adminAllowlist = authCtx.adminTools;
  if (
    requiredAccess === 'admin' &&
    adminAllowlist &&
    adminAllowlist.length > 0 &&
    !adminAllowlist.includes(toolName)
  ) {
    throw new Error(
      `This agent run may not perform admin actions with ${toolName}. Allowed admin tools: ${adminAllowlist.join(', ')}.`
    );
  }

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

  // Per-invocation correlation id (lobu#2051 Item 2). Distinct from the
  // background-run `run_id` (a bigint on the runs table) — this identifies a
  // single tool call so a failure can be traced across logs/audit/response.
  const callId = randomUUID();

  const runHandler = () =>
    trackMCPToolCall(toolName, args, () => tool.handler(args, env, toolContext));

  try {
    // Auto-retry (lobu#2051 Item 2): only transient thrown ToolErrors, and only
    // for read/test tools on the allowlist. Mutations and run_sdk are never
    // retried here — re-running them could double-write. Resolved failures from
    // query_sql and query_sdk never throw, so their retryability metadata is
    // advisory for the agent.
    const result = RETRYABLE_TOOLS.has(toolName)
      ? await retryWithBackoff(runHandler, {
          maxRetries: 2,
          baseDelay: 500,
          maxDelay: 4000,
          jitter: 'full',
          shouldRetry: (err) => isRetryableToolError(err),
        })
      : await runHandler();
    await recordToolInvocationAudit({
      toolName,
      args,
      result,
      durationMs: Date.now() - startTime,
      ctx: toolContext,
    });
    return result;
  } catch (error) {
    // Stamp the correlation id onto typed errors so the response boundaries can
    // surface `call_id` alongside the structured `code`/`retryable`.
    if (error instanceof ToolError || error instanceof ToolUserError) {
      error.callId = callId;
    }
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
 * Tools safe to auto-retry on a transient failure (lobu#2051 Item 2): read-only,
 * with no side effects. Mutations and `run_sdk` (arbitrary user script) are
 * excluded — retrying them risks a double-write.
 *
 * `manage_connections.test` is deliberately NOT here: it's a *sub-action* of a
 * tool that also mutates, and putting the whole tool on the allowlist would
 * auto-retry those mutations too. `handleTest` never throws (it returns a soft
 * `{status,message,error_code}` result), so it gains nothing from auto-retry
 * anyway — its `retryable` flag is advisory for the agent.
 */
const RETRYABLE_TOOLS = new Set(['query_sql', 'query_sdk']);

/** True when a thrown value is a retryable typed error. */
function isRetryableToolError(err: Error): boolean {
  if (isToolError(err)) return err.retryable;
  if (err instanceof ToolUserError) return err.retryable;
  return false;
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
    sourceContext: authCtx.sourceContext ?? null,
    isAuthenticated: authCtx.isAuthenticated,
    clientId: authCtx.clientId,
    scopes: authCtx.scopes,
    tokenType: authCtx.tokenType,
    scopedToOrg: authCtx.scopedToOrg,
    allowCrossOrg: authCtx.allowCrossOrg,
    requestUrl: authCtx.requestUrl,
    baseUrl: authCtx.baseUrl,
    applyId: authCtx.applyId ?? null,
    mcpSessionId: authCtx.mcpSessionId ?? null,
  };
}
