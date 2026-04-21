import {
  type ChildProcess,
  exec as execCallback,
  execSync,
  spawn,
  spawnSync,
} from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { renderFallbackSystemContext } from './owletto-guidance.js';
import type {
  McpToolDefinition,
  McpToolResponse,
  PluginConfig,
  ResolvedPluginConfig,
} from './types.js';

type PluginLogger = {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug?(message: string, ...args: unknown[]): void;
};

const AUTH_REQUIRED_MSG =
  'Lobu memory is not connected. Call the owletto_login tool to authenticate, then show the user the login URL and code. After the user completes login in their browser, call owletto_login_check to finish authentication.';
const DEFAULT_RECALL_LIMIT = 6;

// Minimal fallback context used before the workspace instructions are fetched.
// Initialized lazily per mode (gateway vs standalone) in register().
let FALLBACK_SYSTEM_CONTEXT: string | null = null;

// Workspace instructions fetched from MCP server (includes entity types, event kinds, schemas).
let cachedWorkspaceInstructions: string | null = null;

const DEFAULT_RPC_VERSION = '2.0';
const DEFAULT_MCP_SCOPE = 'mcp:read mcp:write profile:read';
const execAsync = promisify(execCallback);
const PLUGIN_VERSION = (() => {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(dir, '../package.json'), 'utf-8')) as {
      version?: string;
    };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// Session-level token obtained via device code login flow
let sessionToken: string | null = null;
// Session-level refresh token for token renewal
let _sessionRefreshToken: string | null = null;
let sessionClientId: string | null = null;
let sessionClientSecret: string | null = null;
let sessionIssuer: string | null = null;

// MCP Streamable HTTP session ID (obtained from initialize handshake)
let mcpSessionId: string | null = null;

const MCP_PROTOCOL_VERSION = '2025-03-26';

// Make an MCP JSON-RPC request with session management.
// Server returns plain JSON when Accept doesn't include text/event-stream.
async function mcpFetch(
  url: string,
  body: unknown,
  extraHeaders?: Record<string, string>
): Promise<{ data: unknown; response: Response }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extraHeaders,
  };
  if (mcpSessionId) {
    headers['Mcp-Session-Id'] = mcpSessionId;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const newSessionId = response.headers.get('mcp-session-id');
  if (newSessionId) {
    mcpSessionId = newSessionId;
  }

  const data = await response.json();
  return { data, response };
}

// Worker daemon process (auto-started after login)
let workerProcess: ChildProcess | null = null;

// --- Token persistence (compatible with packages/cli/src/lib/openclaw-auth.ts) ---

interface StoredSession {
  mcpUrl: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  accessToken?: string;
  updatedAt: string;
}

interface AuthStore {
  version: 1;
  activeServer?: string;
  activeContext?: string; // legacy
  sessions: Record<string, StoredSession>;
}

function getTokenStorePath(): string {
  return resolve(homedir(), '.owletto', 'openclaw-auth.json');
}

function normalizeMcpUrl(input: string): string {
  const url = new URL(input);
  url.hash = '';
  url.search = '';
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/mcp';
  }
  return url.toString().replace(/\/+$/, '');
}

/** Strip org suffix for session lookup: /mcp/acme → /mcp */
function baseMcpUrl(input: string): string {
  const url = new URL(input);
  url.hash = '';
  url.search = '';
  url.pathname = '/mcp';
  return url.toString().replace(/\/+$/, '');
}

function loadStoredSession(mcpUrl: string): StoredSession | null {
  try {
    const raw = readFileSync(getTokenStorePath(), 'utf-8');
    const store = JSON.parse(raw) as AuthStore;
    if (!store || store.version !== 1 || !store.sessions) return null;
    // Try exact match, then fall back to base /mcp
    const key = normalizeMcpUrl(mcpUrl);
    return store.sessions[key] || store.sessions[baseMcpUrl(mcpUrl)] || null;
  } catch {
    return null;
  }
}

function saveStoredSession(
  mcpUrl: string,
  data: {
    issuer: string;
    clientId: string;
    clientSecret?: string | null;
    refreshToken: string;
    accessToken: string;
  }
): void {
  const storePath = getTokenStorePath();
  let store: AuthStore;
  try {
    const raw = readFileSync(storePath, 'utf-8');
    const parsed = JSON.parse(raw) as AuthStore;
    store = parsed?.version === 1 && parsed.sessions ? parsed : { version: 1, sessions: {} };
  } catch {
    store = { version: 1, sessions: {} };
  }

  const key = normalizeMcpUrl(mcpUrl);
  store.sessions[key] = {
    mcpUrl: key,
    issuer: data.issuer,
    clientId: data.clientId,
    ...(data.clientSecret ? { clientSecret: data.clientSecret } : {}),
    refreshToken: data.refreshToken,
    accessToken: data.accessToken,
    updatedAt: new Date().toISOString(),
  };
  store.activeServer = key;
  // Keep legacy field for backward compat with older CLI versions
  (store as any).activeContext = key;

  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
}

const fallbackLogger: PluginLogger = {
  info: (msg: string) => console.log(`[openclaw-owletto-plugin] INFO: ${msg}`),
  warn: (msg: string) => console.warn(`[openclaw-owletto-plugin] WARN: ${msg}`),
  error: (msg: string) => console.error(`[openclaw-owletto-plugin] ERROR: ${msg}`),
  debug: (msg: string) => console.debug(`[openclaw-owletto-plugin] DEBUG: ${msg}`),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown, defaultValue: boolean): boolean {
  return typeof value === 'boolean' ? value : defaultValue;
}

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n > 0 ? n : fallback;
}

function getLogger(api: Record<string, unknown>): PluginLogger {
  const logger = api.logger;
  if (
    isRecord(logger) &&
    typeof logger.info === 'function' &&
    typeof logger.warn === 'function' &&
    typeof logger.error === 'function'
  ) {
    return logger as unknown as PluginLogger;
  }
  return fallbackLogger;
}

function getHookRegistrar(
  api: Record<string, unknown>
): (
  event: string,
  handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown
) => void {
  const on = api.on;
  if (typeof on === 'function') {
    return on as any;
  }
  return () => {
    /* no-op */
  };
}

function readPluginConfig(api: Record<string, unknown>, pluginId: string): PluginConfig {
  if (isRecord(api.pluginConfig)) {
    return api.pluginConfig as PluginConfig;
  }

  if (!isRecord(api.config)) {
    return {};
  }

  const cfg = api.config as Record<string, unknown>;
  const plugins = isRecord(cfg.plugins) ? (cfg.plugins as Record<string, unknown>) : null;
  const entries =
    plugins && isRecord(plugins.entries) ? (plugins.entries as Record<string, unknown>) : null;
  if (!entries) return {};

  const pluginEntry = entries[pluginId];
  if (!isRecord(pluginEntry)) return {};

  const pluginCfg = pluginEntry.config;
  if (!isRecord(pluginCfg)) return {};

  return pluginCfg as PluginConfig;
}

function resolvePluginConfig(api: Record<string, unknown>, pluginId: string): ResolvedPluginConfig {
  const cfg = readPluginConfig(api, pluginId);

  const mcpUrl = asString(cfg.mcpUrl);
  const webUrl = asString(cfg.webUrl) ?? asString(process.env.OWLETTO_WEB_URL);
  const token = asString(cfg.token) ?? asString(process.env.OWLETTO_MCP_TOKEN);
  const tokenCommand =
    asString(cfg.tokenCommand) ?? asString(process.env.OWLETTO_MCP_TOKEN_COMMAND);
  const gatewayAuthUrl = asString(cfg.gatewayAuthUrl) ?? asString(process.env.GATEWAY_AUTH_URL);

  const headers: Record<string, string> = {};
  if (isRecord(cfg.headers)) {
    for (const [k, v] of Object.entries(cfg.headers)) {
      if (typeof v === 'string' && k.trim().length > 0) {
        headers[k] = v;
      }
    }
  }

  return {
    mcpUrl,
    webUrl,
    token,
    tokenCommand,
    gatewayAuthUrl,
    headers,
    autoRecall: asBoolean(cfg.autoRecall, true),
    autoCapture: asBoolean(cfg.autoCapture, true),
    recallLimit: asPositiveInt(cfg.recallLimit, DEFAULT_RECALL_LIMIT),
  };
}

function isAuthErrorMessage(message: string): boolean {
  return /invalid.token|expired|unauthorized|authentication|forbidden/i.test(message);
}

function parseErrorMessage(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (isRecord(payload)) {
    if (typeof payload.message === 'string') return payload.message;
    if (typeof payload.error === 'string') return payload.error;
    if (isRecord(payload.error) && typeof payload.error.message === 'string') {
      return payload.error.message;
    }
  }
  return 'Unknown MCP error';
}

class OwlettoAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwlettoAuthError';
  }
}

async function resolveAuthToken(config: ResolvedPluginConfig): Promise<string | null> {
  // In gateway mode, use worker token to authenticate with the MCP proxy
  if (config.gatewayAuthUrl) return getWorkerToken();

  if (sessionToken) return sessionToken;
  if (config.token) return config.token;
  if (!config.tokenCommand) return null;

  const { stdout } = await execAsync(config.tokenCommand, {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const token = stdout.trim();
  if (!token) {
    throw new Error('tokenCommand returned empty output');
  }
  return token;
}

function hasAuthConfigured(config: ResolvedPluginConfig): boolean {
  // In gateway mode, always return true — the proxy manages credentials
  // and handles auth errors automatically via device-code flow.
  if (config.gatewayAuthUrl) return true;

  return !!(sessionToken || config.token || config.tokenCommand);
}

function getWorkerToken(): string | null {
  return asString(process.env.WORKER_TOKEN);
}

async function gatewayDeviceAuthStart(gatewayAuthUrl: string): Promise<{
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
}> {
  const workerToken = getWorkerToken();
  if (!workerToken) throw new Error('WORKER_TOKEN not set');

  const response = await fetch(`${gatewayAuthUrl}/internal/device-auth/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${workerToken}`,
    },
    body: JSON.stringify({ mcpId: 'owletto' }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gateway device auth start failed: ${errText}`);
  }

  return (await response.json()) as {
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresIn: number;
  };
}

async function gatewayDeviceAuthPoll(
  gatewayAuthUrl: string
): Promise<{ status: string; message?: string }> {
  const workerToken = getWorkerToken();
  if (!workerToken) throw new Error('WORKER_TOKEN not set');

  const response = await fetch(`${gatewayAuthUrl}/internal/device-auth/poll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${workerToken}`,
    },
    body: JSON.stringify({ mcpId: 'owletto' }),
  });

  return (await response.json()) as { status: string; message?: string };
}

async function gatewayDeviceAuthCheck(gatewayAuthUrl: string): Promise<boolean> {
  const workerToken = getWorkerToken();
  if (!workerToken) return false;

  try {
    const response = await fetch(`${gatewayAuthUrl}/internal/device-auth/status?mcpId=owletto`, {
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { authenticated: boolean };
    return !!data.authenticated;
  } catch {
    return false;
  }
}

function clearSessionTokens(): void {
  sessionToken = null;
  _sessionRefreshToken = null;
}

function deriveOAuthBaseUrl(mcpUrl: string): string {
  const base = new URL(mcpUrl);
  base.pathname = '/';
  base.search = '';
  base.hash = '';
  return base.toString().replace(/\/$/, '');
}

function spawnWorkerDaemon(mcpUrl: string, accessToken: string, log: PluginLogger): void {
  if (workerProcess) {
    // Already running — check if the process is still alive
    if (workerProcess.exitCode === null && !workerProcess.killed) {
      log.info('owletto: worker daemon already running');
      return;
    }
    workerProcess = null;
  }

  const apiUrl = deriveOAuthBaseUrl(mcpUrl);

  try {
    workerProcess = spawn('npx', ['owletto-worker', 'daemon', '--api-url', apiUrl], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, WORKER_API_TOKEN: accessToken },
    });

    workerProcess.unref();

    log.info(`owletto: worker daemon spawned (pid=${workerProcess.pid})`);

    // Clean up on process exit
    const cleanup = () => {
      if (workerProcess && workerProcess.exitCode === null && !workerProcess.killed) {
        try {
          workerProcess.kill();
        } catch {
          // Best-effort cleanup
        }
      }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  } catch (err) {
    log.warn(
      `owletto: failed to spawn worker daemon: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

type DeviceLoginState = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
  clientId: string;
  clientSecret?: string;
  issuer: string;
};

async function initiateDeviceLogin(
  mcpUrl: string,
  scope: string,
  resource: string | null
): Promise<DeviceLoginState> {
  const issuer = deriveOAuthBaseUrl(mcpUrl);

  // Step 1: Dynamic client registration
  const regResponse = await fetch(`${issuer}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      client_name: 'OpenClaw Owletto Plugin',
      software_id: 'openclaw',
      software_version: PLUGIN_VERSION,
      scope,
    }),
  });

  if (!regResponse.ok) {
    const errText = await regResponse.text();
    throw new Error(`Client registration failed: ${errText}`);
  }

  const registration = (await regResponse.json()) as {
    client_id: string;
    client_secret?: string;
  };

  // Step 2: Request device authorization
  const deviceResponse = await fetch(`${issuer}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: registration.client_id,
      scope,
      resource,
    }),
  });

  if (!deviceResponse.ok) {
    const errText = await deviceResponse.text();
    throw new Error(`Device authorization failed: ${errText}`);
  }

  const deviceAuth = (await deviceResponse.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };

  return {
    deviceCode: deviceAuth.device_code,
    userCode: deviceAuth.user_code,
    verificationUri: deviceAuth.verification_uri,
    verificationUriComplete: deviceAuth.verification_uri_complete,
    expiresIn: deviceAuth.expires_in,
    interval: deviceAuth.interval,
    clientId: registration.client_id,
    clientSecret: registration.client_secret,
    issuer,
  };
}

async function pollDeviceLogin(
  state: DeviceLoginState
): Promise<
  | { status: 'pending'; message: string }
  | { status: 'complete'; accessToken: string; refreshToken?: string }
  | { status: 'error'; message: string }
> {
  const body: Record<string, string> = {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: state.clientId,
    device_code: state.deviceCode,
  };
  if (state.clientSecret) {
    body.client_secret = state.clientSecret;
  }

  const tokenResponse = await fetch(`${state.issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = (await tokenResponse.json()) as Record<string, unknown>;

  if (tokenResponse.ok && typeof data.access_token === 'string') {
    return {
      status: 'complete',
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    };
  }

  const error = typeof data.error === 'string' ? data.error : '';

  if (error === 'authorization_pending') {
    return { status: 'pending', message: 'Waiting for user to approve in browser...' };
  }

  if (error === 'slow_down') {
    return { status: 'pending', message: 'Polling too fast, slowing down...' };
  }

  if (error === 'expired_token') {
    return { status: 'error', message: 'Device code expired. Please start login again.' };
  }

  if (error === 'access_denied') {
    return { status: 'error', message: 'User denied the authorization request.' };
  }

  const desc = typeof data.error_description === 'string' ? data.error_description : error;
  return { status: 'error', message: desc || 'Unknown error during login' };
}

async function tryRefreshToken(mcpUrl: string): Promise<boolean> {
  if (!_sessionRefreshToken || !sessionClientId || !sessionIssuer) return false;

  try {
    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      client_id: sessionClientId,
      refresh_token: _sessionRefreshToken,
    };
    if (sessionClientSecret) {
      body.client_secret = sessionClientSecret;
    }

    const response = await fetch(`${sessionIssuer}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) return false;

    const data = (await response.json()) as Record<string, unknown>;
    if (typeof data.access_token !== 'string') return false;

    sessionToken = data.access_token;
    if (typeof data.refresh_token === 'string') {
      _sessionRefreshToken = data.refresh_token;
    }

    // Persist refreshed tokens
    try {
      saveStoredSession(mcpUrl, {
        issuer: sessionIssuer,
        clientId: sessionClientId,
        clientSecret: sessionClientSecret,
        refreshToken: _sessionRefreshToken!,
        accessToken: sessionToken,
      });
    } catch {
      // Best-effort persist
    }

    return true;
  } catch {
    return false;
  }
}

async function reinitializeMcpSession(config: ResolvedPluginConfig): Promise<boolean> {
  if (!config.mcpUrl) return false;
  const token = await resolveAuthToken(config);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...config.headers,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const initRes = await fetch(config.mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'reinit',
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'openclaw-owletto', version: '1.0.0' },
        },
      }),
    });
    const sid = initRes.headers.get('mcp-session-id');
    if (sid) {
      mcpSessionId = sid;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function callMcpTool(
  config: ResolvedPluginConfig,
  toolName: string,
  args: Record<string, unknown>
): Promise<McpToolResponse | null> {
  if (!config.mcpUrl) return null;
  const token = await resolveAuthToken(config);

  const rpcId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const authHeaders: Record<string, string> = { ...config.headers };
  if (token) {
    authHeaders.Authorization = `Bearer ${token}`;
  }

  const rpcBody = {
    jsonrpc: DEFAULT_RPC_VERSION,
    id: rpcId,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  };

  let result: { data: unknown; response: Response };
  try {
    result = await mcpFetch(config.mcpUrl, rpcBody, authHeaders);
  } catch (err) {
    throw new Error(`MCP fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let { data, response } = result;

  // Auto-refresh on 401/403 if we have a refresh token
  if ((response.status === 401 || response.status === 403) && config.mcpUrl) {
    const refreshed = await tryRefreshToken(config.mcpUrl);
    if (refreshed && sessionToken) {
      authHeaders.Authorization = `Bearer ${sessionToken}`;
      const retryBody = { ...rpcBody, id: `${rpcId}-retry` };
      const retry = await mcpFetch(config.mcpUrl, retryBody, authHeaders);
      data = retry.data;
      response = retry.response;
    }
  }

  if (response.status === 401 || response.status === 403) {
    clearSessionTokens();
    throw new OwlettoAuthError(AUTH_REQUIRED_MSG);
  }

  // Re-initialize MCP session on stale/missing session errors
  if (response.status === 400 || response.status === 404) {
    const errMsg = parseErrorMessage(data);
    if (
      errMsg.includes('not initialized') ||
      errMsg.includes('Unknown session') ||
      errMsg.includes('Session not found')
    ) {
      const newSession = await reinitializeMcpSession(config);
      if (newSession) {
        const retryBody = { ...rpcBody, id: `${rpcId}-reinit` };
        const retry = await mcpFetch(config.mcpUrl!, retryBody, authHeaders);
        data = retry.data;
        response = retry.response;
      }
    }
  }

  if (!response.ok) {
    const errMsg = parseErrorMessage(data);
    if (isAuthErrorMessage(errMsg)) {
      clearSessionTokens();
      throw new OwlettoAuthError(errMsg);
    }
    throw new Error(errMsg);
  }

  const rpcResponse = isRecord(data) ? (data as Record<string, unknown>) : {};
  if (isRecord(rpcResponse.error) || typeof rpcResponse.error === 'string') {
    const errMsg = parseErrorMessage(rpcResponse.error);
    if (isAuthErrorMessage(errMsg)) {
      clearSessionTokens();
      throw new OwlettoAuthError(errMsg);
    }
    throw new Error(errMsg);
  }

  const rpcResult = isRecord(rpcResponse.result)
    ? (rpcResponse.result as Record<string, unknown>)
    : rpcResponse;

  if (rpcResult.isError === true) {
    // Error text may be in rpcResult.error or in rpcResult.content[0].text
    const contentText = Array.isArray(rpcResult.content)
      ? (rpcResult.content as Array<{ type: string; text: string }>)
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n')
      : '';
    const errMsg = contentText || parseErrorMessage(rpcResult.error);
    if (isAuthErrorMessage(errMsg)) {
      clearSessionTokens();
      throw new OwlettoAuthError(errMsg);
    }
    throw new Error(errMsg);
  }

  const content = Array.isArray(rpcResult.content)
    ? (rpcResult.content as Array<{ type: string; text: string }>)
    : [];
  return { content, isError: false };
}

function extractTextFromContent(content: Array<{ type: string; text: string }>): string {
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

async function fetchWorkspaceInstructions(
  config: ResolvedPluginConfig,
  log: PluginLogger
): Promise<void> {
  try {
    const token = await resolveAuthToken(config);
    const authHeaders: Record<string, string> = { ...config.headers };
    if (token) authHeaders.Authorization = `Bearer ${token}`;

    const { data, response } = await mcpFetch(
      config.mcpUrl!,
      {
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'openclaw-owletto', version: '1.0.0' },
        },
      },
      authHeaders
    );

    if (!response.ok) return;
    const rpcResponse = isRecord(data) ? (data as Record<string, unknown>) : null;
    const result =
      rpcResponse && isRecord(rpcResponse.result)
        ? (rpcResponse.result as Record<string, unknown>)
        : null;
    if (result && typeof result.instructions === 'string') {
      cachedWorkspaceInstructions = result.instructions;
      log.info('owletto: loaded workspace instructions after login');
    }
  } catch (err) {
    log.warn(
      `owletto: failed to fetch workspace instructions: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

interface McpBootstrap {
  tools: McpToolDefinition[];
  instructions: string | null;
  sessionId: string | null;
}

function fetchMcpBootstrapSync(config: ResolvedPluginConfig): McpBootstrap {
  if (!config.mcpUrl) {
    return { tools: [], instructions: null, sessionId: null };
  }

  let token: string | null = sessionToken || config.token || null;
  if (!token && config.tokenCommand) {
    try {
      token = execSync(config.tokenCommand, {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
        .toString()
        .trim();
    } catch {
      return { tools: [], instructions: null, sessionId: null };
    }
  }

  // Pass mcpUrl + auth token through env vars so neither the shell nor the
  // node -e argument carries attacker-controlled text.
  const script = `
    const url = process.env.__MCP_URL;
    const token = process.env.__MCP_TOKEN;
    const base = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (token) base.Authorization = 'Bearer ' + token;
    async function run() {
      const initRes = await fetch(url, { method: 'POST', headers: base, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'openclaw-owletto', version: '1.0.0' } } }) });
      const initData = await initRes.json();
      const sid = initRes.headers.get('mcp-session-id');
      const h2 = { ...base };
      if (sid) h2['Mcp-Session-Id'] = sid;
      const tlRes = await fetch(url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
      const tlData = await tlRes.json();
      process.stdout.write(JSON.stringify({ tools: tlData?.result?.tools || [], instructions: initData?.result?.instructions || null, sessionId: sid || null }));
    }
    run().catch(() => process.stdout.write(JSON.stringify({ tools: [], instructions: null, sessionId: null })));
  `;

  try {
    const output = spawnSync('node', ['-e', script], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        __MCP_URL: config.mcpUrl,
        __MCP_TOKEN: token ?? '',
      },
    })
      .stdout?.toString()
      .trim();
    if (!output) return { tools: [], instructions: null, sessionId: null };
    return JSON.parse(output) as McpBootstrap;
  } catch {
    return { tools: [], instructions: null, sessionId: null };
  }
}

function registerMcpTools(
  config: ResolvedPluginConfig,
  registerTool: (def: Record<string, unknown>) => void,
  log: PluginLogger
): void {
  const { tools, instructions, sessionId } = fetchMcpBootstrapSync(config);

  if (sessionId) {
    mcpSessionId = sessionId;
  }

  if (instructions) {
    cachedWorkspaceInstructions = instructions;
    log.info('owletto: loaded workspace instructions from MCP server');
  }

  if (tools.length === 0) {
    log.warn('owletto: no MCP tools found (or fetch failed)');
    return;
  }

  for (const tool of tools) {
    registerTool({
      name: `owletto_${tool.name}`,
      label: tool.name.replace(/_/g, ' '),
      description: tool.description || `Owletto MCP tool: ${tool.name}`,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
      execute: async (_id: string, args: Record<string, unknown>) => {
        const result = await callMcpTool(config, tool.name, args);
        return { content: result?.content ?? [], details: {} };
      },
    });
  }

  log.info(`owletto: registered ${tools.length} MCP tools`);
}

const plugin = {
  id: 'openclaw-owletto',
  name: 'Lobu Memory',
  description: 'Lobu long-term memory plugin via MCP.',
  kind: 'memory' as const,
  register(api: Record<string, unknown>) {
    const log = getLogger(api);
    const on = getHookRegistrar(api);
    const registerTool =
      typeof api.registerTool === 'function'
        ? (api.registerTool as (def: Record<string, unknown>) => void)
        : undefined;
    const config = resolvePluginConfig(api, plugin.id);

    if (!config.mcpUrl) {
      log.warn('owletto: missing config.mcpUrl (plugins.entries.openclaw-owletto.config.mcpUrl)');
    }

    // Initialize fallback system context based on mode
    FALLBACK_SYSTEM_CONTEXT = renderFallbackSystemContext({
      gatewayMode: !!config.gatewayAuthUrl,
    });

    // Gateway mode: proxy handles auth + tools. Nothing to check at startup.

    // Load persisted token if no auth is configured via config/env (standalone mode only)
    if (
      config.mcpUrl &&
      !config.gatewayAuthUrl &&
      !config.token &&
      !config.tokenCommand &&
      !sessionToken
    ) {
      const stored = loadStoredSession(config.mcpUrl);
      if (stored?.accessToken) {
        sessionToken = stored.accessToken;
        _sessionRefreshToken = stored.refreshToken || null;
        sessionClientId = stored.clientId || null;
        sessionClientSecret = stored.clientSecret || null;
        sessionIssuer = stored.issuer || null;

        // Proactively refresh the token — the persisted access token may be expired
        if (_sessionRefreshToken && sessionIssuer && sessionClientId) {
          try {
            const body: Record<string, string> = {
              grant_type: 'refresh_token',
              client_id: sessionClientId,
              refresh_token: _sessionRefreshToken,
            };
            if (sessionClientSecret) body.client_secret = sessionClientSecret;
            // spawnSync imported at top-level (ESM-safe)
            const scriptCode = [
              'async function run() {',
              `  const r = await fetch(${JSON.stringify(sessionIssuer + '/oauth/token')}, {`,
              '    method: "POST",',
              '    headers: { "Content-Type": "application/json" },',
              `    body: ${JSON.stringify(JSON.stringify(body))},`,
              '  });',
              '  if (!r.ok) return;',
              '  const d = await r.json();',
              '  process.stdout.write(JSON.stringify({ access_token: d.access_token, refresh_token: d.refresh_token }));',
              '}',
              'run().catch(() => {});',
            ].join('\n');
            const proc = spawnSync('node', ['-e', scriptCode], {
              timeout: 10_000,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            const out = proc.stdout?.toString().trim() ?? '';
            if (out) {
              const tokens = JSON.parse(out) as { access_token?: string; refresh_token?: string };
              if (tokens.access_token) {
                sessionToken = tokens.access_token;
                if (tokens.refresh_token) _sessionRefreshToken = tokens.refresh_token;
                saveStoredSession(config.mcpUrl, {
                  issuer: sessionIssuer,
                  clientId: sessionClientId,
                  clientSecret: sessionClientSecret,
                  refreshToken: _sessionRefreshToken!,
                  accessToken: sessionToken,
                });
                log.info('owletto: refreshed expired access token');
              }
            }
          } catch (refreshErr) {
            log.warn(
              `owletto: token refresh failed: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`
            );
          }
        }

        // Auto-start worker daemon with (possibly refreshed) token
        spawnWorkerDaemon(config.mcpUrl, sessionToken, log);
      }
    }

    // Track active device login state for the session
    let activeDeviceLogin: DeviceLoginState | null = null;

    // Register login tools (standalone mode only — in gateway mode the proxy
    // auto-completes device-auth, so these tools are unnecessary)
    if (registerTool && config.mcpUrl && !config.gatewayAuthUrl) {
      const mcpUrl = config.mcpUrl;

      registerTool({
        name: 'owletto_login',
        label: 'Owletto Login',
        description:
          'Start Lobu memory authentication. Only call this if other Lobu memory tools return authentication errors. If Lobu memory is already connected, skip this step. Returns a URL and code for the user to complete login in their browser. After the user completes login, call owletto_login_check to finish.',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          try {
            // Gateway mode: delegate to gateway device-auth endpoints
            if (config.gatewayAuthUrl) {
              // Check if already authenticated via gateway
              const alreadyAuth = await gatewayDeviceAuthCheck(config.gatewayAuthUrl);
              if (alreadyAuth) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        status: 'already_authenticated',
                        message:
                          "You are already authenticated with Owletto. Do NOT call owletto_login again. Proceed directly with the user's request using the available owletto tools.",
                      }),
                    },
                  ],
                  details: {},
                };
              }

              const started = await gatewayDeviceAuthStart(config.gatewayAuthUrl);
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'login_started',
                      message:
                        'Open this URL in your browser and enter the code to connect Owletto:',
                      verification_url: started.verificationUriComplete || started.verificationUri,
                      user_code: started.userCode,
                      expires_in_seconds: started.expiresIn,
                      next_step:
                        'After the user completes login in their browser, call owletto_login_check to finish authentication.',
                    }),
                  },
                ],
                details: {},
              };
            }

            // Standalone mode: direct device flow
            if (sessionToken) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'already_authenticated',
                      message:
                        "You are already authenticated with Owletto. Do NOT call owletto_login again. Proceed directly with the user's request using the available owletto tools like owletto_manage_connections, owletto_manage_watchers, etc.",
                    }),
                  },
                ],
                details: {},
              };
            }

            const resource = mcpUrl;
            activeDeviceLogin = await initiateDeviceLogin(mcpUrl, DEFAULT_MCP_SCOPE, resource);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'login_started',
                    message: 'Open this URL in your browser and enter the code to connect Owletto:',
                    verification_url: activeDeviceLogin.verificationUriComplete,
                    user_code: activeDeviceLogin.userCode,
                    expires_in_seconds: activeDeviceLogin.expiresIn,
                    next_step:
                      'After the user completes login in their browser, call owletto_login_check to finish authentication.',
                  }),
                },
              ],
              details: {},
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'error',
                    message: `Login failed: ${err instanceof Error ? err.message : String(err)}`,
                  }),
                },
              ],
              details: {},
            };
          }
        },
      });

      registerTool({
        name: 'owletto_login_check',
        label: 'Owletto Login Check',
        description:
          'Check if the user has completed Owletto login in their browser. Call this after owletto_login. Returns success when authenticated, or pending if still waiting.',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          try {
            // Gateway mode: poll gateway for completion
            if (config.gatewayAuthUrl) {
              const result = await gatewayDeviceAuthPoll(config.gatewayAuthUrl);

              if (result.status === 'complete') {
                log.info('owletto: gateway device auth completed');

                // Fetch workspace instructions now that we're authenticated
                if (!cachedWorkspaceInstructions) {
                  fetchWorkspaceInstructions(config, log);
                }

                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        status: 'authenticated',
                        message:
                          'Owletto login successful! Memory tools are now available for this session.',
                      }),
                    },
                  ],
                  details: {},
                };
              }

              if (result.status === 'pending') {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        status: 'pending',
                        message: 'Waiting for user to approve in browser...',
                        next_step: 'Wait a few seconds, then call owletto_login_check again.',
                      }),
                    },
                  ],
                  details: {},
                };
              }

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'error',
                      message: result.message || 'Device auth failed',
                    }),
                  },
                ],
                details: {},
              };
            }

            // Standalone mode: direct device flow polling
            if (!activeDeviceLogin) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'error',
                      message: 'No login in progress. Call owletto_login first.',
                    }),
                  },
                ],
                details: {},
              };
            }

            const result = await pollDeviceLogin(activeDeviceLogin);

            if (result.status === 'complete') {
              sessionToken = result.accessToken;
              _sessionRefreshToken = result.refreshToken || null;
              sessionClientId = activeDeviceLogin.clientId;
              sessionClientSecret = activeDeviceLogin.clientSecret || null;
              sessionIssuer = activeDeviceLogin.issuer;

              if (result.refreshToken) {
                try {
                  saveStoredSession(mcpUrl, {
                    issuer: sessionIssuer,
                    clientId: sessionClientId,
                    clientSecret: sessionClientSecret,
                    refreshToken: result.refreshToken,
                    accessToken: result.accessToken,
                  });
                  log.info('owletto: persisted auth token to disk');
                } catch (err) {
                  log.warn(
                    `owletto: failed to persist auth token: ${err instanceof Error ? err.message : String(err)}`
                  );
                }
              }

              config.token = result.accessToken;
              activeDeviceLogin = null;

              spawnWorkerDaemon(mcpUrl, result.accessToken, log);

              if (!cachedWorkspaceInstructions) {
                fetchWorkspaceInstructions(config, log);
              }

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'authenticated',
                      message:
                        'Owletto login successful! Memory tools are now available for this session.',
                    }),
                  },
                ],
                details: {},
              };
            }

            if (result.status === 'pending') {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'pending',
                      message: result.message,
                      next_step: 'Wait a few seconds, then call owletto_login_check again.',
                    }),
                  },
                ],
                details: {},
              };
            }

            activeDeviceLogin = null;
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'error',
                    message: result.message,
                  }),
                },
              ],
              details: {},
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'error',
                    message: `Login check failed: ${err instanceof Error ? err.message : String(err)}`,
                  }),
                },
              ],
              details: {},
            };
          }
        },
      });

      log.info('owletto: registered login tools (owletto_login, owletto_login_check)');
    }

    // Dynamic tool registration from MCP server (synchronous so tools are
    // available before OpenClaw builds the prompt).
    // In gateway mode, tools are already registered above.
    if (registerTool && config.mcpUrl && !config.gatewayAuthUrl && hasAuthConfigured(config)) {
      registerMcpTools(config, registerTool, log);
    }

    // Inject workspace instructions (dynamic from server) or fallback (static).
    // When autoRecall is enabled, also inject recalled memories.
    {
      const getSystemContext = () =>
        cachedWorkspaceInstructions
          ? `<owletto-system>\n${cachedWorkspaceInstructions}\n</owletto-system>`
          : FALLBACK_SYSTEM_CONTEXT;
      const doRecall = async (query: string): Promise<string> => {
        if (!config.autoRecall || !hasAuthConfigured(config)) {
          return '';
        }

        try {
          const result = await callMcpTool(config, 'search_knowledge', {
            query,
            include_content: true,
            content_limit: config.recallLimit,
            include_connections: false,
            limit: 3,
          });
          if (!result) return '';

          const text = extractTextFromContent(result.content);
          if (!text.trim()) return '';

          return (
            '<owletto-memory>\n' +
            "Use these long-term memories only when directly relevant to the user's request.\n" +
            'Do not mention this memory block unless needed.\n\n' +
            text +
            '\n</owletto-memory>'
          );
        } catch (err) {
          if (err instanceof OwlettoAuthError) {
            return '';
          }
          log.error(`owletto recall failed: ${err instanceof Error ? err.message : String(err)}`);
          return '';
        }
      };
      const buildPrependContext = (recallBlock: string) => ({
        prependContext: getSystemContext() + (recallBlock ? '\n' + recallBlock : ''),
      });

      on('before_prompt_build', async (event: Record<string, unknown>) => {
        const prompt = event.prompt;
        const messages = event.messages;
        let query: string | null = null;

        if (Array.isArray(messages)) {
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (!isRecord(m) || m.role !== 'user') continue;
            if (typeof m.content === 'string' && m.content.trim()) {
              query = m.content.trim();
              break;
            }
            if (Array.isArray(m.content)) {
              const textParts = m.content
                .filter((part) => isRecord(part) && part.type === 'text')
                .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
                .filter((text) => text.trim().length > 0);
              if (textParts.length > 0) {
                query = textParts.join('\n').trim();
                break;
              }
            }
          }
        }

        if (!query && typeof prompt === 'string' && prompt.trim()) {
          query = prompt.trim();
        }

        if (!query) return;

        // Skip injection for heartbeats and internal events
        if (/heartbeat|question:q_/i.test(query)) return;

        const recallBlock = await doRecall(query);
        return buildPrependContext(recallBlock);
      });

      on('before_agent_start', async (event: Record<string, unknown>) => {
        const prompt = event.prompt;
        if (typeof prompt !== 'string' || !prompt.trim()) return;
        if (/heartbeat|question:q_/i.test(prompt)) return;

        const recallBlock = await doRecall(prompt.trim());
        return buildPrependContext(recallBlock);
      });
    }

    if (config.autoCapture) {
      let lastCapturedLen = 0;

      on('before_prompt_build', async (event: Record<string, unknown>) => {
        if (!hasAuthConfigured(config)) return;

        const messages = event.messages;
        if (!Array.isArray(messages) || messages.length < 2) return;
        // Only capture when new messages appeared since last capture
        if (messages.length <= lastCapturedLen) return;

        // Find the most recent assistant+user pair (the previous turn)
        let lastUser: string | null = null;
        let lastAssistant: string | null = null;
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (!isRecord(m)) continue;
          const text =
            typeof m.content === 'string'
              ? m.content
              : Array.isArray(m.content)
                ? m.content
                    .filter((p: unknown) => isRecord(p) && p.type === 'text')
                    .map((p: unknown) => (isRecord(p) && typeof p.text === 'string' ? p.text : ''))
                    .join('\n')
                : '';
          if (!text.trim()) continue;
          if (m.role === 'assistant' && !lastAssistant) lastAssistant = text.trim();
          if (m.role === 'user' && !lastUser) lastUser = text.trim();
          if (lastUser && lastAssistant) break;
        }

        if (!lastUser || !lastAssistant) return;

        const combined = `User: ${lastUser}\nAssistant: ${lastAssistant}`;
        if (combined.length < 16 || combined.includes('<owletto-memory>')) return;

        lastCapturedLen = messages.length;
        const content = combined.length > 2000 ? combined.slice(0, 2000) : combined;

        // Fire-and-forget — don't block prompt build
        callMcpTool(config, 'save_knowledge', {
          content,
          semantic_type: 'observation',
          metadata: {},
        })
          .then(() => log.info('owletto: captured conversation observation'))
          .catch((err) =>
            log.warn(
              `owletto: autoCapture failed: ${err instanceof Error ? err.message : String(err)}`
            )
          );
      });
    }

    log.info(
      `owletto: initialized (configured=${!!config.mcpUrl}, token=${!!config.token}, tokenCommand=${!!config.tokenCommand}, tools=${!!registerTool})`
    );
  },
};

export default plugin;
