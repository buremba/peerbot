/**
 * Shared tool execution with access control.
 *
 * Used by both the MCP Streamable HTTP handler and the REST API proxy.
 */

import { TypeCompiler, type TypeCheck } from '@sinclair/typebox/compiler';
import type { Context } from 'hono';
import { getRequiredAccessLevel, hasRequiredMcpScope, isPublicReadable } from '../auth/tool-access';
import type { Env } from '../index';
import { trackMCPToolCall } from '../sentry';
import { ToolNotRegisteredError, ToolUserError } from '../utils/errors';
import { getConfiguredPublicOrigin } from '../utils/public-origin';
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
    scopes: mcpAuthInfo?.scopes ?? null,
    tokenType,
    requestUrl: c.req.url,
    baseUrl: getConfiguredPublicOrigin() ?? '',
    scopedToOrg,
    allowCrossOrg: tokenType === 'oauth' && !scopedToOrg,
    allowInternalTools:
      !pathname.startsWith('/mcp') || c.req.header('x-lobu-memory-direct-auth') === '1',
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
        'This public workspace is read-only for your account. Join the workspace to unlock write access.'
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
 * Tools whose args are TypeBox-validated at the boundary before the handler
 * runs. Deliberately narrow: only the two SDK-scripting tools where a missing
 * field produced an opaque internal stack trace
 * (`Cannot read properties of undefined (reading 'replace')` from the sandbox
 * compiler). The `manage_*` tools are intentionally NOT here — they carry
 * `_id: Type.Number` round-trip fields and `additionalProperties: false`
 * schemas that lenient handlers tolerated, so flipping strict validation on
 * for them could 400 previously-working external MCP calls. Widening this set
 * requires a per-tool audit — tracked in lobu#1137
 * ("Audit + enable global tool-arg validation safely").
 */
const VALIDATED_TOOLS = new Set(['query_sdk', 'run_sdk']);

/**
 * Per-tool compiled TypeBox validator cache.
 *
 * Tool registrations carry their TypeBox schema as `inputSchema`. Without
 * validating at the boundary, a missing/mistyped field tunnels into the
 * handler and surfaces as a stack trace from deep inside the implementation
 * (e.g. `query_sdk` without `script` exploded as
 * `Cannot read properties of undefined (reading 'replace')` from the sandbox
 * compiler). Compiling once and reusing is what every other validator in
 * this codebase does — see `manage_schedules.ts`, `watcher-execution-config.ts`.
 *
 * Tools whose schema isn't a TypeBox object (e.g. unusual hand-rolled JSON
 * Schema) fall back to no validation rather than crashing the boundary; the
 * handler stays responsible for its own input checks in that case.
 */
const validatorCache = new Map<string, TypeCheck<any> | null>();

function getValidator(toolName: string, schema: unknown): TypeCheck<any> | null {
  if (validatorCache.has(toolName)) {
    return validatorCache.get(toolName) ?? null;
  }
  let validator: TypeCheck<any> | null = null;
  try {
    validator = TypeCompiler.Compile(schema as any);
  } catch {
    validator = null;
  }
  validatorCache.set(toolName, validator);
  return validator;
}

function validateToolArgs(toolName: string, schema: unknown, args: unknown): void {
  if (!schema || typeof schema !== 'object') return;
  const validator = getValidator(toolName, schema);
  if (!validator) return;
  if (validator.Check(args)) return;
  // Deduplicate by path — TypeBox emits both `Expected required property` and
  // `Expected <type>` against the same missing field, which would otherwise
  // duplicate the field name in the error message.
  const seen = new Set<string>();
  const errs: string[] = [];
  for (const e of validator.Errors(args)) {
    const path = e.path || '/';
    if (seen.has(path)) continue;
    seen.add(path);
    errs.push(`${path}: ${e.message}`);
    if (errs.length >= 3) break;
  }
  throw new ToolUserError(`Invalid arguments for ${toolName}: ${errs.join('; ')}`);
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

  // Validate args against the tool's TypeBox schema BEFORE the handler runs,
  // so a missing/mistyped field returns a clean 400 with the offending name
  // rather than a stack-trace from deep inside the handler.
  //
  // Scoped to `query_sdk`/`run_sdk` only — the two tools that produced the
  // user-visible failure this fix targets (a missing `script` exploded as
  // `Cannot read properties of undefined (reading 'replace')` from inside the
  // sandbox compiler). Enabling strict validation across ALL tools at once is
  // a much wider blast radius: several `manage_*` tools have `_id: Type.Number`
  // fields and `additionalProperties: false` schemas that lenient handlers
  // historically tolerated, and live external MCP clients may rely on that.
  // Rolling validation out globally needs a per-tool round-trip audit first —
  // tracked in lobu#1137.
  if (VALIDATED_TOOLS.has(toolName)) {
    validateToolArgs(toolName, tool.inputSchema, args);
  }

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
