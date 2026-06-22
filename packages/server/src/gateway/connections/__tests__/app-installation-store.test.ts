/**
 * Real-Postgres tests for the generic app-installation store.
 *
 * The contract under test is the multi-replica routing + ownership model:
 *  - the shared webhook router resolves an active install by the provider tenant
 *    tuple alone (no org context) to the owning org + credential backing;
 *  - exactly ONE active install may own a tenant tuple — a second active insert
 *    for the same tuple is rejected by the partial unique index;
 *  - a different-org install TRANSFERS ownership (old -> inactive, new active);
 *  - revoked / suspended rows do NOT route;
 *  - concurrent upserts for the same tuple converge to a single active row.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../../db/client.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "../../__tests__/helpers/db-setup.js";

beforeAll(async () => {
  await ensureDbForGatewayTests();
}, 60_000);

beforeEach(async () => {
  await resetTestDatabase();
}, 30_000);

async function buildStore() {
  const { createPostgresAppInstallationStore } = await import(
    "../../../lobu/stores/app-installation-store.js"
  );
  return createPostgresAppInstallationStore();
}

/** Seed an org (via seedAgentRow) and an auth_profiles row; returns its id. */
async function seedAuthProfile(
  organizationId: string,
  slug: string
): Promise<number> {
  await seedAgentRow(`${organizationId}-agent`, { organizationId });
  const sql = getDb();
  const rows = await sql`
    INSERT INTO auth_profiles (
      organization_id, slug, display_name, connector_key,
      profile_kind, status, auth_data, provider, created_at, updated_at
    ) VALUES (
      ${organizationId}, ${slug}, ${slug}, 'github',
      'oauth_app', 'active', '{}'::jsonb, 'github', now(), now()
    )
    RETURNING id
  `;
  return Number(rows[0].id);
}

const GH = {
  provider: "github",
  providerInstance: "cloud",
  providerAppId: "lobu-app-1",
};

describe("AppInstallationStore", () => {
  test("resolveActiveByTenant resolves an active install to org + auth profile", async () => {
    const authProfileId = await seedAuthProfile("org-route", "gh-app");
    const store = await buildStore();

    const created = await store.upsert({
      organizationId: "org-route",
      ...GH,
      externalTenantId: "inst-100",
      authProfileId,
      metadata: { account: "acme" },
    });

    expect(created.status).toBe("active");
    expect(created.organizationId).toBe("org-route");

    // The webhook router keys on the tuple alone — no org context.
    const resolved = await store.resolveActiveByTenant({
      ...GH,
      externalTenantId: "inst-100",
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(created.id);
    expect(resolved?.organizationId).toBe("org-route");
    expect(resolved?.authProfileId).toBe(authProfileId);
    expect(resolved?.metadata.account).toBe("acme");
  });

  test("a second active install for the same tenant tuple is rejected by the unique index", async () => {
    await seedAgentRow("org-a-agent", { organizationId: "org-a" });
    const sql = getDb();

    await sql`
      INSERT INTO app_installations (
        organization_id, provider, provider_instance, provider_app_id,
        external_tenant_id, status
      ) VALUES (
        'org-a', ${GH.provider}, ${GH.providerInstance}, ${GH.providerAppId},
        'inst-dup', 'active'
      )
    `;

    // A raw second active row for the same tuple must violate the partial unique
    // index — this is the invariant the store leans on.
    let threw = false;
    try {
      await sql`
        INSERT INTO app_installations (
          organization_id, provider, provider_instance, provider_app_id,
          external_tenant_id, status
        ) VALUES (
          'org-a', ${GH.provider}, ${GH.providerInstance}, ${GH.providerAppId},
          'inst-dup', 'active'
        )
      `;
    } catch (err) {
      threw = true;
      expect((err as { code?: string }).code).toBe("23505");
    }
    expect(threw).toBe(true);
  });

  test("same-org reinstall updates in place (one active row, same id)", async () => {
    const first = await seedAuthProfile("org-same", "gh-app-1");
    const second = await seedAuthProfile("org-same", "gh-app-2");
    const store = await buildStore();

    const a = await store.upsert({
      organizationId: "org-same",
      ...GH,
      externalTenantId: "inst-200",
      authProfileId: first,
      metadata: { v: 1 },
    });
    const b = await store.upsert({
      organizationId: "org-same",
      ...GH,
      externalTenantId: "inst-200",
      authProfileId: second,
      metadata: { v: 2 },
    });

    expect(b.id).toBe(a.id);
    expect(b.authProfileId).toBe(second);
    expect(b.metadata.v).toBe(2);
    expect(await store.listByOrg("org-same")).toHaveLength(1);
  });

  test("different-org install transfers ownership (old -> suspended, new active)", async () => {
    await seedAgentRow("org-a2-agent", { organizationId: "org-a2" });
    await seedAgentRow("org-b2-agent", { organizationId: "org-b2" });
    const store = await buildStore();

    const a = await store.upsert({
      organizationId: "org-a2",
      ...GH,
      externalTenantId: "inst-300",
    });
    const b = await store.upsert({
      organizationId: "org-b2",
      ...GH,
      externalTenantId: "inst-300",
    });

    // Prior owner is demoted; new owner is the single active install.
    expect((await store.getById(a.id))?.status).toBe("suspended");
    expect((await store.getById(b.id))?.status).toBe("active");

    const resolved = await store.resolveActiveByTenant({
      ...GH,
      externalTenantId: "inst-300",
    });
    expect(resolved?.id).toBe(b.id);
    expect(resolved?.organizationId).toBe("org-b2");
  });

  test("A->B->A transfer reuses org A's row — no duplicate (org, tenant) rows", async () => {
    // Regression: a return transfer must REACTIVATE the original org-A row, not
    // insert a second one. Otherwise org A ends up with two rows for the same
    // install identity and listByOrg returns duplicate ids.
    await seedAgentRow("org-ra-agent", { organizationId: "org-ra" });
    await seedAgentRow("org-rb-agent", { organizationId: "org-rb" });
    const store = await buildStore();
    const sql = getDb();

    const a1 = await store.upsert({
      organizationId: "org-ra",
      ...GH,
      externalTenantId: "inst-aba",
      metadata: { external_id: "X" },
    });
    await store.upsert({
      organizationId: "org-rb",
      ...GH,
      externalTenantId: "inst-aba",
      metadata: { external_id: "X" },
    });
    const a2 = await store.upsert({
      organizationId: "org-ra",
      ...GH,
      externalTenantId: "inst-aba",
      metadata: { external_id: "X" },
    });

    // Return transfer reused the SAME org-A row (not a fresh insert).
    expect(a2.id).toBe(a1.id);
    expect(a2.status).toBe("active");

    // Exactly one row per (org, tenant): org A has ONE row, org B has ONE row.
    const orgARows = await sql`
      SELECT id FROM app_installations
      WHERE provider = ${GH.provider} AND external_tenant_id = 'inst-aba'
        AND organization_id = 'org-ra'
    `;
    expect(orgARows).toHaveLength(1);
    expect(Number(orgARows[0].id)).toBe(a1.id);

    // Exactly one ACTIVE row for the tenant, owned by A.
    const active = await sql`
      SELECT organization_id FROM app_installations
      WHERE provider = ${GH.provider} AND external_tenant_id = 'inst-aba'
        AND status = 'active'
    `;
    expect(active).toHaveLength(1);
    expect(active[0].organization_id).toBe("org-ra");

    // listByOrg(org-ra) returns a single id — no duplicates.
    const listed = await store.listByOrg("org-ra");
    const tenantIds = listed
      .filter((r) => r.externalTenantId === "inst-aba")
      .map((r) => r.id);
    expect(tenantIds).toEqual([a1.id]);

    // resolve returns the single active org-A row.
    const resolved = await store.resolveActiveByTenant({
      ...GH,
      externalTenantId: "inst-aba",
    });
    expect(resolved?.id).toBe(a1.id);
    expect(resolved?.organizationId).toBe("org-ra");
  });

  test("revoked and suspended rows do NOT route", async () => {
    await seedAgentRow("org-rev-agent", { organizationId: "org-rev" });
    const store = await buildStore();

    const row = await store.upsert({
      organizationId: "org-rev",
      ...GH,
      externalTenantId: "inst-400",
    });

    await store.revoke(row.id);
    expect((await store.getById(row.id))?.status).toBe("revoked");
    expect(
      await store.resolveActiveByTenant({ ...GH, externalTenantId: "inst-400" })
    ).toBeNull();

    // Re-activating then suspending also drops it out of routing.
    const reactivated = await store.upsert({
      organizationId: "org-rev",
      ...GH,
      externalTenantId: "inst-400",
    });
    await store.setStatus(reactivated.id, "suspended");
    expect(
      await store.resolveActiveByTenant({ ...GH, externalTenantId: "inst-400" })
    ).toBeNull();
  });

  test("concurrent upserts for the same tenant converge to one active row", async () => {
    await seedAgentRow("org-c1-agent", { organizationId: "org-c1" });
    await seedAgentRow("org-c2-agent", { organizationId: "org-c2" });
    await seedAgentRow("org-c3-agent", { organizationId: "org-c3" });
    const store = await buildStore();

    // Fire several activations for the same tuple at once from different orgs.
    const orgs = ["org-c1", "org-c2", "org-c3", "org-c1", "org-c2"];
    const results = await Promise.all(
      orgs.map((organizationId) =>
        store.upsert({
          organizationId,
          ...GH,
          externalTenantId: "inst-500",
        })
      )
    );

    expect(results).toHaveLength(orgs.length);

    // Exactly one active row survives for the tuple (DB-level proof, not the
    // store's view).
    const sql = getDb();
    const active = await sql`
      SELECT id, organization_id FROM app_installations
      WHERE provider = ${GH.provider}
        AND provider_instance = ${GH.providerInstance}
        AND provider_app_id = ${GH.providerAppId}
        AND external_tenant_id = 'inst-500'
        AND status = 'active'
    `;
    expect(active).toHaveLength(1);

    const resolved = await store.resolveActiveByTenant({
      ...GH,
      externalTenantId: "inst-500",
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(Number(active[0].id));
  });

  test("getById and listByOrg return the stored rows", async () => {
    await seedAgentRow("org-list-agent", { organizationId: "org-list" });
    const store = await buildStore();

    const one = await store.upsert({
      organizationId: "org-list",
      ...GH,
      externalTenantId: "inst-a",
    });
    const two = await store.upsert({
      organizationId: "org-list",
      provider: "slack",
      providerInstance: "cloud",
      providerAppId: "lobu-slack-1",
      externalTenantId: "T-xyz",
    });

    expect((await store.getById(one.id))?.externalTenantId).toBe("inst-a");
    const listed = await store.listByOrg("org-list");
    expect(listed.map((r) => r.id).sort()).toEqual([one.id, two.id].sort());
  });
});
