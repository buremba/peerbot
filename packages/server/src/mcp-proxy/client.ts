/**
 * MCP Proxy Client
 *
 * Manages sessions and JSON-RPC communication with upstream MCP servers.
 * Sessions are stored in-memory (per-connection, not serializable).
 * Tool discovery cache is stored in-process with a short TTL.
 */

import { errorMessage } from '../utils/errors';
import logger from '../utils/logger';
import { TtlCache } from '../utils/ttl-cache';
import { type ResolvedCredentials, resolveCredentials } from './credential-resolver';
import type { DiscoveredTool, JsonRpcResponse, McpProxyConfig } from './types';

const MCP_PROTOCOL_VERSION = '2025-03-26';
const FETCH_TIMEOUT_INIT_MS = 10_000;
const FETCH_TIMEOUT_TOOL_MS = 30_000;
const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * In-memory session store: "orgId:connectorKey" → MCP session ID
 */
const sessions = new Map<string, string>();

function sessionKey(orgId: string, connectorKey: string): string {
  return `${orgId}:${connectorKey}`;
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
  mcpSessionId: string | null
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (mcpSessionId) {
    headers['Mcp-Session-Id'] = mcpSessionId;
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
  timeoutMs: number = FETCH_TIMEOUT_TOOL_MS
): Promise<JsonRpcResponse> {
  const key = sessionKey(orgId, connectorKey);
  const mcpSessionId = sessions.get(key) ?? null;
  const headers = buildHeaders(credentials, mcpSessionId);

  const response = await fetchWithTimeout(
    upstreamUrl,
    { method: 'POST', headers, body },
    timeoutMs
  );

  // Track session ID from response
  const newSessionId = response.headers.get('Mcp-Session-Id');
  if (newSessionId) {
    sessions.set(key, newSessionId);
  }

  if (!response.ok) {
    const text = await response.text();
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
  connectorKey: string
): Promise<void> {
  // Clear existing session
  const key = sessionKey(orgId, connectorKey);
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
        clientInfo: { name: 'owletto-mcp-proxy', version: '1.0.0' },
      },
      id: 0,
    }),
    FETCH_TIMEOUT_INIT_MS
  );

  if (initResponse.error) {
    throw new Error(`MCP initialize failed: ${initResponse.error.message}`);
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
      FETCH_TIMEOUT_INIT_MS
    );
  } catch {
    // Notification delivery is best-effort
  }
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
  const cached = toolCache.get(connectorKey) ?? null;
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
    await initializeSession(config.upstream_url, credentials, orgId, connectorKey);

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
      logger.error({ connectorKey, error: response.error }, '[McpProxy] tools/list returned error');
      return cached ?? [];
    }

    const rawTools = response.result?.tools ?? [];
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

    toolCache.set(connectorKey, tools);

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
    return cached ?? [];
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
  args: Record<string, unknown>
): Promise<{ content: unknown[]; isError: boolean }> {
  const credentials = await resolveCredentials(orgId, connectorKey);

  const jsonRpcBody = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: originalToolName, arguments: args },
    id: 1,
  });

  let response: JsonRpcResponse;
  try {
    response = await sendRequest(
      config.upstream_url,
      credentials,
      orgId,
      connectorKey,
      jsonRpcBody,
      FETCH_TIMEOUT_TOOL_MS
    );
  } catch (_error) {
    // If there's no session yet, initialize and retry
    await initializeSession(config.upstream_url, credentials, orgId, connectorKey);
    response = await sendRequest(
      config.upstream_url,
      credentials,
      orgId,
      connectorKey,
      jsonRpcBody,
      FETCH_TIMEOUT_TOOL_MS
    );
  }

  // Stale session recovery: "not initialized" → reinitialize + retry once
  if (response.error && /not initialized/i.test(response.error.message || '')) {
    logger.info({ connectorKey, originalToolName }, '[McpProxy] Session expired, reinitializing');
    await initializeSession(config.upstream_url, credentials, orgId, connectorKey);
    response = await sendRequest(
      config.upstream_url,
      credentials,
      orgId,
      connectorKey,
      jsonRpcBody,
      FETCH_TIMEOUT_TOOL_MS
    );
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
 */
function assertSafeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname;
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.startsWith('169.254.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
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

  const send = async (body: unknown): Promise<JsonRpcResponse> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (mcpSessionId) headers['Mcp-Session-Id'] = mcpSessionId;

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
      clientInfo: { name: 'owletto-mcp-proxy', version: '1.0.0' },
    },
    id: 0,
  });

  if (initResponse.error) {
    throw new Error(`MCP initialize failed: ${initResponse.error.message}`);
  }

  const serverInfo = initResponse.result?.serverInfo ?? { name: 'unknown', version: '0.0.0' };
  const instructions = initResponse.result?.instructions;

  // Send initialized notification (best-effort)
  try {
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  } catch {
    // best-effort
  }

  // Discover tools
  let tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }> = [];
  try {
    const toolsResponse = await send({
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
      id: 1,
    });
    tools = toolsResponse.result?.tools ?? [];
  } catch {
    // Server may not support tools — that's fine
  }

  return { serverInfo, instructions, tools };
}
