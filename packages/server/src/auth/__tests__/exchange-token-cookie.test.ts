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

// The Owletto extension embeds owletto-web as a cross-site iframe (top-level
// chrome-extension://). Lax cookies are withheld there, so the deep-link cookie
// posture differs by entry point: the extension iframe (POST, set inside its
// own partition) needs CHIPS Partitioned; SameSite=None; the CLI/menu-bar
// first-party deep-link (GET, top-level tab) keeps Lax. See auth/routes.ts.
describe('exchange-token cookie posture', () => {
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

  it('POST mints a CHIPS partitioned cross-site cookie (extension iframe)', async () => {
    const token = await patForNewUser('xt-post-org', 'xt-post@test.example.com');
    const res = await postForm('/api/exchange-token', { token, next: '/#worker=abc' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/#worker=abc');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/SameSite=None/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/Partitioned/i);
  });

  it('POST resolves an OAuth device-code access token (cloud pairing path)', async () => {
    // The extension's cloud (OAuth device-code) pairing stores an oauth_tokens
    // access token, NOT an owl_pat_ PAT — exchange-token must resolve it or the
    // cloud iframe 401s and renders signed-out.
    const org = await createTestOrganization({ slug: 'xt-oauth-org' });
    const user = await createTestUser({ email: 'xt-oauth@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await createTestOAuthClient();
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id, {
      scope: 'profile:read',
    });
    expect(token.startsWith('owl_pat_')).toBe(false); // genuinely an OAuth access token

    const res = await postForm('/api/exchange-token', { token, next: '/' });
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Partitioned/i);
  });

  it('GET keeps a first-party Lax cookie — never Partitioned/None (CLI/menu-bar)', async () => {
    const token = await patForNewUser('xt-get-org', 'xt-get@test.example.com');
    const res = await get(`/api/exchange-token?token=${encodeURIComponent(token)}&next=/`);

    expect(res.status).toBe(302);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Partitioned/i);
    expect(cookie).not.toMatch(/SameSite=None/i);
  });

  it('rejects a missing or invalid token', async () => {
    expect((await postForm('/api/exchange-token', { next: '/' })).status).toBe(400);
    expect((await postForm('/api/exchange-token', { token: 'owl_pat_nope', next: '/' })).status).toBe(401);
  });

  it('serves the in-iframe bootstrap page (POSTs the token, strips the fragment)', async () => {
    const res = await get('/api/extension-bootstrap');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/text\/html/i);
    const html = await res.text();
    expect(html).toContain('/api/exchange-token');
    expect(html).toContain('location.hash');
    expect(html).toContain('replaceState');
  });
});
