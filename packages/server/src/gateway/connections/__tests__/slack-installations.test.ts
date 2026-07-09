/**
 * Real-Postgres tests for the Slack install projection over the generic
 * `app_installations` primitive (the consolidation end state — NO bespoke table
 * or store). Contract under test:
 *   - upsert persists an app_installations row (provider=slack) keyed on the
 *     team tuple; the bot token round-trips through the secret store (never
 *     plaintext in the row), the ref lives in metadata.config;
 *   - the stable slackinst-<uuid> external id survives reinstalls (same id +
 *     secret prefix), and getById resolves by it;
 *   - getByTeamId resolves the ACTIVE install cross-org (no org context — the
 *     /slack/events path), and returns null once stopped/transferred;
 *   - a different-org install TRANSFERS ownership (one active per team);
 *   - delete removes the row + purges the secret.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../../db/client.js";
import { createPostgresAppInstallationStore } from "../../../lobu/stores/app-installation-store.js";
import { PostgresSecretStore } from "../../../lobu/stores/postgres-secret-store.js";
import * as slack from "../../../lobu/stores/slack-installations.js";
import { SecretStoreRegistry } from "../../secrets/index.js";
import {
  ensureDbForGatewayTests,
  ensureEncryptionKey,
  resetTestDatabase,
  seedAgentRow,
} from "../../__tests__/helpers/db-setup.js";

beforeAll(async () => {
  await ensureDbForGatewayTests();
}, 60_000);

beforeEach(async () => {
  ensureEncryptionKey();
  await resetTestDatabase();
}, 30_000);

function build() {
  const postgresSecretStore = new PostgresSecretStore();
  const secretStore = new SecretStoreRegistry(postgresSecretStore, {
    secret: postgresSecretStore,
  });
  return { store: createPostgresAppInstallationStore(), secretStore, slack };
}

/**
 * A WritableSecretStore that delegates reads/list/delete to `real` but throws on
 * `put` — simulates a persistSecretValue (token persist) failure. Delegates via
 * bound methods (not object spread) so the class instance's prototype methods are
 * preserved.
 */
function makeFailingSecretStore(
  real: SecretStoreRegistry,
  message: string
): SecretStoreRegistry {
  return {
    get: (ref: any) => real.get(ref),
    list: (prefix?: string) => real.list(prefix),
    delete: (nameOrRef: string) => real.delete(nameOrRef),
    put: async () => {
      throw new Error(message);
    },
  } as unknown as SecretStoreRegistry;
}

describe("slack-installations projection over app_installations", () => {
  test("upsert persists an app_installations row; token by ref, never plaintext", async () => {
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    const { resolveSecretValue } = await import("../../secrets/index.js");
    await seedAgentRow("throwaway", { organizationId: "org-inst" });
    const { store, secretStore, slack } = await build();

    const row = await slack.upsertSlackInstallByTeam(
      store,
      secretStore,
      "org-inst",
      "T100",
      { teamName: "Acme", botUserId: "U100", botToken: "xoxb-real-token" }
    );

    expect(row.id.startsWith("slackinst-")).toBe(true);
    expect(row.status).toBe("active");
    expect(row.config.botToken).not.toBe("xoxb-real-token");

    const sql = getDb();
    const appRows = await sql`
      SELECT * FROM app_installations
      WHERE provider = 'slack' AND metadata ->> 'external_id' = ${row.id}
    `;
    expect(appRows).toHaveLength(1);
    expect(appRows[0].external_tenant_id).toBe("T100");
    expect(appRows[0].provider_instance).toBe("cloud");
    expect(appRows[0].provider_app_id).toBe("cloud");
    expect(appRows[0].status).toBe("active");
    expect(appRows[0].auth_profile_id).toBeNull();
    const cfg = appRows[0].metadata.config as Record<string, unknown>;
    expect(typeof cfg.botToken).toBe("string");
    expect(cfg.botToken).not.toBe("xoxb-real-token");

    const resolved = await orgContext.run({ organizationId: "org-inst" }, () =>
      resolveSecretValue(secretStore, cfg.botToken as string)
    );
    expect(resolved).toBe("xoxb-real-token");
  });

  test("getById resolves by the stable slackinst- external id", async () => {
    await seedAgentRow("throwaway", { organizationId: "org-inst" });
    const { store, secretStore, slack } = await build();
    const created = await slack.upsertSlackInstallByTeam(
      store,
      secretStore,
      "org-inst",
      "T200",
      { teamName: "Acme", botUserId: "U200", botToken: "xoxb-x" }
    );

    const found = await slack.getSlackInstallById(store, created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.teamId).toBe("T200");
    expect(found?.teamName).toBe("Acme");
    expect(found?.botUserId).toBe("U200");
    expect(found?.status).toBe("active");
  });

  test("reinstall keeps the SAME external id (stable secret prefix)", async () => {
    await seedAgentRow("throwaway", { organizationId: "org-inst" });
    const { store, secretStore, slack } = await build();
    const first = await slack.upsertSlackInstallByTeam(
      store,
      secretStore,
      "org-inst",
      "T250",
      { teamName: "Acme", botToken: "xoxb-first" }
    );
    const second = await slack.upsertSlackInstallByTeam(
      store,
      secretStore,
      "org-inst",
      "T250",
      { teamName: "Acme Renamed", botToken: "xoxb-second" }
    );

    expect(second.id).toBe(first.id);
    expect((await slack.listSlackInstalls(store, "org-inst")).length).toBe(1);
    const found = await slack.getSlackInstallById(store, first.id);
    expect(found?.teamName).toBe("Acme Renamed");
  });

  test("getByTeamId resolves the active install cross-org (no org context)", async () => {
    await seedAgentRow("throwaway", { organizationId: "org-a" });
    const { store, secretStore, slack } = await build();
    const created = await slack.upsertSlackInstallByTeam(
      store,
      secretStore,
      "org-a",
      "T300",
      { botToken: "xoxb-a" }
    );

    const found = await slack.getSlackInstallByTeamId(store, "T300");
    expect(found?.id).toBe(created.id);
    expect(found?.organizationId).toBe("org-a");
  });

  test("different-org install transfers ownership (one active per team)", async () => {
    await seedAgentRow("ta", { organizationId: "org-a2" });
    await seedAgentRow("tb", { organizationId: "org-b2" });
    const { store, secretStore, slack } = await build();

    const a = await slack.upsertSlackInstallByTeam(
      store,
      secretStore,
      "org-a2",
      "T600",
      { botToken: "xoxb-a" }
    );
    const b = await slack.upsertSlackInstallByTeam(
      store,
      secretStore,
      "org-b2",
      "T600",
      { botToken: "xoxb-b" }
    );

    expect((await slack.getSlackInstallById(store, a.id))?.status).toBe(
      "stopped"
    );
    expect((await slack.getSlackInstallById(store, b.id))?.status).toBe(
      "active"
    );
    const found = await slack.getSlackInstallByTeamId(store, "T600");
    expect(found?.id).toBe(b.id);
  });

  test("A->B->A transfer reuses org A's row — no duplicate external_id, list returns one id", async () => {
    // Regression: a return transfer must REACTIVATE org A's existing row, keeping
    // its stable external id, not insert a second org-A row. Otherwise
    // list('org-a')/resolveByExternalId would see duplicate ids.
    await seedAgentRow("ta", { organizationId: "org-aba-a" });
    await seedAgentRow("tb", { organizationId: "org-aba-b" });
    const { store, secretStore, slack } = await build();
    const sql = getDb();

    const a1 = await slack.upsertSlackInstallByTeam(
      store,
      secretStore,
      "org-aba-a",
      "TABA",
      { botToken: "x1" }
    );
    await slack.upsertSlackInstallByTeam(store, secretStore, "org-aba-b", "TABA", {
      botToken: "x2",
    });
    const a2 = await slack.upsertSlackInstallByTeam(
      store,
      secretStore,
      "org-aba-a",
      "TABA",
      { botToken: "x3" }
    );

    // org A's row reactivated in place — same id, now active.
    expect(a2.id).toBe(a1.id);
    expect(a2.status).toBe("active");

    // Exactly one app_installations row for (org A, team) — no duplicate.
    const orgARows = await sql`
      SELECT id, metadata ->> 'external_id' AS ext FROM app_installations
      WHERE provider = 'slack' AND external_tenant_id = 'TABA'
        AND organization_id = 'org-aba-a'
    `;
    expect(orgARows).toHaveLength(1);
    expect(orgARows[0].ext).toBe(a1.id);

    // list + resolveByExternalId return the single id.
    expect((await slack.listSlackInstalls(store, "org-aba-a")).map((r) => r.id)).toEqual([
      a1.id,
    ]);
    expect((await slack.getSlackInstallById(store, a1.id))?.id).toBe(a1.id);
    expect((await slack.getSlackInstallByTeamId(store, "TABA"))?.id).toBe(a1.id);
  });

  test("markStopped drops the install out of active team routing", async () => {
    await seedAgentRow("throwaway", { organizationId: "org-inst" });
    const { store, secretStore, slack } = await build();
    const row = await slack.upsertSlackInstallByTeam(
      store,
      secretStore,
      "org-inst",
      "T500",
      { botToken: "xoxb-x" }
    );

    await slack.markSlackInstallStopped(store, row.id);
    expect((await slack.getSlackInstallById(store, row.id))?.status).toBe(
      "stopped"
    );
    // Active-team routing no longer resolves it.
    expect(await slack.getSlackInstallByTeamId(store, "T500")).toBeNull();
  });

  test("delete removes the row and purges the secret", async () => {
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    const { resolveSecretValue } = await import("../../secrets/index.js");
    await seedAgentRow("throwaway", { organizationId: "org-inst" });
    const { store, secretStore, slack } = await build();
    const row = await slack.upsertSlackInstallByTeam(
      store,
      secretStore,
      "org-inst",
      "T400",
      { botToken: "xoxb-doomed" }
    );

    await slack.deleteSlackInstall(store, secretStore, row.id);

    expect(await slack.getSlackInstallById(store, row.id)).toBeNull();
    const sql = getDb();
    const appRows = await sql`
      SELECT id FROM app_installations
      WHERE provider = 'slack' AND metadata ->> 'external_id' = ${row.id}
    `;
    expect(appRows).toHaveLength(0);
    const resolved = await orgContext.run({ organizationId: "org-inst" }, () =>
      resolveSecretValue(secretStore, row.config.botToken)
    );
    expect(resolved).toBeUndefined();
  });

  test("concurrent same-(org,team) installs converge to ONE external id + one secret", async () => {
    // Two parallel installs of the same workspace must not mint duplicate ids:
    // the external id is claimed atomically inside the upsert advisory lock, so
    // both callers resolve the SAME slackinst- id, one app_installations row, and
    // one bot-token secret — no orphaned secret under a losing id.
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    await seedAgentRow("throwaway", { organizationId: "org-race" });
    const { store, secretStore, slack } = await build();

    const [a, b] = await Promise.all([
      slack.upsertSlackInstallByTeam(store, secretStore, "org-race", "TRACE", {
        botToken: "xoxb-a",
      }),
      slack.upsertSlackInstallByTeam(store, secretStore, "org-race", "TRACE", {
        botToken: "xoxb-b",
      }),
    ]);

    // Both callers get the same external id.
    expect(a.id).toBe(b.id);

    const sql = getDb();
    // Exactly one app_installations row for the team (no duplicate).
    const teamRows = await sql`
      SELECT id, metadata ->> 'external_id' AS external_id, status
      FROM app_installations
      WHERE provider = 'slack' AND external_tenant_id = 'TRACE'
    `;
    expect(teamRows).toHaveLength(1);
    expect(teamRows[0].external_id).toBe(a.id);
    expect(teamRows[0].status).toBe("active");

    // Exactly one distinct external id was ever written for the team.
    const distinctIds = await sql`
      SELECT DISTINCT metadata ->> 'external_id' AS external_id
      FROM app_installations
      WHERE provider = 'slack' AND external_tenant_id = 'TRACE'
    `;
    expect(distinctIds).toHaveLength(1);

    // Exactly one bot-token secret exists (under the canonical id) — no orphan.
    const secrets = await orgContext.run({ organizationId: "org-race" }, () =>
      secretStore.list("installations/")
    );
    const slackinstSecrets = secrets.filter((s) =>
      s.name.startsWith("installations/slackinst-")
    );
    expect(slackinstSecrets).toHaveLength(1);
    expect(slackinstSecrets[0].name).toBe(`installations/${a.id}/botToken`);

    // The canonical install resolves and its token is readable.
    const resolved = await slack.getSlackInstallById(store, a.id);
    expect(resolved?.id).toBe(a.id);
  });

  test("a failed token persist on a FRESH install leaves NO active row (token-first)", async () => {
    await seedAgentRow("throwaway", { organizationId: "org-fail" });
    const { store, secretStore, slack } = await build();
    // Secret store whose put() throws — simulates persistSecretValue failure.
    const failingSecretStore = makeFailingSecretStore(
      secretStore,
      "simulated secret store failure"
    );

    await expect(
      slack.upsertSlackInstallByTeam(
        store,
        failingSecretStore,
        "org-fail",
        "TFAIL",
        { botToken: "xoxb-fail" }
      )
    ).rejects.toThrow(/simulated secret store failure/);

    // INVARIANT: no Slack install row exists for the team at all (the token is
    // persisted BEFORE any row is created/activated, so a persist failure writes
    // nothing) — and certainly no ACTIVE row without a token.
    const sql = getDb();
    const rows = await sql`
      SELECT id, status FROM app_installations
      WHERE provider = 'slack' AND external_tenant_id = 'TFAIL'
    `;
    expect(rows).toHaveLength(0);
    expect(await slack.getSlackInstallByTeamId(store, "TFAIL")).toBeNull();
  });

  test("a failed token persist during A->B transfer does NOT demote A or leave a tokenless active row", async () => {
    await seedAgentRow("ta", { organizationId: "org-tx-a" });
    await seedAgentRow("tb", { organizationId: "org-tx-b" });
    const { store, secretStore, slack } = await build();

    // A installs cleanly (active, with a token).
    const a = await slack.upsertSlackInstallByTeam(
      store,
      secretStore,
      "org-tx-a",
      "TTX",
      { botToken: "xoxb-a" }
    );
    expect((await slack.getSlackInstallByTeamId(store, "TTX"))?.id).toBe(a.id);

    // Transfer to B, but the token persist fails. Because the token is persisted
    // BEFORE the activation upsert (which is what demotes A), the failure happens
    // before A is touched: A must stay active and B must not exist.
    const failingSecretStore = makeFailingSecretStore(
      secretStore,
      "simulated secret store failure (transfer)"
    );
    await expect(
      slack.upsertSlackInstallByTeam(store, failingSecretStore, "org-tx-b", "TTX", {
        botToken: "xoxb-b",
      })
    ).rejects.toThrow(/simulated secret store failure \(transfer\)/);

    // A's row is untouched — still the single active install, token resolves.
    const sql = getDb();
    const active = await sql`
      SELECT organization_id, metadata ->> 'external_id' AS ext
      FROM app_installations
      WHERE provider = 'slack' AND external_tenant_id = 'TTX' AND status = 'active'
    `;
    expect(active).toHaveLength(1);
    expect(active[0].organization_id).toBe("org-tx-a");
    expect(active[0].ext).toBe(a.id);
    // No org-B row was created.
    const orgB = await sql`
      SELECT id FROM app_installations
      WHERE provider = 'slack' AND external_tenant_id = 'TTX'
        AND organization_id = 'org-tx-b'
    `;
    expect(orgB).toHaveLength(0);

    // INVARIANT: every active Slack row has a resolvable botToken.
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    const { resolveSecretValue } = await import("../../secrets/index.js");
    const stillA = await slack.getSlackInstallById(store, a.id);
    expect(stillA?.status).toBe("active");
    const token = await orgContext.run({ organizationId: "org-tx-a" }, () =>
      resolveSecretValue(secretStore, stillA?.config.botToken)
    );
    expect(token).toBe("xoxb-a");
  });
});

describe("Grid install-model routing (per-workspace + org-wide enterprise)", () => {
  test("org-wide enterprise install routes by enterprise_id EVEN WITH sibling per-workspace installs present", async () => {
    // The workaround's failure mode: getSlackInstallByEnterpriseId (sole-active)
    // returns null once 2+ installs share an enterprise. An org-wide install must
    // still route unambiguously via the is_enterprise_install flag.
    const { store, secretStore, slack } = build();
    const ENT = "E_GRID";
    await seedAgentRow("t", { organizationId: "org-x" });

    // A sibling per-workspace install under the same enterprise (adds ambiguity).
    await slack.upsertSlackInstallByTeam(store, secretStore, "org-x", "T_SIBLING", {
      botToken: "xoxb-sibling",
      enterpriseId: ENT,
      // per-workspace: is_enterprise_install NOT set
    });
    // The org-wide install (installed against its home team T_HOME).
    const orgWide = await slack.upsertSlackInstallByTeam(store, secretStore, "org-x", "T_HOME", {
      botToken: "xoxb-orgwide",
      enterpriseId: ENT,
      isEnterpriseInstall: true,
    });

    // Sole-active is (correctly) ambiguous now — proves the old path can't route.
    expect(await slack.getSlackInstallByEnterpriseId(store, ENT)).toBeNull();

    // The org-wide resolver picks the enterprise install unambiguously.
    const routed = await slack.getSlackEnterpriseInstall(store, ENT);
    expect(routed?.id).toBe(orgWide.id);
  });

  test("sole per-workspace Grid install still routes by enterprise_id (no org-wide install)", async () => {
    // A Grid enterprise with exactly ONE (non-org-wide) install: the legacy
    // sole-active fallback must keep working, and the org-wide resolver returns
    // null (nothing flagged).
    const { store, secretStore, slack } = build();
    const ENT = "E_SOLO";
    await seedAgentRow("t", { organizationId: "org-y" });
    const only = await slack.upsertSlackInstallByTeam(store, secretStore, "org-y", "T_ONLY", {
      botToken: "xoxb-only",
      enterpriseId: ENT,
    });

    expect(await slack.getSlackEnterpriseInstall(store, ENT)).toBeNull();
    const routed = await slack.getSlackInstallByEnterpriseId(store, ENT);
    expect(routed?.id).toBe(only.id);
  });

  test("claim persists is_enterprise_install so an org-wide install is routable after claim", async () => {
    // End-to-end of the plumbing: a pending ENTERPRISE install, once claimed,
    // must carry is_enterprise_install=true on the active row (else the org-wide
    // router never matches it).
    const { store, secretStore, slack } = build();
    const ENT = "E_CLAIM";
    await seedAgentRow("t", { organizationId: "org-claim" });
    await slack.writeSlackPendingInstall({
      teamId: "T_CLAIM",
      teamName: "Claimed WS",
      botUserId: "U_BOT",
      botToken: "xoxb-claim",
      installerUserId: "U_INSTALLER",
      isEnterpriseInstall: true,
      enterpriseId: ENT,
    });
    const pending = await slack.resolveSlackPendingByTenant("T_CLAIM");
    expect(pending?.isEnterpriseInstall).toBe(true);

    await slack.claimSlackPendingInstall(store, secretStore, pending!, "org-claim");

    const routed = await slack.getSlackEnterpriseInstall(store, ENT);
    expect(routed?.organizationId).toBe("org-claim");
  });

  test("a plain per-workspace claim does NOT set is_enterprise_install (not org-wide routable)", async () => {
    // Guard the negative: a standalone (non-Grid) or Grid single-workspace claim
    // must not be picked up by the org-wide router.
    const { store, secretStore, slack } = build();
    await seedAgentRow("t", { organizationId: "org-plain" });
    await slack.writeSlackPendingInstall({
      teamId: "T_PLAIN",
      teamName: "Plain WS",
      botUserId: "U_BOT",
      botToken: "xoxb-plain",
      installerUserId: "U_INSTALLER",
      isEnterpriseInstall: false,
      enterpriseId: "E_PLAIN",
    });
    const pending = await slack.resolveSlackPendingByTenant("T_PLAIN");
    await slack.claimSlackPendingInstall(store, secretStore, pending!, "org-plain");

    expect(await slack.getSlackEnterpriseInstall(store, "E_PLAIN")).toBeNull();
    // But it IS still reachable as the sole per-workspace install for its enterprise.
    const solo = await slack.getSlackInstallByEnterpriseId(store, "E_PLAIN");
    expect(solo?.organizationId).toBe("org-plain");
  });

  test("org-wide pending (keyed on enterprise id) resolves for a sibling-workspace event via the enterprise fallback", async () => {
    // The real org-wide install flow: oauth.v2.access returns no team id, so the
    // pending row is keyed on the ENTERPRISE id (E_ORG). A sibling-workspace event
    // in the pre-claim window arrives stamped with the sibling's team id (T_SIB),
    // which never equals E_ORG — so resolveSlackPendingByTenant must fall back to
    // the enterprise id to find the parked org-wide install (else the unclaimed
    // reply / connect-link never fires for siblings).
    const { slack } = build();
    await slack.writeSlackPendingInstall({
      teamId: "E_ORG", // enterprise id stands in as the identity key (no team id)
      teamName: "Org Sandbox",
      botUserId: "U_BOT",
      botToken: "xoxb-org",
      installerUserId: "U_OWNER",
      isEnterpriseInstall: true,
      enterpriseId: "E_ORG",
    });

    // Exact miss on the sibling team id, but enterprise fallback finds it.
    const bySibling = await slack.resolveSlackPendingByTenant("T_SIB", "E_ORG");
    expect(bySibling?.teamId).toBe("E_ORG");
    expect(bySibling?.isEnterpriseInstall).toBe(true);

    // Without the enterprise hint, a sibling team id alone does NOT resolve it.
    expect(await slack.resolveSlackPendingByTenant("T_SIB")).toBeNull();

    // The exact enterprise-id key still resolves directly (the claim ref path).
    expect((await slack.resolveSlackPendingByTenant("E_ORG"))?.teamId).toBe(
      "E_ORG",
    );
  });

  test("a plain per-workspace pending is NOT matched by a sibling's enterprise id", async () => {
    // Guard the negative: a non-org-wide pending row (is_enterprise_install=false)
    // must never be claimed by an unrelated sibling event that happens to carry
    // the same enterprise id — only a flagged org-wide row answers the fallback.
    const { slack } = build();
    await slack.writeSlackPendingInstall({
      teamId: "T_ONLY",
      teamName: "Single WS",
      botUserId: "U_BOT",
      botToken: "xoxb-only",
      installerUserId: "U_INSTALLER",
      isEnterpriseInstall: false,
      enterpriseId: "E_SHARED",
    });

    // A different sibling under the same enterprise must not resolve this row.
    expect(
      await slack.resolveSlackPendingByTenant("T_OTHER", "E_SHARED"),
    ).toBeNull();
    // Its own team id still resolves it.
    expect((await slack.resolveSlackPendingByTenant("T_ONLY"))?.teamId).toBe(
      "T_ONLY",
    );
  });
});
