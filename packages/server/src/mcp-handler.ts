/**
 * Streamable HTTP MCP transport handler.
 *
 * Uses the official MCP SDK's low-level Server + WebStandardStreamableHTTPServerTransport
 * so that Codex CLI (rmcp) and other 2025-03-26 clients can connect.
 *
 * We use the low-level Server (not McpServer) because our tools use TypeBox
 * JSON Schemas, while McpServer.registerTool expects Zod schemas.
 *
 * Sessions are kept in-memory for active transports and persisted in PostgreSQL
 * so authenticated sessions can recover across restarts and replica hops.
 */

import { randomUUID } from 'node:crypto';
import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Context } from 'hono';
import { bindRequestAbortToStream, type AbortableStream } from './events/sse-abort-bridge';
import { OAuthClientsStore } from './auth/oauth/clients';
import { isPublicReadable } from './auth/tool-access';
import { createDbClientFromEnv } from './db/client';
import type { Env } from './index';
import { agentExistsInOrganization, isValidAgentId, touchAgentLastUsed } from './lobu/stores/postgres-stores';
import { readMcpAppBundle } from './utils/mcp-app-bundle';
import { McpSessionStore, type PersistedMcpSession } from './mcp-session-store';
import {
  clearInMemoryMcpSessionsForTests as clearInMemoryMcpSessionsForTestsShared,
  mcpSessionMap,
} from './mcp-session-state';
import { type AuthContext, executeTool, extractAuthContext } from './tools/execute';
import { getAllTools } from './tools/registry';
import { formatToolResult } from './formatting/markdown-formatter';
import { getConfiguredPublicOrigin } from './utils/public-origin';
import { buildWorkspaceInstructions } from './utils/workspace-instructions';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const SESSION_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  authCtx: AuthContext;
  lastAccessedAt: number;
}

// Typed view over the shared raw Map in `./mcp-session-state` so the test
// cleanup path can clear it without loading the rest of this module.
const sessions = mcpSessionMap as Map<string, SessionEntry>;
const mcpSessionStore = new McpSessionStore();

type SessionAuthContext = AuthContext & { instructions?: string };

// Periodic cleanup of stale IN-MEMORY sessions. This must stay as a per-pod
// setInterval — each pod owns its own `sessions` Map of live MCP transports
// and only it can call `entry.transport.close?.()`. The DB-side cleanup
// (mcpSessionStore.deleteExpiredSessions) is registered as a cross-pod
// scheduler task in scheduled/jobs.ts so it runs once per cluster per tick.
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.lastAccessedAt > SESSION_MAX_AGE_MS) {
      sessions.delete(id);
      entry.transport.close?.();
    }
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();

/** DB-side cleanup of expired MCP sessions. Wired by `registerMaintenanceTasks`. */
export async function cleanupExpiredMcpSessions(): Promise<void> {
  await mcpSessionStore.deleteExpiredSessions();
}

// Re-export the test-only clearer; the actual implementation lives in
// `./mcp-session-state` so callers can clear sessions without statically
// loading this file (and its `@lobu/connector-sdk`-dependent tool registry).
export const clearInMemoryMcpSessionsForTests = clearInMemoryMcpSessionsForTestsShared;

export async function revokeInMemoryMcpSessionsForClient(
  clientId: string,
  organizationId: string
): Promise<string[]> {
  const revokedSessionIds: string[] = [];

  for (const [sessionId, entry] of sessions.entries()) {
    if (entry.authCtx.clientId !== clientId || entry.authCtx.organizationId !== organizationId) {
      continue;
    }

    revokedSessionIds.push(sessionId);
    sessions.delete(sessionId);
    await deletePersistedSession(sessionId);
    entry.transport.close?.();
  }

  return revokedSessionIds;
}

// ---------------------------------------------------------------------------
// Build a low-level Server wired to our tool registry + auth context
// ---------------------------------------------------------------------------

/** Shared mutable ref so handleMcp can signal the format to tool handlers. */
const formatRef = { rawJson: false };

/**
 * MCP Apps UI resources (interactive iframe payloads a host renders in a
 * sandboxed iframe). Keyed by `ui://` uri → the built bundle's app dir under
 * owletto's `dist-mcp-apps/`. Served over `resources/read` + the asset route;
 * our own SPA fetches the one bundle and streams it a `{title, blocks, actions}`
 * view it builds CLIENT-side. (Pointing an external MCP host at a bundle via a
 * tool result's `_meta.ui.resourceUri` needs the SERVER to author that view —
 * a deliberate follow-up, so we don't stamp it today.) Adding an app = one
 * entry + its owletto `src/mcp-apps/<dir>` build — no gateway change.
 */
const MCP_APP_RESOURCES: Record<string, { name: string; appDir: string }> = {
  'ui://lobu/interaction': { name: 'Interaction', appDir: 'interaction' },
};

/**
 * Built MCP App dirs, derived from the registry above. The asset route
 * (`/mcp-apps/:app/index.html`) validates its path param against this set so it
 * only ever serves a registered bundle — an untrusted `:app` can't be used to
 * probe the filesystem.
 */
export const MCP_APP_DIRS: ReadonlySet<string> = new Set(
  Object.values(MCP_APP_RESOURCES).map((r) => r.appDir)
);

function createServerForContext(env: Env, authCtx: SessionAuthContext): Server {
  const server = new Server(
    { name: 'lobu-mcp', version: '0.2.0' },
    {
      capabilities: { tools: {}, resources: {} },
      ...(authCtx.instructions && { instructions: authCtx.instructions }),
    }
  );

  // tools/list — return our TypeBox JSON Schemas
  // Read auth state dynamically so the list updates after auth upgrades.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // System-agent (builder) runs carry a per-turn internal-tool allowlist.
    // Surface exactly those internal tools (and no other), so the model
    // discovers only what the execute gate will actually permit — not every
    // internal tool the direct-auth path would otherwise expose.
    const adminAllowlist = authCtx.adminTools ?? null;
    const hasAdminAllowlist = !!adminAllowlist && adminAllowlist.length > 0;
    const includeInternalTools =
      authCtx.allowInternalTools === true || hasAdminAllowlist;
    const publicOnly = !!authCtx.organizationId && !authCtx.memberRole;
    const roleAccessLevel = !authCtx.memberRole
      ? 'read'
      : authCtx.memberRole === 'owner' || authCtx.memberRole === 'admin'
        ? 'admin'
        : 'write';
    const scopeAccessLevel = !authCtx.scopes
      ? 'admin'
      : authCtx.scopes.includes('mcp:admin')
        ? 'admin'
        : authCtx.scopes.includes('mcp:write')
          ? 'write'
          : 'read';
    const maxAccessLevel =
      roleAccessLevel === 'read' || scopeAccessLevel === 'read'
        ? 'read'
        : roleAccessLevel === 'write' || scopeAccessLevel === 'write'
          ? 'write'
          : 'admin';
    const staticTools = getAllTools({
      includeInternalTools,
      publicOnly,
      maxAccessLevel,
    });
    // On a system-agent run, drop any internal tool outside the allowlist so the
    // listing matches the execute gate (no "Tool not found" surprises). The
    // returned shape omits `internal`, so derive the non-internal set from a
    // second pass with internal tools excluded; a tool is visible if it's
    // non-internal OR explicitly allowlisted.
    let visibleTools = staticTools;
    if (hasAdminAllowlist) {
      const allowed = new Set(adminAllowlist);
      const nonInternal = new Set(
        getAllTools({
          includeInternalTools: false,
          publicOnly,
          maxAccessLevel,
        }).map((t) => t.name)
      );
      visibleTools = staticTools.filter(
        (t) => nonInternal.has(t.name) || allowed.has(t.name)
      );
    }
    const allTools = visibleTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations && { annotations: t.annotations }),
    }));

    return { tools: allTools };
  });

  // resources/list — advertise the MCP App UI resources (interactive iframe
  // surfaces a host renders in place of flat text; see MCP Apps).
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: Object.entries(MCP_APP_RESOURCES).map(([uri, meta]) => ({
      uri,
      name: meta.name,
      mimeType: 'text/html',
    })),
  }));

  // resources/read — return the built bundle HTML for a `ui://` app resource.
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const app = MCP_APP_RESOURCES[uri];
    if (!app) throw new Error(`Unknown resource: ${uri}`);
    const html = await readMcpAppBundle(app.appDir);
    if (html == null) {
      throw new Error(
        `MCP App bundle not built for ${uri} (run owletto build:mcp-apps)`
      );
    }
    return {
      contents: [{ uri, mimeType: 'text/html', text: html }],
    };
  });

  // tools/call — access control + execution + formatting
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Regular tool execution
    try {
      const result = await executeTool(name, args ?? {}, env, authCtx);

      if (authCtx.agentId && authCtx.organizationId) {
        await touchAgentLastUsed(authCtx.organizationId, authCtx.agentId);
      }

      const text = formatRef.rawJson
        ? JSON.stringify(result)
        : formatToolResult(name, result, { includeRawJson: false });
      // NOTE: our own SPA renders interactions (incl. the pending agent-change
      // approval) through the `ui://lobu/interaction` MCP App, but it builds the
      // `{title, blocks, actions}` view CLIENT-side from the SSE card payload —
      // it does not consume this tool result's `_meta`. Rendering for EXTERNAL
      // MCP hosts (Slack/Claude) needs the SERVER to author that view and stamp
      // it here; that is a deliberate follow-up. Until then we return plain text
      // rather than pointing an external host at a bundle it can't feed.
      return { content: [{ type: 'text' as const, text }] };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: error.message ?? 'Tool execution failed' }],
        isError: true,
      };
    }
  });

  return server;
}

function getProtectedResourceUrl(req: Request): string {
  const baseUrl = getConfiguredPublicOrigin() ?? new URL(req.url).origin;
  return `${baseUrl}/.well-known/oauth-protected-resource`;
}

function buildUnauthorizedResponse(req: Request, description: string): Response {
  return new Response(
    JSON.stringify({
      error: 'unauthorized',
      error_description: description,
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="${getProtectedResourceUrl(req)}"`,
      },
    }
  );
}

async function readToolCall(
  req: Request
): Promise<{ name: string; args: Record<string, unknown> } | null> {
  try {
    const body = await req.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    const toolCall = messages.find((m: any) => m?.method === 'tools/call');
    if (!toolCall || typeof toolCall?.params?.name !== 'string') return null;
    return {
      name: toolCall.params.name,
      args:
        toolCall.params.arguments && typeof toolCall.params.arguments === 'object'
          ? toolCall.params.arguments
          : {},
    };
  } catch {
    return null;
  }
}

async function readInitializeRequest(req: Request): Promise<{
  id: string | number | null;
  requestedAgentId: string | null;
  clientInfo: Record<string, unknown> | null;
  capabilities: Record<string, unknown> | null;
} | null> {
  const headerAgentId = req.headers.get('x-lobu-agent-id')?.trim() || null;
  try {
    const body = await req.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    const initialize = messages.find((m: any) => m?.method === 'initialize');
    if (!initialize) {
      return headerAgentId
        ? {
            id: null,
            requestedAgentId: headerAgentId,
            clientInfo: null,
            capabilities: null,
          }
        : null;
    }

    const clientInfo =
      initialize?.params?.clientInfo && typeof initialize.params.clientInfo === 'object'
        ? initialize.params.clientInfo
        : null;
    const capabilities =
      initialize?.params?.capabilities && typeof initialize.params.capabilities === 'object'
        ? initialize.params.capabilities
        : null;
    const bodyAgentId =
      (typeof clientInfo?.agentId === 'string' && clientInfo.agentId.trim()) ||
      (typeof clientInfo?.metadata?.agentId === 'string' && clientInfo.metadata.agentId.trim()) ||
      null;

    return {
      id: initialize.id ?? null,
      requestedAgentId: headerAgentId ?? bodyAgentId,
      clientInfo,
      capabilities,
    };
  } catch {
    return headerAgentId
      ? {
          id: null,
          requestedAgentId: headerAgentId,
          clientInfo: null,
          capabilities: null,
        }
      : null;
  }
}

function buildPersistedSession(
  sessionId: string,
  authCtx: SessionAuthContext,
  lastAccessedAt: number = Date.now()
): PersistedMcpSession {
  return {
    sessionId,
    userId: authCtx.userId,
    // `mcp_sessions.client_id` references oauth_clients(id). PAT sessions are
    // authenticated, but their synthetic `pat_<id>` client id has no oauth row.
    clientId: authCtx.tokenType === 'oauth' ? authCtx.clientId : null,
    organizationId: authCtx.organizationId,
    memberRole: authCtx.memberRole,
    requestedAgentId: authCtx.requestedAgentId,
    isAuthenticated: authCtx.isAuthenticated,
    scopedToOrg: authCtx.scopedToOrg,
    lastAccessedAt,
    expiresAt: lastAccessedAt + SESSION_MAX_AGE_MS,
  };
}

async function persistSessionState(
  sessionId: string | null | undefined,
  authCtx: SessionAuthContext,
  lastAccessedAt: number = Date.now()
): Promise<void> {
  if (!sessionId) return;
  await mcpSessionStore.upsertSession(buildPersistedSession(sessionId, authCtx, lastAccessedAt));
}

async function deletePersistedSession(sessionId: string | null | undefined): Promise<void> {
  if (!sessionId) return;
  await mcpSessionStore.deleteSession(sessionId);
}

async function resolveMembershipRole(
  env: Env,
  organizationId: string | null,
  userId: string | null
): Promise<string | null> {
  if (!organizationId || !userId) return null;
  const sql = createDbClientFromEnv(env);
  const rows = await sql`
    SELECT role
    FROM "member"
    WHERE "organizationId" = ${organizationId}
      AND "userId" = ${userId}
    LIMIT 1
  `;
  return rows.length > 0 ? ((rows[0].role as string) ?? null) : null;
}

async function recoverSessionAuthContext(
  c: Context<{ Bindings: Env }>,
  sessionId: string
): Promise<SessionAuthContext | null> {
  const persisted = await mcpSessionStore.getSession(sessionId);
  if (!persisted) return null;

  const authCtx = await resolveAuthWithInstructions(c);

  if (persisted.isAuthenticated) {
    if (!authCtx.isAuthenticated) return null;
    if (persisted.userId && persisted.userId !== authCtx.userId) return null;
    if (persisted.clientId && persisted.clientId !== authCtx.clientId) return null;
  }

  if (persisted.scopedToOrg !== authCtx.scopedToOrg) {
    return null;
  }

  if (persisted.scopedToOrg) {
    if (authCtx.organizationId !== persisted.organizationId) {
      return null;
    }
  } else {
    authCtx.organizationId = persisted.organizationId;
    authCtx.memberRole = await resolveMembershipRole(
      c.env,
      persisted.organizationId,
      authCtx.userId
    );

    if (persisted.isAuthenticated && persisted.organizationId && !authCtx.memberRole) {
      return null;
    }
  }

  authCtx.requestedAgentId = persisted.requestedAgentId;
  authCtx.instructions = authCtx.organizationId
    ? ((await buildWorkspaceInstructions(authCtx.organizationId)) ?? undefined)
    : undefined;

  const bindingError = await syncAgentBinding(authCtx);
  if (bindingError) {
    return null;
  }

  return authCtx;
}

async function recordMcpClientActivity(
  env: Env,
  authCtx: AuthContext,
  req: Request,
  initialize?: {
    clientInfo: Record<string, unknown> | null;
    capabilities: Record<string, unknown> | null;
  } | null
): Promise<void> {
  if (!authCtx.clientId || authCtx.tokenType !== 'oauth') return;

  const sql = createDbClientFromEnv(env);
  const clientsStore = new OAuthClientsStore(sql);

  await clientsStore.touchClientActivity({
    clientId: authCtx.clientId,
    organizationId: authCtx.organizationId,
    userId: authCtx.userId,
    agentId: authCtx.agentId,
    userAgent: req.headers.get('user-agent'),
    clientInfo: initialize?.clientInfo ?? null,
    capabilities: initialize?.capabilities ?? null,
  });
}

function buildJsonRpcErrorResponse(
  message: string,
  id: string | number | null,
  status: number = 400
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id,
    }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

// ---------------------------------------------------------------------------
// Accept header handling
// ---------------------------------------------------------------------------

const FULL_MCP_ACCEPT = 'application/json, text/event-stream';

// Check whether the original client accepts SSE responses.
function clientAcceptsSSE(req: Request): boolean {
  const accept = req.headers.get('accept') ?? '';
  return accept.includes('text/event-stream');
}

// The SDK transport requires both application/json and text/event-stream in
// Accept. Normalize so clients that omit SSE aren't rejected with 406.
function normalizeAcceptHeader(req: Request): Request {
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('text/event-stream') && accept.includes('application/json')) {
    return req;
  }
  const headers = new Headers(req.headers);
  headers.set('accept', FULL_MCP_ACCEPT);
  return new Request(req.url, {
    method: req.method,
    headers,
    body: req.body,
    duplex: 'half',
  });
}

// Convert an SSE response to plain JSON for clients that don't accept SSE.
// Extracts the last `data:` payload from the event stream.
async function sseToJson(response: Response): Promise<Response> {
  const body = await response.text();
  const lines = body.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('data:')) {
      const json = line.slice(5).trim();
      // Carry over all headers except content-type and content-length
      const headers = new Headers(response.headers);
      headers.set('content-type', 'application/json');
      headers.delete('content-length');
      return new Response(json, { status: response.status, headers });
    }
  }
  return response;
}

// -----------------------------------------------------------------------------
// SSE heartbeat - keeps the GET stream alive through proxies/load balancers
// that would otherwise close idle connections (e.g. Traefik default 5 s).
// -----------------------------------------------------------------------------
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export function withSSEHeartbeat(response: Response, signal?: AbortSignal): Response {
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    return response;
  }
  if (signal?.aborted) {
    response.body.cancel().catch(() => undefined);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      { status: response.status, headers: response.headers }
    );
  }
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const heartbeat = new TextEncoder().encode(': ping\n\n');

  // The heartbeat, the pipe, the source close handler, the pipe error
  // handler, AND the per-request AbortSignal can all race to terminate the
  // writer. Once it transitions closed/aborted any further close()/abort()
  // throws "Invalid state" (Sentry: LOBU-30). Latch on the first terminal
  // call.
  let terminated = false;
  let intervalId: NodeJS.Timeout | undefined;
  const closeWriter = () => {
    if (terminated) return;
    terminated = true;
    if (intervalId) clearInterval(intervalId);
    writer.close().catch(() => undefined);
  };
  const abortWriter = (reason: unknown) => {
    if (terminated) return;
    terminated = true;
    if (intervalId) clearInterval(intervalId);
    writer.abort(reason).catch(() => undefined);
  };

  // Bridge the per-request AbortSignal so abnormal disconnects (LB idle
  // timeout, proxy kill, client hard-close) actually clear the heartbeat
  // interval. The pre-existing close/error path on the source pipe only
  // catches normal pipe-through closure — same root cause as #833/#845.
  // Reuse the central abort-bridge so the pattern doesn't drift.
  const adapter: AbortableStream = {
    get aborted() {
      return terminated;
    },
    get closed() {
      return terminated;
    },
    abort() {
      abortWriter(new Error('Request aborted'));
    },
  };
  // Create the interval BEFORE binding the abort signal so that a pre-aborted
  // signal triggers abortWriter() → clearInterval(intervalId) instead of
  // leaving the timer running forever (codex audit, follow-up to #864).
  intervalId = setInterval(() => {
    writer.write(heartbeat).catch(() => abortWriter(new Error('SSE heartbeat write failed')));
  }, SSE_HEARTBEAT_INTERVAL_MS);

  const detachAbortBridge = bindRequestAbortToStream(signal, adapter);

  response.body
    .pipeTo(
      new WritableStream({
        write(chunk) {
          return writer.write(chunk);
        },
        close() {
          detachAbortBridge();
          closeWriter();
        },
        abort(reason) {
          detachAbortBridge();
          abortWriter(reason);
        },
      })
    )
    .catch(() => {
      detachAbortBridge();
      abortWriter(new Error('Source SSE stream error'));
    });

  return new Response(readable, { status: response.status, headers: response.headers });
}

// Wrap transport.handleRequest: if the client didn't ask for SSE, convert the
// SSE response back to plain JSON so simple clients get what they expect.
async function handleAndMaybeConvert(
  transport: WebStandardStreamableHTTPServerTransport,
  req: Request,
  wantsSSE: boolean
): Promise<Response> {
  const response = await transport.handleRequest(req);
  if (!wantsSSE && response.headers.get('content-type')?.includes('text/event-stream')) {
    return sseToJson(response);
  }
  // Inject SSE heartbeat pings to keep the stream alive through proxies.
  // Thread the inbound request's AbortSignal so abnormal disconnects clear
  // the interval (same root cause as PR #833/#845).
  return withSSEHeartbeat(response, req.signal);
}

// ---------------------------------------------------------------------------
// Session bootstrapping helpers
// ---------------------------------------------------------------------------

async function resolveAuthWithInstructions(
  c: Context<{ Bindings: Env }>,
  req?: Request
): Promise<AuthContext & { instructions?: string }> {
  const authCtx: AuthContext & { instructions?: string } = extractAuthContext(c);
  if (req) {
    const initialize = await readInitializeRequest(req);
    authCtx.requestedAgentId = initialize?.requestedAgentId ?? null;
  }
  if (authCtx.organizationId) {
    authCtx.instructions = (await buildWorkspaceInstructions(authCtx.organizationId)) ?? undefined;
  }
  return authCtx;
}

async function syncAgentBinding(
  authCtx: AuthContext & { instructions?: string }
): Promise<string | null> {
  const requestedAgentId = authCtx.requestedAgentId?.trim() || null;
  authCtx.agentId = null;

  if (!requestedAgentId) return null;
  if (!isValidAgentId(requestedAgentId)) {
    return 'agentId must be 3-60 lowercase alphanumeric chars with hyphens, starting with a letter';
  }
  if (!authCtx.isAuthenticated) {
    return 'Authentication required to bind MCP sessions to an agent.';
  }
  if (!authCtx.organizationId) {
    return null;
  }

  const exists = await agentExistsInOrganization(authCtx.organizationId, requestedAgentId);
  if (!exists) {
    return `Agent '${requestedAgentId}' was not found in the current organization.`;
  }

  authCtx.agentId = requestedAgentId;
  await touchAgentLastUsed(authCtx.organizationId, requestedAgentId);
  return null;
}

function createSessionTransport(
  env: Env,
  authCtx: SessionAuthContext,
  sessionIdGenerator: () => string
): { transport: WebStandardStreamableHTTPServerTransport; server: Server } {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator,
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, server, authCtx, lastAccessedAt: Date.now() });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
      void deletePersistedSession(transport.sessionId);
    }
  };
  const server = createServerForContext(env, authCtx);
  return { transport, server };
}

async function initializeRecoveredSession(
  transport: WebStandardStreamableHTTPServerTransport,
  sessionId: string,
  url: string
): Promise<void> {
  const initReq = new Request(url, {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', accept: FULL_MCP_ACCEPT }),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'session-recovery', version: '1.0' },
      },
      id: '__recovery_init__',
    }),
  });
  await transport.handleRequest(initReq);

  const notifyReq = new Request(url, {
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/json',
      accept: FULL_MCP_ACCEPT,
      'mcp-session-id': sessionId,
    }),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  await transport.handleRequest(notifyReq);
}

// ---------------------------------------------------------------------------
// Hono route handler – delegates to the SDK transport
// ---------------------------------------------------------------------------

export async function handleMcp(c: Context<{ Bindings: Env }>): Promise<Response> {
  const wantsSSE = clientAcceptsSSE(c.req.raw);
  const req = normalizeAcceptHeader(c.req.raw);
  const sessionId = req.headers.get('mcp-session-id') ?? undefined;
  formatRef.rawJson = req.headers.get('x-mcp-format')?.toLowerCase() === 'json';

  // Existing session → reuse
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.lastAccessedAt = Date.now();

    const clearSession = () => {
      sessions.delete(sessionId);
      void deletePersistedSession(sessionId);
    };

    // Refresh authenticated session context on every request so role changes,
    // scope changes, and auth upgrades are reflected immediately.
    if (c.var.mcpIsAuthenticated) {
      const freshCtx = extractAuthContext(c);

      if (session.authCtx.isAuthenticated) {
        if (session.authCtx.userId && freshCtx.userId !== session.authCtx.userId) {
          clearSession();
          return buildJsonRpcErrorResponse(
            'Session authentication changed. Re-initialize.',
            null,
            400
          );
        }
        if (session.authCtx.clientId && freshCtx.clientId !== session.authCtx.clientId) {
          clearSession();
          return buildJsonRpcErrorResponse('Session client changed. Re-initialize.', null, 400);
        }
      }

      session.authCtx.isAuthenticated = true;
      session.authCtx.userId = freshCtx.userId;
      session.authCtx.clientId = freshCtx.clientId;
      // `extractAuthContext` always yields a concrete scope array (real scopes
      // for token callers, the not-applicable sentinel for session/anonymous).
      // Assign it straight through — `hasRequiredMcpScope` fails closed on
      // null, so coercing to null would wrongly deny a valid refreshed session.
      session.authCtx.scopes = freshCtx.scopes;
      // Identity belongs to the MCP session, but worker-originated source
      // conversation is per request. The gateway may reuse the same upstream
      // MCP session across turns for the same user/agent, so keep the mutable
      // auth context current before tools read ToolContext.sourceContext.
      session.authCtx.sourceContext = freshCtx.sourceContext ?? null;
      session.authCtx.adminTools = freshCtx.adminTools ?? null;

      if (session.authCtx.scopedToOrg) {
        if (freshCtx.organizationId !== session.authCtx.organizationId) {
          clearSession();
          return buildJsonRpcErrorResponse(
            'Session organization changed. Re-initialize.',
            null,
            400
          );
        }
        session.authCtx.memberRole = freshCtx.memberRole;
        session.authCtx.instructions = freshCtx.organizationId
          ? ((await buildWorkspaceInstructions(freshCtx.organizationId)) ?? undefined)
          : undefined;
      } else if (session.authCtx.organizationId && freshCtx.userId) {
        session.authCtx.memberRole = await resolveMembershipRole(
          c.env,
          session.authCtx.organizationId,
          freshCtx.userId
        );
        if (!session.authCtx.memberRole) {
          clearSession();
          return buildJsonRpcErrorResponse(
            'Your organization access changed. Re-initialize the session.',
            null,
            400
          );
        }
      }
    }

    await recordMcpClientActivity(c.env, session.authCtx, req);
    await persistSessionState(sessionId, session.authCtx, session.lastAccessedAt);

    // Anonymous root /mcp session: any follow-up GET or tool call must upgrade to auth.
    if (!session.authCtx.organizationId && !session.authCtx.isAuthenticated) {
      const toolCall = req.method === 'POST' ? await readToolCall(req) : null;
      if (req.method === 'GET' || toolCall) {
        clearSession();
        return buildUnauthorizedResponse(
          req,
          req.method === 'GET'
            ? 'Authentication required for MCP stream access.'
            : 'Authentication required for tool calls.'
        );
      }
    }

    // Anonymous public-org session: public reads are allowed, non-public calls must upgrade.
    if (
      session.authCtx.organizationId &&
      !session.authCtx.isAuthenticated &&
      !session.authCtx.memberRole &&
      req.method === 'POST'
    ) {
      const toolCall = await readToolCall(req);
      if (toolCall && !isPublicReadable(toolCall.name, toolCall.args)) {
        clearSession();
        return buildUnauthorizedResponse(req, 'Authentication required for this tool.');
      }
    }

    return handleAndMaybeConvert(session.transport, req, wantsSSE);
  }

  // Stale session ID with non-initialize request → require a fresh initialize.
  if (sessionId && !sessions.has(sessionId) && req.method === 'POST') {
    try {
      const body = await req.clone().json();
      const messages = Array.isArray(body) ? body : [body];
      const isInitialize = messages.some((m: any) => m.method === 'initialize');
      if (!isInitialize) {
        // Recover ONLY from a persisted, server-issued session row — e.g. a
        // cross-replica hop or pod restart within the TTL, where `getSession`
        // proves the id was genuinely issued and is still valid. We deliberately
        // do NOT re-mint a session from request auth alone for an id with no
        // persisted record: that would accept (and persist a row under) any
        // caller-supplied session id. Per the MCP Streamable HTTP spec, an
        // unknown/expired session must instead yield 404 so the client starts a
        // fresh session via `initialize` with a new server-generated id.
        const recoveredAuthCtx = await recoverSessionAuthContext(c, sessionId);
        if (recoveredAuthCtx) {
          const { transport, server } = createSessionTransport(
            c.env,
            recoveredAuthCtx,
            () => sessionId
          );
          await server.connect(transport);
          await initializeRecoveredSession(transport, sessionId, req.url);
          await persistSessionState(sessionId, recoveredAuthCtx);
          await recordMcpClientActivity(c.env, recoveredAuthCtx, req);
          return handleAndMaybeConvert(transport, req, wantsSSE);
        }

        await deletePersistedSession(sessionId);
        return buildJsonRpcErrorResponse(
          'MCP session expired or not recognized. Start a new session by sending an initialize request — spec-compliant clients re-initialize automatically on 404.',
          null,
          404
        );
      }
    } catch {
      // Body parse failure — fall through to create new session
    }
  }

  // New session (initialize request)
  if (req.method === 'POST') {
    const initialize = await readInitializeRequest(req);
    const authCtx = await resolveAuthWithInstructions(c, req);

    // Anonymous on the unscoped `/mcp` endpoint has no workspace context —
    // there's nothing meaningful to serve. Return 401 + WWW-Authenticate so
    // standards-compliant MCP clients (Claude Desktop, etc.) discover the
    // OAuth metadata at /.well-known/oauth-protected-resource and trigger the
    // auth flow. Public workspace browse remains available on /mcp/{slug}.
    if (!authCtx.isAuthenticated && !authCtx.scopedToOrg) {
      return buildUnauthorizedResponse(
        req,
        'Authentication required for the unscoped /mcp endpoint. OAuth via the resource metadata advertised in WWW-Authenticate, or connect to /mcp/{workspace-slug} for public workspace browse.'
      );
    }

    if (
      authCtx.isAuthenticated &&
      authCtx.userId &&
      authCtx.tokenType !== 'session' &&
      authCtx.tokenType !== 'anonymous' &&
      !authCtx.tokenOrganizationId
    ) {
      const reauthOrigin = getConfiguredPublicOrigin() ?? new URL(req.url).origin;
      const remediation =
        authCtx.tokenType === 'pat'
          ? `Reissue this PAT bound to a workspace with \`lobu token create --org <workspace>\` against ${reauthOrigin}.`
          : `Re-authorize the OAuth client and pick a workspace at ${reauthOrigin}/oauth/authorize.`;
      return buildJsonRpcErrorResponse(
        `This token has no organization binding and cannot connect to /mcp. ${remediation}`,
        initialize?.id ?? null,
        400
      );
    }

    const bindingError = await syncAgentBinding(authCtx);
    if (bindingError) {
      return buildJsonRpcErrorResponse(bindingError, initialize?.id ?? null, 400);
    }
    await recordMcpClientActivity(c.env, authCtx, req, initialize);
    const { transport, server } = createSessionTransport(c.env, authCtx, () => randomUUID());
    await server.connect(transport);
    const response = await handleAndMaybeConvert(transport, req, wantsSSE);
    await persistSessionState(transport.sessionId, authCtx);
    return response;
  }

  // GET without a live session (e.g. an SSE reconnect after the session aged
  // out). Mirror the POST stale-session path: 404 + the same actionable message
  // so spec-compliant clients re-initialize rather than treating it as fatal.
  // We don't delete any persisted row here — a within-TTL row stays recoverable
  // by a subsequent POST.
  if (req.method === 'GET') {
    return buildJsonRpcErrorResponse(
      'MCP session expired or not recognized. Start a new session by sending an initialize request — spec-compliant clients re-initialize automatically on 404.',
      null,
      404
    );
  }

  return new Response('Method not allowed', { status: 405 });
}
