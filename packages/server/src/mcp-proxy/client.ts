/**
 * MCP Proxy Client
 *
 * Manages sessions and JSON-RPC communication with upstream MCP servers.
 * Sessions are stored in-memory (per-connection, not serializable).
 * Tool discovery cache is stored in-process with a short TTL.
 */

import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import { isReservedIp, stripIpv6Brackets } from '../gateway/proxy/ssrf-guard';
import { errorMessage } from '../utils/errors';
import logger from '../utils/logger';
import { TtlCache } from '../utils/ttl-cache';
import {
  type ResolvedCredentials,
  resolveCredentials,
  resolveCredentialsByConnectionId,
} from './credential-resolver';
import type { DiscoveredTool, JsonRpcResponse, McpProxyConfig } from './types';

const FETCH_TIMEOUT_INIT_MS = 10_000;
const FETCH_TIMEOUT_TOOL_MS = 30_000;
const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * In-memory session store. Execution sessions include connectionId so two
 * accounts on the same connector never reuse each other's authenticated MCP
 * session. Discovery sessions use the connector-wide key.
 */
type McpSessionState = { sessionId: string; protocolVersion: string };
const sessions = new TtlCache<McpSessionState>(SESSION_TTL_MS);

/**
 * The upstream rejected the request because it does not recognize our session
 * id (MCP Streamable HTTP: an unknown/expired session MUST get a 404). The
 * upstream never reached the tool, so replaying after a fresh handshake cannot
 * double-execute an action — unlike a timeout or a 5xx, which stay fatal.
 */
class McpSessionExpiredError extends Error {}

function sessionKey(orgId: string, connectorKey: string, connectionId?: number): string {
  return connectionId === undefined
    ? `${orgId}:${connectorKey}`
    : `${orgId}:${connectorKey}:connection:${connectionId}`;
}

// ---------------------------------------------------------------------------
const toolCache = new TtlCache<DiscoveredTool[]>(TOOL_CACHE_TTL_MS);

// ---------------------------------------------------------------------------
// Upstream communication
// ---------------------------------------------------------------------------

/**
 * Build headers for an upstream MCP request.
 */
function buildHeaders(
  credentials: ResolvedCredentials | null,
  session: McpSessionState | null
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (session) {
    headers['Mcp-Session-Id'] = session.sessionId;
    headers['MCP-Protocol-Version'] = session.protocolVersion;
  }

  if (credentials?.accessToken) {
    headers.Authorization = `${credentials.tokenType || 'Bearer'} ${credentials.accessToken}`;
  }

  return headers;
}

/**
 * Send a JSON-RPC request to an upstream MCP server.
 * Tracks Mcp-Session-Id from responses.
 */
async function sendRequest(
  upstreamUrl: string,
  credentials: ResolvedCredentials | null,
  orgId: string,
  connectorKey: string,
  body: string,
  timeoutMs: number = FETCH_TIMEOUT_TOOL_MS,
  connectionId?: number
): Promise<JsonRpcResponse> {
  // Re-validate on every outbound fetch — config may have been edited/imported
  // after the creation-time probe, so "validated at write time" is not enough.
  assertSafeUrl(upstreamUrl);
  const key = sessionKey(orgId, connectorKey, connectionId);
  const session = sessions.get(key) ?? null;
  const headers = buildHeaders(credentials, session);

  const response = await fetchWithTimeout(
    upstreamUrl,
    { method: 'POST', headers, body },
    timeoutMs
  );

  // Track session ID from response
  const newSessionId = response.headers.get('Mcp-Session-Id');
  if (newSessionId) {
    sessions.set(key, {
      sessionId: newSessionId,
      protocolVersion: session?.protocolVersion ?? MCP_PROTOCOL_VERSION,
    });
  }

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 404 && session) {
      sessions.delete(key);
      throw new McpSessionExpiredError(`Upstream MCP returned 404: ${text}`);
    }
    throw new Error(`Upstream MCP returned ${response.status}: ${text}`);
  }

  return (await response.json()) as JsonRpcResponse;
}

/**
 * Initialize an MCP session with the upstream server.
 * Sends initialize + notifications/initialized handshake.
 */
async function initializeSession(
  upstreamUrl: string,
  credentials: ResolvedCredentials | null,
  orgId: string,
  connectorKey: string,
  connectionId?: number
): Promise<Record<string, unknown>> {
  // Clear existing session
  const key = sessionKey(orgId, connectorKey, connectionId);
  sessions.delete(key);

  // Send initialize
  const initResponse = await sendRequest(
    upstreamUrl,
    credentials,
    orgId,
    connectorKey,
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'lobu-mcp-proxy', version: '1.0.0' },
      },
      id: 0,
    }),
    FETCH_TIMEOUT_INIT_MS,
    connectionId
  );

  if (initResponse.error) {
    throw new Error(`MCP initialize failed: ${initResponse.error.message}`);
  }

  const protocolVersion = initResponse.result?.protocolVersion;
  if (typeof protocolVersion !== 'string' || protocolVersion.length === 0) {
    throw new Error('MCP initialize response omitted protocolVersion');
  }
  const initializedSession = sessions.get(key);
  if (initializedSession) {
    sessions.set(key, { ...initializedSession, protocolVersion });
  }

  // Send initialized notification
  try {
    await sendRequest(
      upstreamUrl,
      credentials,
      orgId,
      connectorKey,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
      FETCH_TIMEOUT_INIT_MS,
      connectionId
    );
  } catch {
    // Notification delivery is best-effort
  }

  return initResponse.result?.capabilities ?? {};
}

/**
 * Discover tools from an upstream MCP server.
 * Returns tools with the tool_prefix applied to names.
 */
export async function discoverTools(
  connectorKey: string,
  config: McpProxyConfig,
  orgId: string
): Promise<DiscoveredTool[]> {
  // Key the cache by org too — two orgs can each define a connector with the
  // same key but different upstream URLs / tool sets; sharing the cache leaks
  // org A's tool catalog to org B.
  const cacheKey = `${orgId}:${connectorKey}`;
  const cached = toolCache.get(cacheKey) ?? null;
  if (cached) return cached;

  let credentials: ResolvedCredentials | null = null;
  try {
    credentials = await resolveCredentials(orgId, connectorKey);
  } catch (error) {
    logger.warn(
      { connectorKey, error: errorMessage(error) },
      '[McpProxy] Failed to resolve credentials for tool discovery, trying unauthenticated'
    );
  }

  try {
    // Initialize session first
    const capabilities = await initializeSession(
      config.upstream_url,
      credentials,
      orgId,
      connectorKey
    );

    // A server that does not advertise tools is legitimately toolless. Once it
    // advertises the capability, however, tools/list is part of the negotiated
    // contract and discovery failures must fail the install instead of silently
    // persisting a connector with zero operations.
    if (!Object.hasOwn(capabilities, 'tools')) {
      toolCache.set(cacheKey, []);
      return [];
    }

    // Fetch tools/list
    const response = await sendRequest(
      config.upstream_url,
      credentials,
      orgId,
      connectorKey,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
        id: 1,
      }),
      FETCH_TIMEOUT_TOOL_MS
    );

    if (response.error) {
      throw new Error(`MCP tools/list failed: ${response.error.message}`);
    }

    const rawTools = response.result?.tools;
    if (!Array.isArray(rawTools)) {
      throw new Error('MCP tools/list response omitted tools');
    }
    const prefix = config.tool_prefix;

    const tools: DiscoveredTool[] = rawTools.map((t) => ({
      name: `${prefix}__${t.name}`,
      originalName: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      annotations: t.annotations,
      connectorKey,
      upstreamUrl: config.upstream_url,
    }));

    toolCache.set(cacheKey, tools);

    logger.info(
      { connectorKey, toolCount: tools.length, prefix },
      '[McpProxy] Discovered tools from upstream MCP'
    );

    return tools;
  } catch (error) {
    logger.error(
      { connectorKey, url: config.upstream_url, error: errorMessage(error) },
      '[McpProxy] Tool discovery failed'
    );
    if (cached) return cached;
    throw error;
  }
}

/**
 * Call a tool on an upstream MCP server.
 * Handles stale session recovery: reinitialize + retry once.
 */
export async function callTool(
  connectorKey: string,
  config: McpProxyConfig,
  orgId: string,
  originalToolName: string,
  args: Record<string, unknown>,
  connectionId: number
): Promise<{ content: unknown[]; isError: boolean }> {
  const credentials = await resolveCredentialsByConnectionId(connectionId, orgId);

  const key = sessionKey(orgId, connectorKey, connectionId);

  // Establish a session before the action call. A transport failure after a
  // tools/call is ambiguous — the upstream may have executed the action before
  // the response was lost — so it must never be interpreted as permission to
  // initialize and replay a potentially destructive call.
  if (!sessions.get(key)) {
    await initializeSession(
      config.upstream_url,
      credentials,
      orgId,
      connectorKey,
      connectionId
    );
  }

  const jsonRpcBody = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: originalToolName, arguments: args },
    id: 1,
  });

  const send = (): Promise<JsonRpcResponse> =>
    sendRequest(
      config.upstream_url,
      credentials,
      orgId,
      connectorKey,
      jsonRpcBody,
      FETCH_TIMEOUT_TOOL_MS,
      connectionId
    );

  let response: JsonRpcResponse;
  try {
    response = await send();
  } catch (error) {
    // A rejected session id means the call never ran upstream; every other
    // transport failure is ambiguous and must surface rather than replay.
    if (!(error instanceof McpSessionExpiredError)) throw error;
    logger.info({ connectorKey, originalToolName }, '[McpProxy] Session rejected, reinitializing');
    await initializeSession(
      config.upstream_url,
      credentials,
      orgId,
      connectorKey,
      connectionId
    );
    response = await send();
  }

  // Stale session recovery: "not initialized" → reinitialize + retry once
  if (response.error && /not initialized/i.test(response.error.message || '')) {
    logger.info({ connectorKey, originalToolName }, '[McpProxy] Session expired, reinitializing');
    await initializeSession(
      config.upstream_url,
      credentials,
      orgId,
      connectorKey,
      connectionId
    );
    response = await send();
  }

  if (response.error) {
    return {
      content: [{ type: 'text', text: response.error.message || 'Upstream MCP error' }],
      isError: true,
    };
  }

  return {
    content: response.result?.content ?? [],
    isError: response.result?.isError ?? false,
  };
}

/**
 * Validate that a URL is safe for server-side fetching (SSRF prevention).
 *
 * This is a syntactic literal check: the connector_definitions auth_schema
 * upstream URL is operator-supplied (org admin) so the threat model is
 * "stop a misconfigured / malicious upstream literal", not "defeat a
 * resolver that returns an internal address". Workers cannot edit these
 * rows. DNS-rebinding defence for outbound fetches lives in the gateway
 * HTTP egress proxy; this check just rejects the obvious cases at the
 * trust boundary so a private IP in the literal never reaches `fetch`.
 */
export function assertSafeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  // WHATWG URL keeps IPv6 hostnames bracketed (`[::1]`). Strip brackets so the
  // shared guard sees the bare literal.
  const hostname = stripIpv6Brackets(parsed.hostname.toLowerCase());

  // IP literals (in any spelling) go through the canonical SSRF guard — the
  // same `isReservedIp` the gateway egress proxy uses. This closes the gap the
  // previous hand-rolled regex variant left open: NAT64 (`64:ff9b::7f00:1`) and
  // hex-form IPv4-mapped IPv6 (`::ffff:7f00:1`) were not matched here. A value
  // that looks like an IP literal but won't parse fails closed (blocked).
  if (isReservedIp(hostname)) {
    throw new Error(`URL points to a private/internal address: ${hostname}`);
  }

  // Hostname forms the IP guard can't see (these never reach `net.isIP`):
  // bare `localhost` and the `.local` / `.internal` private DNS suffixes.
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error(`URL points to a private/internal address: ${hostname}`);
  }
}

/**
 * Probe a remote MCP server to extract server info and available tools.
 * Uses a temporary session (no stored session or credentials).
 */
export async function probeMcpServer(upstreamUrl: string): Promise<{
  serverInfo: { name: string; version: string };
  instructions?: string;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
}> {
  assertSafeUrl(upstreamUrl);
  let mcpSessionId: string | null = null;
  let protocolVersion: string | null = null;

  const send = async (body: unknown): Promise<JsonRpcResponse> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (mcpSessionId) {
      headers['Mcp-Session-Id'] = mcpSessionId;
      headers['MCP-Protocol-Version'] = protocolVersion ?? MCP_PROTOCOL_VERSION;
    }

    const response = await fetchWithTimeout(
      upstreamUrl,
      { method: 'POST', headers, body: JSON.stringify(body) },
      FETCH_TIMEOUT_INIT_MS
    );

    const newSessionId = response.headers.get('Mcp-Session-Id');
    if (newSessionId) mcpSessionId = newSessionId;

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`MCP server returned ${response.status}: ${text}`);
    }

    return (await response.json()) as JsonRpcResponse;
  };

  // Initialize
  const initResponse = await send({
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'lobu-mcp-proxy', version: '1.0.0' },
    },
    id: 0,
  });

  if (initResponse.error) {
    throw new Error(`MCP initialize failed: ${initResponse.error.message}`);
  }

  if (
    typeof initResponse.result?.protocolVersion !== 'string' ||
    initResponse.result.protocolVersion.length === 0
  ) {
    throw new Error('MCP initialize response omitted protocolVersion');
  }
  protocolVersion = initResponse.result.protocolVersion;

  const serverInfo = initResponse.result?.serverInfo ?? { name: 'unknown', version: '0.0.0' };
  const instructions = initResponse.result?.instructions;

  // Send initialized notification (best-effort)
  try {
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  } catch {
    // best-effort
  }

  const capabilities = initResponse.result?.capabilities ?? {};
  if (!Object.hasOwn(capabilities, 'tools')) {
    return { serverInfo, instructions, tools: [] };
  }

  // An advertised tools capability makes tools/list mandatory.
  const toolsResponse = await send({
    jsonrpc: '2.0',
    method: 'tools/list',
    params: {},
    id: 1,
  });
  if (toolsResponse.error) {
    throw new Error(`MCP tools/list failed: ${toolsResponse.error.message}`);
  }
  const tools = toolsResponse.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error('MCP tools/list response omitted tools');
  }
  const typedTools = tools as Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;

  return { serverInfo, instructions, tools: typedTools };
}
