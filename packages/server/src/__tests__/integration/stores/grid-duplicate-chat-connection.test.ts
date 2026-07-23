/**
 * One Slack Grid workspace must never hold TWO active `connections` rows.
 *
 * `connections_active_chat_tenant` is unique on
 * `(organization_id, connector_key, external_tenant_id)`, and the sibling demote
 * in `upsertChatConnectionProjection` matched on that same exact value. But a
 * Grid workspace can legitimately be recorded under EITHER id:
 *   - the enterprise id (`E…`) — an org-wide install, or
 *   - the workspace id (`T…`) — a per-workspace install
 * Those are different strings, so the index sees two distinct tenants and the
 * demote never matched. Re-installing an already-installed Grid workspace under
 * the other key therefore left BOTH rows active, and inbound events can match
 * either — with different connection ids, which is exactly the ambiguity the
 * Builder admin grant resolves against.
 *
 * Observed in prod 2026-07-23: connections 430 (`E0BDSKL1KJL`) and 448
 * (`T0BCYB6JV3L`) were both active for LobuSandbox until one was explicitly
 * deleted. Nothing reconciles it automatically.
 *
 * These tests drive `upsertSlackInstallByTeam` — the REAL OAuth writer — rather
 * than hand-building a `StoredConnection`. That matters: the projection's
 * metadata is constructed inside that function, so a test that supplies its own
 * metadata can pass while the production path never populates the fields the
 * reconciliation depends on (exactly the dead-code failure this test now guards).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { upsertSlackInstallByTeam } from '../../../lobu/stores/slack-installations';
import { createPostgresAppInstallationStore } from '../../../lobu/stores/app-installation-store';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';

const ENTERPRISE_ID = 'E_GRID_DUP';
const WORKSPACE_ID = 'T_GRID_DUP';
const SIBLING_ID = 'T_GRID_SIBLING';

/** In-memory secret store — the install path persists the bot token first. */
function memorySecretStore() {
  const secrets = new Map<string, string>();
  return {
    async get(key: string) {
      return secrets.get(key) ?? null;
    },
    async put(key: string, value: string) {
      secrets.set(key, value);
      return `secret://${key}`;
    },
    async delete(key: string) {
      secrets.delete(key);
    },
  } as never;
}

/** Run the REAL Slack OAuth install/reinstall writer. */
async function installSlackWorkspace(opts: {
  orgId: string;
  teamId: string;
  enterpriseId?: string | null;
  isEnterpriseInstall?: boolean;
  teamName?: string;
}): Promise<void> {
  await upsertSlackInstallByTeam(
    createPostgresAppInstallationStore(),
    memorySecretStore(),
    opts.orgId,
    opts.teamId,
    {
      teamName: opts.teamName ?? 'LobuSandbox',
      botUserId: 'B_BOT',
      botToken: 'xoxb-test-token',
      installerUserId: 'U_INSTALLER',
      enterpriseId: opts.enterpriseId ?? null,
      isEnterpriseInstall: opts.isEnterpriseInstall,
    },
  );
}

async function liveTenants(orgId: string): Promise<string[]> {
  const rows = await getTestDb()<{ external_tenant_id: string }>`
    SELECT external_tenant_id FROM connections
    WHERE organization_id = ${orgId} AND connector_key = 'slack'
      AND deleted_at IS NULL AND status = 'active'
    ORDER BY external_tenant_id
  `;
  return rows.map((r) => r.external_tenant_id);
}

describe('Slack Grid — one active connection per workspace', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('projects the Grid identity onto the connection (guards the reconciliation input)', async () => {
    const org = await createTestOrganization();
    await installSlackWorkspace({
      orgId: org.id,
      teamId: WORKSPACE_ID,
      enterpriseId: ENTERPRISE_ID,
      isEnterpriseInstall: true,
    });

    // Without these fields on the REAL projection, the reconciliation below is
    // dead code in production no matter how the demote SQL is written.
    const [row] = await getTestDb()<{ ent: string | null; org_wide: string | null }>`
      SELECT config->'chatMetadata'->>'enterpriseId' AS ent,
             config->'chatMetadata'->>'isEnterpriseInstall' AS org_wide
      FROM connections
      WHERE organization_id = ${org.id} AND external_tenant_id = ${WORKSPACE_ID}
    `;
    expect(row.ent).toBe(ENTERPRISE_ID);
    expect(row.org_wide).toBe('true');
  });

  it('T… reinstall retires the enterprise-keyed row for the same workspace', async () => {
    const org = await createTestOrganization();
    // 1. Org-wide Grid install recorded under the ENTERPRISE id (prod conn 430).
    await installSlackWorkspace({
      orgId: org.id,
      teamId: ENTERPRISE_ID,
      enterpriseId: ENTERPRISE_ID,
      isEnterpriseInstall: true,
    });
    expect(await liveTenants(org.id)).toEqual([ENTERPRISE_ID]);

    // 2. Re-install the SAME workspace under the WORKSPACE id (prod conn 448).
    await installSlackWorkspace({
      orgId: org.id,
      teamId: WORKSPACE_ID,
      enterpriseId: ENTERPRISE_ID,
      isEnterpriseInstall: true,
    });

    expect(await liveTenants(org.id)).toEqual([WORKSPACE_ID]);
  });

  it('E… org-wide install retires the per-workspace rows it covers', async () => {
    const org = await createTestOrganization();
    // The reverse order must reconcile too.
    await installSlackWorkspace({
      orgId: org.id,
      teamId: WORKSPACE_ID,
      enterpriseId: ENTERPRISE_ID,
    });
    await installSlackWorkspace({
      orgId: org.id,
      teamId: ENTERPRISE_ID,
      enterpriseId: ENTERPRISE_ID,
      isEnterpriseInstall: true,
    });

    expect(await liveTenants(org.id)).toEqual([ENTERPRISE_ID]);
  });

  it('keeps independent per-workspace installs of one enterprise separate', async () => {
    const org = await createTestOrganization();
    // Two DIFFERENT sibling workspaces, each a PER-WORKSPACE install. Neither is
    // org-wide, so they must coexist — collapsing them would break Grid orgs
    // that intentionally connect several workspaces.
    await installSlackWorkspace({
      orgId: org.id,
      teamId: WORKSPACE_ID,
      enterpriseId: ENTERPRISE_ID,
      teamName: 'Team A',
    });
    await installSlackWorkspace({
      orgId: org.id,
      teamId: SIBLING_ID,
      enterpriseId: ENTERPRISE_ID,
      teamName: 'Team B',
    });

    expect(await liveTenants(org.id)).toEqual([WORKSPACE_ID, SIBLING_ID]);
  });

  it('a plain (non-Grid) workspace is unaffected', async () => {
    const org = await createTestOrganization();
    await installSlackWorkspace({ orgId: org.id, teamId: 'T_PLAIN_A' });
    await installSlackWorkspace({ orgId: org.id, teamId: 'T_PLAIN_B' });

    expect(await liveTenants(org.id)).toEqual(['T_PLAIN_A', 'T_PLAIN_B']);
  });

  it('still demotes an exact same-tenant sibling (existing behaviour)', async () => {
    const org = await createTestOrganization();
    await installSlackWorkspace({ orgId: org.id, teamId: WORKSPACE_ID });
    await installSlackWorkspace({ orgId: org.id, teamId: WORKSPACE_ID });

    expect(await liveTenants(org.id)).toEqual([WORKSPACE_ID]);
  });
});
