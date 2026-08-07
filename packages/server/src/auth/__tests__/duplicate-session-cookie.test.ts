import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { get } from '../../__tests__/setup/test-helpers';

/**
 * A browser can hold the same auth cookie name twice — host-only
 * (`app.lobu.ai`) and domain-scoped (`Domain=.lobu.ai`) — and sends BOTH in one
 * `Cookie` header. Resolution is then decided by position, and the position is
 * not ours to choose:
 *
 *   RFC 6265 §5.4  browser sends equal-path cookies oldest-first
 *   better-call    parseCookies keeps the FIRST occurrence (`if (!cookies.has(key))`)
 *   better-auth    getSignedCookie reads that one and stops
 *
 * So a stale twin that happens to be older outranks every later sign-in, and
 * the user is locked out with no in-app escape — signing in again writes a
 * strictly NEWER cookie that can never win. Measured on prod 2026-08-06:
 * `dead; good` resolved to null while `good; dead` resolved to the session.
 *
 * These tests pin the cure: when the jar is ambiguous, resolve it deterministically
 * instead of trusting order.
 */
describe('duplicate session cookies', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  /**
   * Mint a real, correctly-signed session cookie the way a browser would get
   * one, and return both the cookie name and its signed value.
   */
  async function realSessionCookie(
    slug: string,
    email: string
  ): Promise<{ name: string; value: string }> {
    const org = await createTestOrganization({ slug });
    const user = await createTestUser({ email });
    await addUserToOrganization(user.id, org.id, 'owner');
    const { token: pat } = await createTestPAT(user.id, org.id, { scope: 'profile:read' });

    const res = await get(`/api/exchange-token?token=${encodeURIComponent(pat)}&next=/`);
    expect(res.status).toBe(302);

    const setCookie = res.headers
      .getSetCookie()
      .find((c) => /^(?:__Secure-)?better-auth\.session_token=[^;]/.test(c));
    expect(setCookie, 'exchange-token must set a session cookie').toBeTruthy();

    const [pair] = (setCookie as string).split(';');
    const eq = pair.indexOf('=');
    return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
  }

  async function orgSlugsFor(cookie: string): Promise<string[]> {
    const res = await get('/api/organizations', { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizations: Array<{ slug: string }> };
    return body.organizations.map((o) => o.slug);
  }

  // A garbage value that is a syntactically plausible signed cookie but cannot
  // verify — exactly what a stale twin looks like once its session is revoked.
  const DEAD = 'deadbeefdeadbeef.c2lnbmF0dXJlc2lnbmF0dXJlc2lnbmF0dXJlc2lnbmE=';

  it('authenticates when the live cookie is FIRST in the jar', async () => {
    const slug = 'dup-good-first';
    const { name, value } = await realSessionCookie(slug, 'dup-good-first@test.example.com');

    // Control: this direction has always worked, and proves the fixture is sound.
    expect(await orgSlugsFor(`${name}=${value}; ${name}=${DEAD}`)).toContain(slug);
  });

  it('authenticates when a DEAD twin is first — the permanent-brick case', async () => {
    const slug = 'dup-dead-first';
    const { name, value } = await realSessionCookie(slug, 'dup-dead-first@test.example.com');

    // The brick. Same two cookies, opposite order, and order is decided by the
    // browser's creation timestamps — not by anything we control. Before the
    // fix this resolved the dead cookie, returned no session, and no amount of
    // signing in again could recover it.
    expect(await orgSlugsFor(`${name}=${DEAD}; ${name}=${value}`)).toContain(slug);
  });

  it('stays unauthenticated when every candidate is dead', async () => {
    const slug = 'dup-all-dead';
    const { name } = await realSessionCookie(slug, 'dup-all-dead@test.example.com');

    // Resolving candidates must not become "authenticate on anything". With no
    // live token in the jar the answer is still no session.
    expect(await orgSlugsFor(`${name}=${DEAD}; ${name}=${DEAD}2`)).not.toContain(slug);
  });

  it('is unchanged for the ordinary single-cookie jar', async () => {
    const slug = 'dup-single';
    const { name, value } = await realSessionCookie(slug, 'dup-single@test.example.com');

    expect(await orgSlugsFor(`${name}=${value}`)).toContain(slug);
  });
});
