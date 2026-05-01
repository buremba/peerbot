/**
 * E2E Test Helpers
 *
 * Shared utilities for the openclaw plugin end-to-end tests.
 * Connects directly to the running app's database (via DATABASE_URL)
 * and makes HTTP calls to the app container at APP_URL (default: http://localhost:8787).
 */

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const APP_URL = process.env.APP_URL || 'http://localhost:8787';

let sql: postgres.Sql | null = null;

function getDb(): postgres.Sql {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is required for e2e tests');
    }
    sql = postgres(url, {
      max: 3,
      idle_timeout: 20,
      ssl: process.env.PGSSLMODE === 'require' ? 'require' : undefined,
      onnotice: () => {},
    });
  }
  return sql;
}

export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
  }
}

// ---------------------------------------------------------------------------
// Token generation (mirrors packages/cli/runtime/src/auth/oauth/utils.ts)
// ---------------------------------------------------------------------------

function generateSecureToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

export interface TestOrg {
  id: string;
  name: string;
  slug: string;
}

interface TestUser {
  id: string;
  email: string;
  name: string;
  username: string;
}

interface TestSession {
  sessionId: string;
  token: string;
  userId: string;
  cookieHeader: string;
}

export async function createTestOrg(slug?: string): Promise<TestOrg> {
  const db = getDb();
  const id = `org_e2e_${generateSecureToken(6)}`;
  const name = `E2E Test Org ${id.slice(4, 12)}`;
  const orgSlug = slug || `e2e-test-${id.slice(4, 12)}`;

  await db`
    INSERT INTO "organization" (id, name, slug, visibility, "createdAt")
    VALUES (${id}, ${name}, ${orgSlug}, 'private', NOW())
  `;

  return { id, name, slug: orgSlug };
}

async function createTestUser(): Promise<TestUser> {
  const db = getDb();
  const id = `user_e2e_${generateSecureToken(6)}`;
  const email = `${id}@e2e-test.example.com`;
  const name = `E2E User ${id.slice(5, 13)}`;
  const username = `e2e-${id.slice(5, 13)}`;

  await db`
    INSERT INTO "user" (id, email, name, username, "emailVerified", "createdAt", "updatedAt")
    VALUES (${id}, ${email}, ${name}, ${username}, true, NOW(), NOW())
  `;

  return { id, email, name, username };
}

export async function addUserToOrg(userId: string, orgId: string, role = 'owner'): Promise<string> {
  const db = getDb();
  const memberId = `member_e2e_${generateSecureToken(6)}`;

  await db`
    INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
    VALUES (${memberId}, ${userId}, ${orgId}, ${role}, NOW())
  `;

  return memberId;
}

/**
 * Sign up a fresh user via Better Auth HTTP and return the session cookie.
 * This produces a real session cookie signed by the running app,
 * avoiding any manual crypto that could drift from the server.
 *
 * Returns: user info + session cookie.
 */
export interface SignedUpUser {
  userId: string;
  email: string;
  cookieHeader: string;
}

export async function signUpTestUser(): Promise<SignedUpUser> {
  const email = `e2e-${generateSecureToken(6)}@e2e-test.example.com`;
  const password = `E2E-test-pass-${generateSecureToken(8)}!1`;
  const name = `E2E User ${email.split('@')[0]}`;

  const res = await fetch(`${APP_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: APP_URL,
    },
    body: JSON.stringify({ email, password, name }),
    redirect: 'manual',
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`sign-up failed (${res.status}): ${body}`);
  }

  // Extract session cookie
  const setCookieHeaders = res.headers.getSetCookie?.() ?? [];
  // Cookie name may have __Secure- prefix (when running behind HTTPS)
  const sessionCookie = setCookieHeaders.find(
    (c) =>
      c.startsWith('better-auth.session_token=') ||
      c.startsWith('__Secure-better-auth.session_token=')
  );

  if (!sessionCookie) {
    throw new Error(
      `No session cookie in sign-up response (status=${res.status}). ` +
        `Set-Cookie: ${JSON.stringify(setCookieHeaders)}`
    );
  }

  const cookieHeader = sessionCookie.split(';', 1)[0] || '';

  // Get user ID from the response body
  const data = (await res.json()) as { user?: { id: string } };
  const userId = data.user?.id;
  if (!userId) {
    throw new Error('No user ID in sign-up response');
  }

  return { userId, email, cookieHeader };
}

// ---------------------------------------------------------------------------
// OAuth Device Flow Helpers
// ---------------------------------------------------------------------------

interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
}

export async function oauthRegisterClient(scope = 'mcp:read mcp:write'): Promise<RegisteredClient> {
  const res = await fetch(`${APP_URL}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      client_name: 'E2E Test Client',
      software_id: 'e2e-test',
      software_version: '1.0.0',
      scope,
    }),
  });

  if (!res.ok) {
    throw new Error(`Client registration failed: ${await res.text()}`);
  }

  const data = (await res.json()) as { client_id: string; client_secret?: string };
  return { clientId: data.client_id, clientSecret: data.client_secret };
}

interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export async function oauthDeviceAuthorize(
  clientId: string,
  scope = 'mcp:read mcp:write',
  resource?: string
): Promise<DeviceAuthResponse> {
  const body: Record<string, string> = { client_id: clientId, scope };
  if (resource) body.resource = resource;

  const res = await fetch(`${APP_URL}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Device authorization failed: ${await res.text()}`);
  }

  return (await res.json()) as DeviceAuthResponse;
}

export async function oauthApproveDevice(
  userCode: string,
  cookieHeader: string,
  organizationId?: string
): Promise<void> {
  const body: Record<string, unknown> = {
    user_code: userCode,
    approved: true,
  };
  if (organizationId) body.organization_id = organizationId;

  const res = await fetch(`${APP_URL}/oauth/device/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
      Origin: APP_URL,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Device approval failed: ${await res.text()}`);
  }

  const data = (await res.json()) as { status: string };
  if (data.status !== 'approved') {
    throw new Error(`Device approval returned unexpected status: ${data.status}`);
  }
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export async function oauthExchangeDeviceCode(
  clientId: string,
  deviceCode: string,
  clientSecret?: string
): Promise<TokenResponse> {
  const body: Record<string, string> = {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: clientId,
    device_code: deviceCode,
  };
  if (clientSecret) body.client_secret = clientSecret;

  const res = await fetch(`${APP_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errData = (await res.json()) as { error?: string; error_description?: string };
    throw new Error(`Token exchange failed: ${errData.error} — ${errData.error_description}`);
  }

  return (await res.json()) as TokenResponse;
}

export async function oauthRefreshToken(
  clientId: string,
  refreshToken: string,
  clientSecret?: string
): Promise<TokenResponse> {
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  };
  if (clientSecret) body.client_secret = clientSecret;

  const res = await fetch(`${APP_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errData = (await res.json()) as { error?: string; error_description?: string };
    throw new Error(`Token refresh failed: ${errData.error} — ${errData.error_description}`);
  }

  return (await res.json()) as TokenResponse;
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC Helpers
// ---------------------------------------------------------------------------

let mcpRpcCounter = 0;

interface McpRpcResult {
  status: number;
  sessionId?: string;
  body: unknown;
}

/**
 * Send a JSON-RPC request to the MCP endpoint.
 * Returns the HTTP status, session ID header, and parsed body.
 */
export async function mcpRpc(
  method: string,
  params: Record<string, unknown> = {},
  opts?: { token?: string; sessionId?: string; orgSlug?: string }
): Promise<McpRpcResult> {
  const path = opts?.orgSlug ? `/mcp/${opts.orgSlug}` : '/mcp';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (opts?.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts?.sessionId) headers['mcp-session-id'] = opts.sessionId;

  const res = await fetch(`${APP_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++mcpRpcCounter,
      method,
      params,
    }),
  });

  const sessionId = res.headers.get('mcp-session-id') ?? undefined;

  // Handle SSE responses — extract last data: line as JSON
  const contentType = res.headers.get('content-type') || '';
  let body: unknown;
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.startsWith('data: '));
    const last = lines[lines.length - 1];
    body = last ? JSON.parse(last.replace('data: ', '')) : null;
  } else {
    body = await res.json();
  }

  return { status: res.status, sessionId, body };
}

/**
 * Initialize an MCP session and return the session ID.
 */
export async function mcpInitSession(token?: string, orgSlug?: string): Promise<string> {
  const res = await mcpRpc(
    'initialize',
    {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'e2e-test', version: '1.0' },
    },
    { token, orgSlug }
  );

  if (!res.sessionId) {
    throw new Error(`MCP initialize did not return session ID (status=${res.status})`);
  }

  // Send initialized notification
  await mcpRpc('notifications/initialized', {}, { token, sessionId: res.sessionId, orgSlug });

  return res.sessionId;
}

/**
 * Call an MCP tool and return the result.
 */
export async function mcpCallTool(
  toolName: string,
  args: Record<string, unknown>,
  opts: { token?: string; sessionId: string; orgSlug?: string }
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const res = await mcpRpc('tools/call', { name: toolName, arguments: args }, opts);

  const rpc = res.body as {
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
    error?: unknown;
  };
  if (rpc.error) {
    throw new Error(`MCP RPC error: ${JSON.stringify(rpc.error)}`);
  }
  return rpc.result!;
}

// ---------------------------------------------------------------------------
// Auth File Seeding (matches AuthStore at openclaw-plugin/src/index.ts:107-175)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(process.cwd(), '../..');
const AUTH_STORE_DIR = resolve(REPO_ROOT, 'data/openclaw-auth');
const AUTH_STORE_FILE = resolve(AUTH_STORE_DIR, 'openclaw-auth.json');

interface AuthStore {
  version: 1;
  sessions: Record<
    string,
    {
      mcpUrl: string;
      issuer: string;
      clientId: string;
      clientSecret?: string;
      refreshToken: string;
      accessToken: string;
      updatedAt: string;
    }
  >;
}

export function seedAuthFile(opts: {
  mcpUrl: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  accessToken: string;
}): void {
  mkdirSync(AUTH_STORE_DIR, { recursive: true });

  // Normalize mcpUrl the same way the plugin does (src/index.ts:118-126)
  const url = new URL(opts.mcpUrl);
  url.hash = '';
  url.search = '';
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/mcp';
  }
  const key = url.toString().replace(/\/+$/, '');

  const store: AuthStore = {
    version: 1,
    sessions: {
      [key]: {
        mcpUrl: key,
        issuer: opts.issuer,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        refreshToken: opts.refreshToken,
        accessToken: opts.accessToken,
        updatedAt: new Date().toISOString(),
      },
    },
  };

  writeFileSync(AUTH_STORE_FILE, JSON.stringify(store, null, 2));
}

export function removeAuthFile(): void {
  try {
    rmSync(AUTH_STORE_FILE, { force: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Plugin Dist Sync (ensure container extension matches the local build)
// ---------------------------------------------------------------------------

const EXTENSION_DIST_DIR = resolve(REPO_ROOT, 'data/openclaw/extensions/openclaw-owletto/dist');
const PLUGIN_DIST_DIR = resolve(REPO_ROOT, 'packages/openclaw-plugin/dist');

/**
 * Copy the locally built plugin dist into the extension directory that the
 * container loads.  The volume mount at ./data/openclaw exposes this to the
 * container at /home/openclaw/.openclaw/extensions/openclaw-owletto/dist.
 *
 * Call this while the container is stopped so the file-watcher doesn't
 * trigger a disruptive restart.
 */
export function syncPluginDist(): void {
  cpSync(PLUGIN_DIST_DIR, EXTENSION_DIST_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Openclaw Plugin Config Patching
// ---------------------------------------------------------------------------

const OPENCLAW_CONFIG_FILE = resolve(REPO_ROOT, 'data/openclaw/openclaw.json');
let _originalOpenclawConfig: string | null = null;

/**
 * Patch the openclaw container's plugin config: remove tokenCommand so the
 * plugin falls back to the seeded auth file, set org-scoped mcpUrl, and
 * ensure autoRecall/autoCapture are enabled. Saves the original for restoration.
 */
export function patchOpenclawPluginConfig(orgSlug: string): void {
  _originalOpenclawConfig = readFileSync(OPENCLAW_CONFIG_FILE, 'utf-8');
  const config = JSON.parse(_originalOpenclawConfig);

  const pluginConfig = config?.plugins?.entries?.['openclaw-owletto']?.config;
  if (pluginConfig) {
    delete pluginConfig.tokenCommand;
    delete pluginConfig.gatewayAuthUrl;
    pluginConfig.mcpUrl = `http://app:8787/mcp/${orgSlug}`;
    pluginConfig.autoRecall = true;
    pluginConfig.autoCapture = true;
  }

  writeFileSync(OPENCLAW_CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Restore the original openclaw config (call in afterAll).
 */
export function restoreOpenclawPluginConfig(): void {
  if (_originalOpenclawConfig) {
    writeFileSync(OPENCLAW_CONFIG_FILE, _originalOpenclawConfig);
    _originalOpenclawConfig = null;
  }
}

// ---------------------------------------------------------------------------
// Openclaw Agent Runner
// ---------------------------------------------------------------------------

interface AgentResult {
  raw: string;
  json: unknown;
  exitCode: number;
}

/**
 * Extract the last JSON object from mixed log + JSON output.
 * openclaw agent --json writes logs and the JSON payload to stderr.
 */
function extractJson(output: string): string {
  // Find the last `{` that starts a top-level JSON object by looking for
  // `{"payloads"` or `{"error"` patterns, then match to the closing `}`.
  const idx = output.lastIndexOf('\n{');
  if (idx !== -1) {
    return output.slice(idx + 1).trim();
  }
  // Fallback: try from the first `{` on its own line
  const match = output.match(/^(\{[\s\S]*\})\s*$/m);
  return match?.[1]?.trim() || output;
}

/**
 * Run `openclaw agent --local --message "..." --json` inside the openclaw container.
 * Returns the parsed JSON output.
 */
export function runOpenclawAgent(
  message: string,
  opts?: { sessionId?: string; timeoutMs?: number }
): AgentResult {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const sessionArgs = opts?.sessionId ? `--session-id ${opts.sessionId}` : '';

  const cmd = [
    'docker exec',
    `-e ZAI_API_KEY="${process.env.ZAI_API_KEY || ''}"`,
    'openclaw-plugin-1',
    'openclaw agent --local',
    `--message ${JSON.stringify(message)}`,
    sessionArgs,
    '--json',
  ]
    .filter(Boolean)
    .join(' ');

  try {
    // openclaw agent --json writes the JSON payload to stderr, not stdout
    const result = execSync(`${cmd} 2>&1`, {
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // The combined output includes log lines + JSON. Extract the JSON block.
    const raw = extractJson(result);

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }

    return { raw, json, exitCode: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; status?: number };
    const combined = (execErr.stdout || '') + (execErr.stderr || '');
    const raw = extractJson(combined);
    return {
      raw,
      json: null,
      exitCode: execErr.status ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Delete all test data created by this e2e run.
 * Uses prefix for manual fixtures and email pattern for Better Auth sign-ups.
 */
export async function cleanupTestData(): Promise<void> {
  const db = getDb();

  // Delete in dependency order
  // Sessions for sign-up users (matched by email) and prefix-based users
  await db`DELETE FROM "session" WHERE "userId" IN (
    SELECT id FROM "user" WHERE email LIKE '%@e2e-test.example.com'
  )`;
  await db`DELETE FROM "session" WHERE id LIKE 'session_e2e_%'`;
  await db`DELETE FROM "account" WHERE "userId" IN (
    SELECT id FROM "user" WHERE email LIKE '%@e2e-test.example.com'
  )`;
  await db`DELETE FROM "member" WHERE id LIKE 'member_e2e_%'`;
  // Also delete members for sign-up users
  await db`DELETE FROM "member" WHERE "userId" IN (
    SELECT id FROM "user" WHERE email LIKE '%@e2e-test.example.com'
  )`;
  // Delete events + entities in test orgs (must precede user/org deletion due to FKs)
  await db`DELETE FROM events WHERE organization_id LIKE 'org_e2e_%'`;
  // Clear parent references before deleting entities (parent_id has RESTRICT)
  await db`UPDATE entities SET parent_id = NULL WHERE organization_id LIKE 'org_e2e_%'`;
  await db`DELETE FROM entities WHERE organization_id LIKE 'org_e2e_%'`;

  await db`DELETE FROM "user" WHERE email LIKE '%@e2e-test.example.com'`;
  await db`DELETE FROM "user" WHERE id LIKE 'user_e2e_%'`;
  await db`DELETE FROM "organization" WHERE id LIKE 'org_e2e_%'`;

  // Clean up any OAuth artifacts created by our test clients
  await db`DELETE FROM oauth_device_codes WHERE client_id IN (
    SELECT client_id FROM oauth_clients WHERE client_name = 'E2E Test Client'
  )`;
  await db`DELETE FROM oauth_tokens WHERE client_id IN (
    SELECT client_id FROM oauth_clients WHERE client_name = 'E2E Test Client'
  )`;
  await db`DELETE FROM oauth_authorization_codes WHERE client_id IN (
    SELECT client_id FROM oauth_clients WHERE client_name = 'E2E Test Client'
  )`;
  await db`DELETE FROM oauth_clients WHERE client_name = 'E2E Test Client'`;

  removeAuthFile();
}
