/**
 * Reproducer + regression coverage for the Claude "Login with Claude" OAuth
 * `invalid_grant: Invalid 'redirect_uri'` prod failure.
 *
 * The org-scoped SPA handlers in lobu/agent-routes.ts run a PKCE
 * authorization-code flow across two requests:
 *
 *   GET  /:agentId/providers/claude/oauth/start  → 302 to Anthropic's authorize
 *        URL, built by `OAuthClient.buildAuthUrl` (redirect_uri =
 *        CLAUDE_PROVIDER.redirectUri = https://platform.claude.com/oauth/code/callback)
 *   POST /:agentId/providers/claude/oauth/code   → exchanges the pasted
 *        `code#state` at Anthropic's token endpoint
 *
 * RFC 6749 §4.1.3 requires the `redirect_uri` sent at the token exchange to be
 * byte-identical to the one used at authorize. The /code handler used to pass a
 * hardcoded `https://console.anthropic.com/oauth/code/callback` override —
 * a DIFFERENT host from what /start sent — so Anthropic rejected every exchange
 * with `invalid_grant: Invalid 'redirect_uri'`. (The earlier form-encoding fix
 * in #1305 only made the form parse far enough for Anthropic to read, and then
 * reject, the mismatched value.)
 *
 * This test drives BOTH real handlers through the Hono app with a mocked token
 * endpoint and asserts the exchange's redirect_uri equals the one /start sent —
 * the invariant the override violated. With the override removed it passes;
 * with the override restored it fails (the captured exchange redirect_uri is
 * console.anthropic.com, the authorize one is platform.claude.com).
 *
 * Uses the embedded Postgres gateway test harness (real oauth_states +
 * agents rows); the only network call (the token exchange) is mocked.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';
import { orgContext } from '../stores/org-context';
import {
  authStash,
  coreServicesStash,
  installRouteTestMocks,
} from './helpers/route-test-mocks';
import {
  buildRealClaudeAuthStack,
  type RealClaudeAuthStack,
} from './helpers/real-claude-auth-stack';

installRouteTestMocks();

const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const ORG = 'org-oauth';
const AGENT = 'oauth-agent';
const USER = 'u1';

const EXPECTED_REDIRECT_URI =
  'https://platform.claude.com/oauth/code/callback';

const realFetch = globalThis.fetch;

beforeAll(async () => {
  await ensureDbForGatewayTests();
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
}, 60_000);

async function importAgentRoutes() {
  const mod = await import('../agent-routes.js');
  return mod.agentRoutes;
}

async function seedOrgAndAgent(): Promise<void> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG}, ${ORG}, ${ORG})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO agents (id, organization_id, name)
    VALUES (${AGENT}, ${ORG}, ${AGENT})
    ON CONFLICT (organization_id, id) DO NOTHING
  `;
}

/** Captures the body POSTed to Anthropic's token endpoint, returns a fake
 *  token. Every other URL falls through to the real fetch. */
function installTokenEndpointMock(captured: {
  url?: string;
  contentType?: string | null;
  body?: string;
}): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('platform.claude.com') && url.includes('/oauth/token')) {
      captured.url = url;
      captured.contentType = init?.headers?.['Content-Type'] ?? null;
      captured.body = typeof init?.body === 'string' ? init.body : '';
      return new Response(
        JSON.stringify({
          access_token: 'sk-ant-oat01-test-access',
          refresh_token: 'sk-ant-ort01-test-refresh',
          token_type: 'Bearer',
          expires_in: 28800,
          scope: 'user:inference',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

describe('Claude OAuth redirect_uri must match between authorize and exchange', () => {
  let stack: RealClaudeAuthStack;

  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrgAndAgent();
    authStash.user = {
      id: USER,
      name: 'Test',
      email: 'u1@test',
      emailVerified: true,
    };
    authStash.organizationId = ORG;
    authStash.authSource = 'session';
    authStash.mcpAuthInfo = null;

    // Use the REAL AuthProfilesManager (DB-backed) so the genuine
    // `upsertProfile` userId guard runs — not a fake mirroring it. This is what
    // makes the test fail for the same reason prod did (lobu #1321).
    stack = await orgContext.run({ organizationId: ORG }, () =>
      buildRealClaudeAuthStack()
    );
    coreServicesStash.services = {
      getOAuthStateStore: () => stack.oauthStateStore,
      getAuthProfilesManager: () => stack.authProfilesManager,
    };
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    coreServicesStash.services = null;
    // Stop the SSE fanout / queue listeners the real CoreServices started so
    // they don't leak into later tests sharing the Bun process.
    await stack?.shutdown();
  });

  test('exchange reuses the authorize redirect_uri (no console.anthropic.com override)', async () => {
    const captured: {
      url?: string;
      contentType?: string | null;
      body?: string;
    } = {};
    installTokenEndpointMock(captured);

    const app = await importAgentRoutes();

    // 1. /start → 302 to Anthropic authorize; pull redirect_uri + state from it.
    const startRes = await app.request(
      `/${AGENT}/providers/claude/oauth/start`,
      { method: 'GET' }
    );
    expect(startRes.status).toBe(302);
    const authorizeUrl = new URL(startRes.headers.get('location')!);
    const authorizeRedirectUri = authorizeUrl.searchParams.get('redirect_uri');
    const state = authorizeUrl.searchParams.get('state');
    expect(authorizeRedirectUri).toBe(EXPECTED_REDIRECT_URI);
    expect(state).toBeTruthy();

    // 2. /code with the pasted `code#state` → token exchange.
    const codeRes = await app.request(
      `/${AGENT}/providers/claude/oauth/code`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: `fake-auth-code#${state}` }),
      }
    );
    expect(codeRes.status).toBe(200);
    expect(await codeRes.json()).toEqual({ success: true });

    // The exchange must have been form-encoded (RFC 6749) and carried the SAME
    // redirect_uri the authorize step used — this is the invariant the old
    // hardcoded console.anthropic.com override violated.
    expect(captured.contentType).toBe('application/x-www-form-urlencoded');
    const exchangeParams = new URLSearchParams(captured.body ?? '');
    expect(exchangeParams.get('redirect_uri')).toBe(authorizeRedirectUri);
    expect(exchangeParams.get('redirect_uri')).toBe(EXPECTED_REDIRECT_URI);

    // The credential was actually persisted via the REAL AuthProfilesManager,
    // scoped to the authenticated session user. Read it back through the same
    // manager (under the agent's org) — if the route had omitted `userId`, the
    // real upsertProfile guard would have thrown and the request would have
    // 400'd above, so reaching a stored profile here is the genuine proof.
    const stored = await orgContext.run({ organizationId: ORG }, () =>
      stack.authProfilesManager.getProviderProfiles(AGENT, 'claude', USER)
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      provider: 'claude',
      authType: 'oauth',
    });
    expect(stored[0]?.credential).toBe('sk-ant-oat01-test-access');
  });
});
