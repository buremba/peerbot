/**
 * GrantStore org scoping — fail closed, never answer for every tenant.
 *
 * `orgScope(sql, orgId)` used to accept null/undefined and return an EMPTY SQL
 * fragment, so a caller with no organization silently dropped the tenant
 * predicate: every read answered across all orgs, and `revoke`'s DELETE removed
 * matching grants in every org at once. Nothing signalled it — no error, no log.
 *
 * `agents_pkey` is `PRIMARY KEY (organization_id, id)`, so an agent id is unique
 * only WITHIN an org — a shared slug like `lobu-builder` exists in many orgs at
 * once, which is exactly what made the unscoped query dangerous rather than
 * merely wrong.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GrantStore } from '../../gateway/permissions/grant-store';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';

const sql = getTestDb();

// The same agent id in two orgs — legal, because the PK is composite.
const AGENT_ID = 'lobu-builder';

/**
 * `grants` is FK'd to `agents(organization_id, id)`, so the agent must exist in
 * each org — which is the whole point: the SAME id legitimately exists in both,
 * because `agents_pkey` is `(organization_id, id)`.
 */
async function seedAgent(orgId: string) {
  await sql`
    INSERT INTO agents (organization_id, id, name)
    VALUES (${orgId}, ${AGENT_ID}, 'Builder')
    ON CONFLICT DO NOTHING
  `;
}

async function seedGrant(orgId: string, pattern: string, denied = false) {
  await sql`
    INSERT INTO grants (organization_id, agent_id, kind, pattern, granted_at, denied)
    VALUES (${orgId}, ${AGENT_ID}, 'domain', ${pattern}, NOW(), ${denied})
  `;
}

describe('GrantStore org scoping', () => {
  let orgA: string;
  let orgB: string;
  let store: GrantStore;

  beforeEach(async () => {
    orgA = (await createTestOrganization()).id;
    orgB = (await createTestOrganization()).id;
    await seedAgent(orgA);
    await seedAgent(orgB);
    store = new GrantStore();
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('does not see another org grant for the same agent id', async () => {
    await seedGrant(orgB, 'evil.example.com');

    // Org A never granted this domain. Unscoped, org B's grant would satisfy it.
    expect(await store.hasGrant(AGENT_ID, 'evil.example.com', orgA)).toBe(false);
    expect(await store.hasGrant(AGENT_ID, 'evil.example.com', orgB)).toBe(true);
  });

  it('lists only the calling org grants', async () => {
    await seedGrant(orgA, 'a.example.com');
    await seedGrant(orgB, 'b.example.com');

    const a = await store.listGrants(AGENT_ID, orgA);
    expect(a.map((g) => g.pattern)).toEqual(['a.example.com']);
  });

  it('revoke never deletes another org grant', async () => {
    await seedGrant(orgA, 'shared.example.com');
    await seedGrant(orgB, 'shared.example.com');

    await store.revoke(AGENT_ID, 'shared.example.com', orgA);

    // Org B's grant must survive — an unscoped DELETE would take both.
    expect(await store.listGrants(AGENT_ID, orgA)).toHaveLength(0);
    expect(await store.listGrants(AGENT_ID, orgB)).toHaveLength(1);
  });

  it('isDenied does not inherit another org deny', async () => {
    await seedGrant(orgB, 'blocked.example.com', true);
    expect(await store.isDenied(AGENT_ID, 'blocked.example.com', orgA)).toBe(false);
  });

  /**
   * The behavioural core of the change: with no org, these throw instead of
   * running unscoped. Previously each returned an all-tenant answer.
   */
  it('throws rather than running unscoped when no org can be resolved', async () => {
    await expect(store.hasGrant(AGENT_ID, 'x.example.com')).rejects.toThrow(
      /GrantStore\.hasGrant requires organizationId/
    );
    await expect(store.listGrants(AGENT_ID)).rejects.toThrow(
      /GrantStore\.listGrants requires organizationId/
    );
    await expect(store.isDenied(AGENT_ID, 'x.example.com')).rejects.toThrow(
      /GrantStore\.isDenied requires organizationId/
    );
    await expect(store.revoke(AGENT_ID, 'x.example.com')).rejects.toThrow(
      /GrantStore\.revoke requires organizationId/
    );
  });
});
