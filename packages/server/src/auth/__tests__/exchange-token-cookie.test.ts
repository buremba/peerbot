import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { get, postForm } from '../../__tests__/setup/test-helpers';

// Two deep-link entry points, two postures:
//   - GET /exchange-token: first-party tab (CLI/menu-bar) → Lax session cookie.
//   - POST /extension-session: the Owletto extension's cross-site iframe
//     (top-level chrome-extension://) can't depend on a cookie, so it gets the
//     raw Better Auth session token in the body and sends it as Bearer.
// See auth/routes.ts.
describe('deep-link token exchange', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  async function patForNewUser(slug: string, email: string): Promise<string> {
    const org = await createTestOrganization({ slug });
    const user = await createTestUser({ email });
    await addUserToOrganization(user.id, org.id, 'owner');
    const { token } = await createTestPAT(user.id, org.id, { scope: 'profile:read' });
    return token;
  }

  it('POST /extension-session returns a session token for Bearer use (extension iframe)', async () => {
    const token = await patForNewUser('xt-post-org', 'xt-post@test.example.com');
    const res = await postForm('/api/extension-session', { token });

    expect(res.status).toBe(200);
    // No cookie is set — the iframe authenticates via the returned token.
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = (await res.json()) as { session_token?: string };
    expect(typeof body.session_token).toBe('string');
    expect((body.session_token ?? '').length).toBeGreaterThan(0);
  });

  it('POST /extension-session resolves an OAuth device-code access token (cloud pairing path)', async () => {
    // The extension's cloud (OAuth device-code) pairing stores an oauth_tokens
    // access token, NOT an owl_pat_ PAT — the endpoint must resolve it or the
    // cloud iframe 401s and renders signed-out.
    const org = await createTestOrganization({ slug: 'xt-oauth-org' });
    const user = await createTestUser({ email: 'xt-oauth@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await createTestOAuthClient();
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id, {
      scope: 'profile:read',
    });
    expect(token.startsWith('owl_pat_')).toBe(false); // genuinely an OAuth access token

    const res = await postForm('/api/extension-session', { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session_token?: string };
    expect((body.session_token ?? '').length).toBeGreaterThan(0);
  });

  it('GET /exchange-token keeps a first-party Lax cookie — never Partitioned/None (CLI/menu-bar)', async () => {
    const token = await patForNewUser('xt-get-org', 'xt-get@test.example.com');
    const res = await get(`/api/exchange-token?token=${encodeURIComponent(token)}&next=/`);

    expect(res.status).toBe(302);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Partitioned/i);
    expect(cookie).not.toMatch(/SameSite=None/i);
  });

  it('rejects a missing or invalid token', async () => {
    expect((await postForm('/api/extension-session', {})).status).toBe(400);
    expect((await postForm('/api/extension-session', { token: 'owl_pat_nope' })).status).toBe(401);
  });

  it('serves the in-iframe bootstrap page (exchanges the token, strips the fragment)', async () => {
    const res = await get('/api/extension-bootstrap');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/text\/html/i);
    const html = await res.text();
    expect(html).toContain('/api/extension-session');
    expect(html).toContain('sessionStorage');
    expect(html).toContain('location.hash');
    expect(html).toContain('replaceState');
  });

  // The load-bearing claim: the session token from /extension-session, sent as
  // `Authorization: Bearer`, authenticates the user on a real protected route
  // via the same `getSession({ headers })` path the cloud auth bridge uses (the
  // bearer() plugin honours the header). This is what makes the embedded iframe
  // work without a cookie.
  it('Bearer session token authenticates the user on a protected API route (e2e)', async () => {
    const slug = 'xt-bearer-org';
    const org = await createTestOrganization({ slug });
    const user = await createTestUser({ email: 'xt-bearer@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const { token: pat } = await createTestPAT(user.id, org.id, { scope: 'profile:read' });

    // Exchange the extension's deep-link token for a session token.
    const exchange = await postForm('/api/extension-session', { token: pat });
    expect(exchange.status).toBe(200);
    const { session_token: sessionToken } = (await exchange.json()) as {
      session_token: string;
    };
    expect(sessionToken.length).toBeGreaterThan(0);

    // Sent as Bearer, it resolves the user — the org they belong to is returned.
    const authed = await get('/api/organizations', { token: sessionToken });
    expect(authed.status).toBe(200);
    const authedSlugs = ((await authed.json()).organizations as Array<{ slug: string }>).map(
      (o) => o.slug
    );
    expect(authedSlugs).toContain(slug);

    // Without it, the same user-scoped org is not resolved.
    const anon = await get('/api/organizations');
    const anonSlugs = ((await anon.json()).organizations as Array<{ slug: string }>).map(
      (o) => o.slug
    );
    expect(anonSlugs).not.toContain(slug);
  });
});
