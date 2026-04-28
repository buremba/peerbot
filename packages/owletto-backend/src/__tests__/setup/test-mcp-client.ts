/**
 * Composable test clients for the post-#348 MCP surface.
 *
 *   TestMcpClient  — full HTTP/JSON-RPC round-trip. Exercises auth, session
 *                    init, tool dispatch, and (for `run`/`query`) the
 *                    isolated-vm sandbox. Use it for tests that have to
 *                    verify MCP wire behavior (auth headers, JSON-RPC error
 *                    framing, sandbox timeouts). Surface mirrors the public
 *                    MCP tools: `search`, `searchKnowledge`, `saveKnowledge`,
 *                    `querySql`, `resolvePath`, `listOrganizations`, `run`,
 *                    `query`, plus a `raw()` escape hatch.
 *
 *   TestApiClient  — direct handler imports. Skips HTTP/sandbox; calls the
 *                    same namespace builders the sandbox exposes. Fast,
 *                    deterministic, and the right tool for CRUD permutations,
 *                    cross-org isolation, and error-path edges. Surface is
 *                    the typed SDK: `client.entities`, `client.watchers`,
 *                    `client.classifiers`, etc. — `withAuth()` produces a new
 *                    client with overridden role/scopes for denial-path tests.
 *
 * The two surfaces are deliberately not interchangeable. `TestMcpClient.run()`
 * is the wire-level analogue of `TestApiClient.entities.create(...)`; pick
 * the layer that matches what you're testing rather than swapping them.
 */

import type { Env } from '../../index';
import type { ToolContext, TokenType } from '../../tools/registry';
import {
  buildAuthProfilesNamespace,
  buildClassifiersNamespace,
  buildConnectionsNamespace,
  buildEntitiesNamespace,
  buildEntitySchemaNamespace,
  buildFeedsNamespace,
  buildKnowledgeNamespace,
  buildOperationsNamespace,
  buildOrganizationsNamespace,
  buildViewTemplatesNamespace,
  buildWatchersNamespace,
} from '../../sandbox/namespaces';
import { initWorkspaceProvider } from '../../workspace';
import { mcpRequest, mcpToolsCall } from './test-helpers';

/**
 * Global init the namespace handlers depend on (URL building, slug lookup).
 * The HTTP test-helpers do this lazily via `ensureWorkspaceProvider`; the
 * direct-handler client has no request lifecycle, so we trigger the init
 * the first time TestApiClient is constructed and cache the promise.
 */
let workspaceReady: Promise<unknown> | null = null;
function ensureWorkspaceReady(): Promise<unknown> {
  if (!workspaceReady) {
    workspaceReady = initWorkspaceProvider();
  }
  return workspaceReady;
}

// ── shared types ─────────────────────────────────────────────────────────

export interface TestClientAuth {
  /** Required for any non-org-agnostic call. */
  organizationId: string;
  /** OAuth user; null for anonymous public reads. */
  userId: string | null;
  /** Member role in the org; null for non-members reading a public workspace. */
  memberRole: 'owner' | 'admin' | 'member' | null;
  /** OAuth scopes; defaults to full ['mcp:read', 'mcp:write', 'mcp:admin'] when
   * not supplied. Tests asserting scope-denial paths must override this. */
  scopes?: string[];
  /** Optional durable agent identity for the session. */
  agentId?: string;
  /** Token kind. Defaults to 'oauth' for authenticated users, 'anonymous'
   * otherwise. Some handlers (e.g. cross-org `client.org()`) gate on this. */
  tokenType?: TokenType;
  /** True when the MCP URL pinned an org slug (e.g. `/mcp/acme`). When the
   * direct-handler client is used, set this to mirror the wire intent. */
  scopedToOrg?: boolean;
}

const DEFAULT_TEST_ENV: Env = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  MAX_CONSECUTIVE_FAILURES: '3',
  RATE_LIMIT_ENABLED: 'false',
  EMBEDDINGS_SERVICE_URL: process.env.EMBEDDINGS_SERVICE_URL,
  EMBEDDINGS_SERVICE_TOKEN: process.env.EMBEDDINGS_SERVICE_TOKEN,
  EMBEDDINGS_TIMEOUT_MS: process.env.EMBEDDINGS_TIMEOUT_MS,
};

// ── HTTP layer (MCP JSON-RPC) ───────────────────────────────────────────

/**
 * Wire-level test client. Boots no HTTP server — calls go straight into the
 * Hono app via `app.fetch`. Use when the test has to verify behavior the
 * sandbox or auth layer adds on top of the raw handler.
 */
export class TestMcpClient {
  constructor(
    private readonly opts: {
      token: string;
      /** Pin the MCP session to `/mcp/{slug}`. Required for any tool other than
       * `list_organizations`; without it, the auth middleware never derives an
       * organizationId and every call fails with "Organization context required". */
      orgSlug?: string;
      env?: Partial<Env>;
      agentId?: string;
    }
  ) {}

  // ── direct MCP tools ─────────────────────────────────────────────────

  async listOrganizations(args: Record<string, unknown> = {}) {
    return mcpToolsCall('list_organizations', args, this.opts);
  }

  async resolvePath(path: string) {
    return mcpToolsCall('resolve_path', { path }, this.opts);
  }

  async search(args: { query: string; limit?: number }) {
    return mcpToolsCall('search', args, this.opts);
  }

  async searchKnowledge(args: Record<string, unknown>) {
    return mcpToolsCall('search_knowledge', args, this.opts);
  }

  async saveKnowledge(args: Record<string, unknown>) {
    return mcpToolsCall('save_knowledge', args, this.opts);
  }

  async querySql(sql: string, args: Record<string, unknown> = {}) {
    return mcpToolsCall('query_sql', { sql, ...args }, this.opts);
  }

  /**
   * Run a sandboxed script with the FULL ClientSDK (mutations allowed).
   * The script must `export default async (ctx, client) => ...`.
   * Use `query()` instead for read-only scripts — it gates writes at the
   * tool boundary so a bug in test setup can't accidentally mutate state.
   */
  async run<T = unknown>(
    script: string,
    options?: { timeout_ms?: number }
  ): Promise<T> {
    return mcpToolsCall<T>('run', { script, ...(options ?? {}) }, this.opts);
  }

  /** Read-only counterpart of `run()` — see #432. */
  async query<T = unknown>(
    script: string,
    options?: { timeout_ms?: number }
  ): Promise<T> {
    return mcpToolsCall<T>('query', { script, ...(options ?? {}) }, this.opts);
  }

  /**
   * Issue a raw JSON-RPC method (e.g. `tools/list`). Most callers don't
   * need this — it exists for tests that assert wire-level behavior.
   */
  async raw<T = unknown>(method: string, params?: Record<string, unknown>) {
    return mcpRequest<T>(method, params, this.opts);
  }
}

// ── direct-handler layer (no HTTP) ──────────────────────────────────────

/**
 * Direct-handler test client. Builds the same namespace surface the sandbox
 * exposes, but bypasses HTTP and isolated-vm. Use this for CRUD permutations,
 * error-path edges, and cross-org isolation tests where the MCP wire is not
 * the thing under test.
 */
export class TestApiClient {
  readonly auth_profiles: ReturnType<typeof buildAuthProfilesNamespace>;
  readonly classifiers: ReturnType<typeof buildClassifiersNamespace>;
  readonly connections: ReturnType<typeof buildConnectionsNamespace>;
  readonly entities: ReturnType<typeof buildEntitiesNamespace>;
  readonly entity_schema: ReturnType<typeof buildEntitySchemaNamespace>;
  readonly feeds: ReturnType<typeof buildFeedsNamespace>;
  readonly knowledge: ReturnType<typeof buildKnowledgeNamespace>;
  readonly operations: ReturnType<typeof buildOperationsNamespace>;
  readonly organizations: ReturnType<typeof buildOrganizationsNamespace>;
  readonly view_templates: ReturnType<typeof buildViewTemplatesNamespace>;
  readonly watchers: ReturnType<typeof buildWatchersNamespace>;

  private constructor(
    private readonly env: Env,
    private readonly ctx: ToolContext
  ) {
    this.auth_profiles = buildAuthProfilesNamespace(ctx, env);
    this.classifiers = buildClassifiersNamespace(ctx, env);
    this.connections = buildConnectionsNamespace(ctx, env);
    this.entities = buildEntitiesNamespace(ctx, env);
    this.entity_schema = buildEntitySchemaNamespace(ctx, env);
    this.feeds = buildFeedsNamespace(ctx, env);
    this.knowledge = buildKnowledgeNamespace(ctx, env);
    this.operations = buildOperationsNamespace(ctx, env);
    this.organizations = buildOrganizationsNamespace(ctx);
    this.view_templates = buildViewTemplatesNamespace(ctx, env);
    this.watchers = buildWatchersNamespace(ctx, env);
  }

  /**
   * Create a client bound to a specific auth context. Pass the result of
   * createTestUser/Organization fixtures to set `userId` / `organizationId`.
   * Memberships are checked inside the namespace handlers, so the role and
   * scopes here drive what the client is allowed to do.
   *
   * Triggers workspace-provider initialization on first call (lazy, idempotent).
   */
  static async for(auth: TestClientAuth, env: Partial<Env> = {}): Promise<TestApiClient> {
    await ensureWorkspaceReady();
    const tokenType: TokenType =
      auth.tokenType ?? (auth.userId !== null ? 'oauth' : 'anonymous');
    const scopedToOrg = auth.scopedToOrg ?? true;
    const ctx: ToolContext = {
      organizationId: auth.organizationId,
      userId: auth.userId,
      memberRole: auth.memberRole,
      agentId: auth.agentId ?? null,
      isAuthenticated: auth.userId !== null,
      clientId: null,
      scopes: auth.scopes ?? ['mcp:read', 'mcp:write', 'mcp:admin'],
      tokenType,
      scopedToOrg,
      // Match production: only OAuth tokens issued without an org-pin can do
      // cross-org reads via `client.org()`.
      allowCrossOrg: tokenType === 'oauth' && !scopedToOrg,
    };
    return new TestApiClient({ ...DEFAULT_TEST_ENV, ...env }, ctx);
  }

  /**
   * Override auth on a fresh client without re-creating fixtures. Useful for
   * verifying that a member role downgrade or scope removal blocks an action.
   * Synchronous because workspace init is already cached after `.for()`.
   */
  withAuth(overrides: Partial<TestClientAuth>): TestApiClient {
    const tokenType =
      overrides.tokenType ??
      this.ctx.tokenType ??
      (this.ctx.userId !== null ? ('oauth' as TokenType) : ('anonymous' as TokenType));
    const scopedToOrg = overrides.scopedToOrg ?? this.ctx.scopedToOrg ?? true;
    const ctx: ToolContext = {
      organizationId: overrides.organizationId ?? this.ctx.organizationId,
      userId: overrides.userId !== undefined ? overrides.userId : this.ctx.userId,
      memberRole:
        overrides.memberRole !== undefined
          ? overrides.memberRole
          : this.ctx.memberRole,
      agentId: overrides.agentId ?? this.ctx.agentId ?? null,
      isAuthenticated:
        overrides.userId !== undefined ? overrides.userId !== null : this.ctx.isAuthenticated,
      clientId: this.ctx.clientId ?? null,
      scopes: overrides.scopes ?? this.ctx.scopes ?? null,
      tokenType,
      scopedToOrg,
      allowCrossOrg: tokenType === 'oauth' && !scopedToOrg,
    };
    return new TestApiClient(this.env, ctx);
  }
}
