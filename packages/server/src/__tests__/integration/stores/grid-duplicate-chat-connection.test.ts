/**
 * One Slack Grid workspace must never hold TWO active `connections` rows.
 *
 * `connections_active_chat_tenant` is unique on
 * `(organization_id, connector_key, external_tenant_id)`, and the sibling demote
 * in `upsertChatConnectionProjection` matches on that same exact value. But a
 * Grid workspace can legitimately be recorded under EITHER id:
 *   - the enterprise id (`E…`) — an org-wide install, or
 *   - the workspace id (`T…`) — a per-workspace install
 * Those are different strings, so the index sees two distinct tenants and the
 * demote never matches. Re-installing an already-installed Grid workspace under
 * the other key therefore leaves BOTH rows active, and inbound events can match
 * either — with different connection ids, which is exactly the ambiguity the
 * Builder admin grant resolves against.
 *
 * Observed in prod 2026-07-23: connections 430 (`E0BDSKL1KJL`) and 448
 * (`T0BCYB6JV3L`) were both active for LobuSandbox for ~3m21s, until someone
 * explicitly deleted one. Nothing reconciles it automatically.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { upsertChatConnectionProjection } from '../../../lobu/stores/connections-projection';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';

const ENTERPRISE_ID = 'E_GRID_DUP';
const WORKSPACE_ID = 'T_GRID_DUP';

/** Upsert a managed Slack chat projection keyed on `tenantId`. */
async function installSlack(opts: {
  orgId: string;
  connectionId: string;
  tenantId: string;
  teamName?: string;
}): Promise<void> {
  const db = getTestDb();
  await db.begin(async (tx: typeof db) => {
    await upsertChatConnectionProjection(
      tx,
      (v) => db.json(v),
      {
        id: opts.connectionId,
        platform: 'slack',
        organizationId: opts.orgId,
        config: {},
        settings: { allowGroups: true },
        metadata: {
          teamId: opts.tenantId,
          teamName: opts.teamName ?? 'LobuSandbox',
          enterpriseId: ENTERPRISE_ID,
        },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never,
      opts.orgId,
      'managed',
      { preserveAgentId: true },
    );
  });
}

async function liveSlackRows(orgId: string) {
  return getTestDb()<{ slug: string; external_tenant_id: string; status: string }>`
    SELECT slug, external_tenant_id, status FROM connections
    WHERE organization_id = ${orgId} AND connector_key = 'slack'
      AND deleted_at IS NULL AND status = 'active'
    ORDER BY external_tenant_id
  `;
}

describe('Slack Grid — one active connection per workspace', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('reinstalling under the workspace id retires the enterprise-keyed row', async () => {
    const org = await createTestOrganization();

    // 1. Org-wide Grid install recorded under the ENTERPRISE id (prod conn 430).
    await installSlack({
      orgId: org.id,
      connectionId: 'slackinst-enterprise',
      tenantId: ENTERPRISE_ID,
    });
    expect(await liveSlackRows(org.id)).toHaveLength(1);

    // 2. Re-install the SAME workspace, now recorded under the WORKSPACE id
    //    (prod conn 448). Different `external_tenant_id` ⇒ the unique index and
    //    the sibling demote both miss.
    await installSlack({
      orgId: org.id,
      connectionId: 'slackinst-workspace',
      tenantId: WORKSPACE_ID,
    });

    // The same workspace must not end up with two live routing rows.
    const live = await liveSlackRows(org.id);
    expect(live.map((r) => r.external_tenant_id)).toEqual([WORKSPACE_ID]);
    expect(live).toHaveLength(1);
  });

  it('keeps independent workspaces of the same enterprise separate', async () => {
    const org = await createTestOrganization();
    // Two DIFFERENT sibling workspaces under one enterprise are legitimately
    // distinct installs — the fix must not collapse them.
    await installSlack({
      orgId: org.id,
      connectionId: 'slackinst-team-a',
      tenantId: 'T_SIBLING_A',
      teamName: 'Team A',
    });
    await installSlack({
      orgId: org.id,
      connectionId: 'slackinst-team-b',
      tenantId: 'T_SIBLING_B',
      teamName: 'Team B',
    });

    const live = await liveSlackRows(org.id);
    expect(live).toHaveLength(2);
  });

  it('still demotes an exact same-tenant sibling (existing behaviour)', async () => {
    const org = await createTestOrganization();
    await installSlack({
      orgId: org.id,
      connectionId: 'slackinst-first',
      tenantId: WORKSPACE_ID,
    });
    await installSlack({
      orgId: org.id,
      connectionId: 'slackinst-second',
      tenantId: WORKSPACE_ID,
    });

    const live = await liveSlackRows(org.id);
    expect(live).toHaveLength(1);
    expect(live[0].slug).toBe('slackinst-second');
  });
});
