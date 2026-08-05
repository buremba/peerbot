/**
 * `resolveActiveChatConnectionTenant` — the second identity key used by the
 * admin-tools authorization path.
 *
 * Slack Grid keys the linked Slack identity on the enterprise `E…` while inbound
 * events carry the workspace `T…`, so the grant path resolves a connection's
 * `external_tenant_id` and retries the identity lookup under it. That makes this
 * read PRIVILEGE-ADJACENT: a row returned here widens an authz lookup, so the
 * predicate must stay narrow — scoped to (org, slug, connector) and LIVE rows
 * only. These tests pin each half of that predicate against real Postgres.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveActiveChatConnectionTenant } from '../../../lobu/stores/connections-projection';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestOrganization,
  insertChatConnectionRow,
} from '../../setup/test-fixtures';

const SLUG = 'slackinst-tenant-probe';
const BYO_ID = 'tenant-probe-byo';
const ENTERPRISE = 'E_GRID_TENANT';

describe('resolveActiveChatConnectionTenant', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('returns the external_tenant_id of a live slack connection', async () => {
    const org = await createTestOrganization();
    await insertChatConnectionRow({
      id: SLUG,
      organizationId: org.id,
      platform: 'slack',
      status: 'active',
      metadata: { teamId: ENTERPRISE },
    });

    const tenant = await resolveActiveChatConnectionTenant(
      getTestDb(),
      org.id,
      SLUG,
      'slack'
    );

    expect(tenant).toBe(ENTERPRISE);
  });

  it('maps a BYO runtime connection id to its agentconn- slug', async () => {
    const org = await createTestOrganization();
    await insertChatConnectionRow({
      id: BYO_ID,
      organizationId: org.id,
      platform: 'slack',
      status: 'active',
      metadata: { teamId: ENTERPRISE },
    });

    const tenant = await resolveActiveChatConnectionTenant(
      getTestDb(),
      org.id,
      BYO_ID,
      'slack'
    );

    expect(tenant).toBe(ENTERPRISE);
  });

  it('returns null for a PAUSED install — it lingers for token refresh and is not live', async () => {
    const org = await createTestOrganization();
    await insertChatConnectionRow({
      id: SLUG,
      organizationId: org.id,
      platform: 'slack',
      status: 'paused',
      metadata: { teamId: ENTERPRISE },
    });

    const tenant = await resolveActiveChatConnectionTenant(
      getTestDb(),
      org.id,
      SLUG,
      'slack'
    );

    expect(tenant).toBeNull();
  });

  it('does not leak another org’s tenant for the same slug', async () => {
    // Slug reuse across tenants must never let org B supply org A's alternate
    // team key — that would widen the admin-tool grant across an org boundary.
    const orgA = await createTestOrganization();
    const orgB = await createTestOrganization();
    await insertChatConnectionRow({
      id: SLUG,
      organizationId: orgB.id,
      platform: 'slack',
      status: 'active',
      metadata: { teamId: ENTERPRISE },
    });

    const tenant = await resolveActiveChatConnectionTenant(
      getTestDb(),
      orgA.id,
      SLUG,
      'slack'
    );

    expect(tenant).toBeNull();
  });

  it('does not match a different connector on the same slug', async () => {
    const org = await createTestOrganization();
    await insertChatConnectionRow({
      id: SLUG,
      organizationId: org.id,
      platform: 'telegram',
      status: 'active',
      metadata: { teamId: ENTERPRISE },
    });

    const tenant = await resolveActiveChatConnectionTenant(
      getTestDb(),
      org.id,
      SLUG,
      'slack'
    );

    expect(tenant).toBeNull();
  });

  it('does not accept a data-connector row with the same connector and slug', async () => {
    const org = await createTestOrganization();
    await insertChatConnectionRow({
      id: BYO_ID,
      organizationId: org.id,
      platform: 'slack',
      status: 'active',
      metadata: { teamId: ENTERPRISE },
    });
    await getTestDb()`
      UPDATE connections SET credential_mode = NULL
      WHERE organization_id = ${org.id} AND slug = ${`agentconn-${BYO_ID}`}
    `;

    const tenant = await resolveActiveChatConnectionTenant(
      getTestDb(),
      org.id,
      BYO_ID,
      'slack'
    );

    expect(tenant).toBeNull();
  });

  it('returns null when a soft-deleted row is the only match', async () => {
    const org = await createTestOrganization();
    await insertChatConnectionRow({
      id: SLUG,
      organizationId: org.id,
      platform: 'slack',
      status: 'active',
      metadata: { teamId: ENTERPRISE },
    });
    await getTestDb()`
      UPDATE connections SET deleted_at = now()
      WHERE organization_id = ${org.id} AND slug = ${SLUG}
    `;

    const tenant = await resolveActiveChatConnectionTenant(
      getTestDb(),
      org.id,
      SLUG,
      'slack'
    );

    expect(tenant).toBeNull();
  });
});
