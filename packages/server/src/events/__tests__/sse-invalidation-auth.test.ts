import { encrypt } from '@lobu/core';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { initWorkspaceProvider } from '../../workspace';
import { invalidationSseAuth } from '../sse-invalidation-auth';

// The embedded panel opens GET /api/:orgSlug/events with EventSource (no
// Authorization header, no usable cookie) and a ?token= ticket. invalidationSseAuth
// must resolve that ticket to a member of the org and set organizationId; anything
// else falls through to mcpAuth (cookie / Bearer / nothing).
const ticket = (userId: string, exp = Date.now() + 60_000): string =>
  encrypt(JSON.stringify({ userId, platform: 'external', exp }));

function makeApp() {
  const app = new Hono();
  app.get('/api/:orgSlug/events', invalidationSseAuth, (c) => {
    const orgId = (c.get as (k: string) => unknown)('organizationId');
    if (!orgId) return c.json({ ok: false }, 401);
    return c.json({ ok: true, organizationId: orgId });
  });
  return app;
}

const getEvents = async (slug: string, query: string) =>
  makeApp().request(`/api/${slug}/events${query}`, { method: 'GET' });

describe('invalidationSseAuth (embedded SSE ticket)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    await initWorkspaceProvider(); // mcpAuth fallback path needs the provider
  });

  it('a ticket for an org member resolves the organization and passes', async () => {
    const org = await createTestOrganization({ slug: 'inv-member-org' });
    const user = await createTestUser({ email: 'inv-member@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const res = await getEvents('inv-member-org', `?token=${encodeURIComponent(ticket(user.id))}`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { organizationId: string }).toEqual({
      ok: true,
      organizationId: org.id,
    });
  });

  it('a ticket for a NON-member does not resolve the org (falls through, not 200)', async () => {
    const org = await createTestOrganization({ slug: 'inv-nonmember-org' });
    const outsider = await createTestUser({ email: 'inv-outsider@test.example.com' });
    // outsider is intentionally NOT added to the org.

    const res = await getEvents(
      'inv-nonmember-org',
      `?token=${encodeURIComponent(ticket(outsider.id))}`
    );
    expect(res.status).not.toBe(200);
  });

  it('a member of org A cannot open org B\'s stream with their ticket (cross-org isolation)', async () => {
    const orgA = await createTestOrganization({ slug: 'inv-org-a' });
    const orgB = await createTestOrganization({ slug: 'inv-org-b' });
    const user = await createTestUser({ email: 'inv-cross@test.example.com' });
    await addUserToOrganization(user.id, orgA.id, 'owner'); // member of A only

    // Their valid ticket, pointed at org B's slug → membership check fails → not 200.
    const res = await getEvents('inv-org-b', `?token=${encodeURIComponent(ticket(user.id))}`);
    expect(res.status).not.toBe(200);
    expect(orgB.id).not.toBe(orgA.id);
  });

  it('no ticket falls through to mcpAuth (not 200 without a cookie/bearer)', async () => {
    await createTestOrganization({ slug: 'inv-noticket-org' });
    const res = await getEvents('inv-noticket-org', '');
    expect(res.status).not.toBe(200);
  });

  it('a tampered ticket falls through (not 200)', async () => {
    await createTestOrganization({ slug: 'inv-garbage-org' });
    const res = await getEvents('inv-garbage-org', '?token=not-a-real-ticket');
    expect(res.status).not.toBe(200);
  });

  it('an expired ticket does not resolve the org (not 200)', async () => {
    const org = await createTestOrganization({ slug: 'inv-expired-org' });
    const user = await createTestUser({ email: 'inv-expired@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const res = await getEvents(
      'inv-expired-org',
      `?token=${encodeURIComponent(ticket(user.id, Date.now() - 1000))}`
    );
    expect(res.status).not.toBe(200);
  });
});
