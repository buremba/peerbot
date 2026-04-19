import { ApiError } from '../lib/errors.ts';
import { getUsableToken, resolveServerUrl } from '../lib/openclaw-auth.ts';

const JSON_MCP_ACCEPT = 'application/json';

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function getMcpUrlCandidates(rawUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return [rawUrl];
  }

  const candidates = [parsed.toString()];
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') {
    const ipv4 = new URL(parsed.toString());
    ipv4.hostname = '127.0.0.1';
    candidates.push(ipv4.toString());

    const dockerHost = new URL(parsed.toString());
    dockerHost.hostname = 'host.docker.internal';
    candidates.push(dockerHost.toString());
  }

  return uniqueStrings(candidates);
}

function formatNetworkErrorMessage(error: unknown, triedUrls: string[]): string {
  const baseMessage = error instanceof Error ? error.message : String(error);
  return `MCP fetch failed (${baseMessage}). Tried: ${triedUrls.join(', ')}`;
}

async function fetchMcpWithFallback(
  mcpUrl: string,
  init: RequestInit
): Promise<{ response: Response; usedUrl: string }> {
  const candidates = getMcpUrlCandidates(mcpUrl);
  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, init);
      return { response, usedUrl: candidate };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(formatNetworkErrorMessage(lastError, candidates));
}

type JsonRpcError = { message: string; code: number };
type JsonRpcResponse<T = unknown> = {
  result?: T;
  error?: JsonRpcError;
};

/**
 * Resolve the MCP endpoint URL.
 * Priority: explicit config > OWLETTO_URL env > active session server.
 */
export function resolveMcpEndpoint(config?: {
  mcpUrl?: unknown;
  url?: unknown;
  apiUrl?: unknown;
}): string | null {
  // Explicit config should win over ambient auth/session state so callers can
  // deterministically target a specific server.
  if (config) {
    if (typeof config.mcpUrl === 'string' && config.mcpUrl.trim().length > 0) {
      return config.mcpUrl;
    }
    if (typeof config.url === 'string' && config.url.trim().length > 0) {
      const url = config.url as string;
      return url.includes('/mcp') ? url : `${url.replace(/\/+$/, '')}/mcp`;
    }
    if (typeof config.apiUrl === 'string' && config.apiUrl.trim().length > 0) {
      return `${(config.apiUrl as string).replace(/\/+$/, '')}/mcp`;
    }
  }

  // Fall back to auth store / env when no explicit target was provided.
  return resolveServerUrl();
}

async function mcpFetch(
  mcpUrl: string,
  body: Record<string, unknown>,
  sessionId?: string
): Promise<{ data: JsonRpcResponse; usedUrl: string; response: Response }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const tokenResult = await getUsableToken(mcpUrl);
  if (tokenResult) {
    headers.Authorization = `Bearer ${tokenResult.token}`;
  }
  headers.Accept = JSON_MCP_ACCEPT;
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  const { response: res, usedUrl } = await fetchMcpWithFallback(mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new ApiError(
      `MCP request failed via ${usedUrl}: ${res.status} ${res.statusText}`,
      res.status
    );
  }

  const raw = await res.text();
  const data = raw.length > 0 ? (JSON.parse(raw) as JsonRpcResponse) : {};
  return { data, usedUrl, response: res };
}

async function initializeMcpSession(
  mcpUrl: string
): Promise<{ sessionId: string; usedUrl: string }> {
  const { data, usedUrl, response } = await mcpFetch(mcpUrl, {
    jsonrpc: '2.0',
    id: '__init__',
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'owletto-cli', version: '1.0.0' },
    },
  });

  if (data.error) {
    throw new ApiError(`MCP error: ${data.error.message} (code ${data.error.code})`);
  }

  const sessionId = response.headers.get('mcp-session-id');
  if (!sessionId) {
    throw new ApiError(`MCP initialize via ${usedUrl} did not return an mcp-session-id header`);
  }

  await mcpFetch(
    mcpUrl,
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    },
    sessionId
  );

  return { sessionId, usedUrl };
}

export async function mcpRpc(mcpUrl: string, method: string, params?: Record<string, unknown>) {
  const { sessionId } = await initializeMcpSession(mcpUrl);
  const { data } = await mcpFetch(
    mcpUrl,
    {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: params || {},
    },
    sessionId
  );

  if (data.error) {
    throw new ApiError(`MCP error: ${data.error.message} (code ${data.error.code})`);
  }

  return data.result;
}
