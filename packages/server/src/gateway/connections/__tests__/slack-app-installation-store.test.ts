/**
 * Real-Postgres tests for the Slack consolidation onto `app_installations`.
 *
 * The adapter (createSlackAppInstallationStore) keeps the SlackInstallationStore
 * interface while DUAL-WRITING `slack_installations` (legacy) + `app_installations`
 * and DUAL-READING (app_installations preferred, legacy fallback). The contract
 * under test:
 *   - the `slackinst-<uuid>` id semantics survive (secret prefix + memo/routing
 *     key) and getById resolves by it from app_installations;
 *   - the bot token round-trips through the secret store (never plaintext in
 *     either table), and the app_installations metadata carries only the ref;
 *   - getByTeamId resolves cross-org (no org context — the /slack/events path);
 *   - one active install per team (a different-org install demotes the prior);
 *   - a legacy-only row (no mirror) still resolves via the fallback.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../../db/client.js";
import { createPostgresSlackInstallationStore } from "../../../lobu/stores/slack-installation-store.js";
import { createSlackAppInstallationStore } from "../../../lobu/stores/slack-app-installation-store.js";
import { PostgresSecretStore } from "../../../lobu/stores/postgres-secret-store.js";
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

function buildStore() {
  const postgresSecretStore = new PostgresSecretStore();
  const secretStore = new SecretStoreRegistry(postgresSecretStore, {
    secret: postgresSecretStore,
  });
  return {
    store: createSlackAppInstallationStore(secretStore),
    // The legacy store, sharing the same secret store, for fallback-path setup.
    legacy: createPostgresSlackInstallationStore(secretStore),
    secretStore,
  };
}

/** Count app_installations Slack mirror rows for a given install id. */
async function countAppRowsForInstall(installId: string): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    SELECT count(*)::int AS n FROM app_installations
    WHERE provider = 'slack'
      AND metadata ->> 'external_id' = ${installId}
  `;
  return Number(rows[0].n);
}

describe("createSlackAppInstallationStore (Slack consolidation)", () => {
  test("dual-writes both tables; token is a ref, never plaintext", async () => {
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    const { resolveSecretValue } = await import("../../secrets/index.js");
    await seedAgentRow("throwaway", { organizationId: "org-inst" });
    const { store, secretStore } = await buildStore();

    const row = await store.upsertByTeam("org-inst", "T100", {
      teamName: "Acme",
      botUserId: "U100",
      botToken: "xoxb-real-token",
    });

    // slackinst- id semantics preserved.
    expect(row.id.startsWith("slackinst-")).toBe(true);
    expect(row.status).toBe("active");
    expect(row.config.botToken).not.toBe("xoxb-real-token");

    // Legacy row exists.
    const sql = getDb();
    const legacyRows = await sql`
      SELECT id, status FROM slack_installations WHERE id = ${row.id}
    `;
    expect(legacyRows).toHaveLength(1);

    // app_installations mirror exists, keyed on the tenant tuple, token by ref.
    const appRows = await sql`
      SELECT * FROM app_installations
      WHERE provider = 'slack'
        AND metadata ->> 'external_id' = ${row.id}
    `;
    expect(appRows).toHaveLength(1);
    expect(appRows[0].external_tenant_id).toBe("T100");
    expect(appRows[0].provider_instance).toBe("cloud");
    expect(appRows[0].provider_app_id).toBe("cloud");
    expect(appRows[0].status).toBe("active");
    expect(appRows[0].auth_profile_id).toBeNull();
    const mirrorConfig = appRows[0].metadata.config as Record<string, unknown>;
    expect(typeof mirrorConfig.botToken).toBe("string");
    expect(mirrorConfig.botToken).not.toBe("xoxb-real-token");

    // The mirrored ref resolves to the real token (same secret bucket).
    const resolved = await orgContext.run({ organizationId: "org-inst" }, () =>
      resolveSecretValue(secretStore, mirrorConfig.botToken as string)
    );
    expect(resolved).toBe("xoxb-real-token");
  });

  test("getById reads from app_installations (preferred), with stable id", async () => {
    await seedAgentRow("throwaway", { organizationId: "org-inst" });
    const { store } = await buildStore();
    const created = await store.upsertByTeam("org-inst", "T200", {
      teamName: "Acme",
      botUserId: "U200",
      botToken: "xoxb-x",
    });

    const found = await store.getById(created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.organizationId).toBe("org-inst");
    expect(found?.teamId).toBe("T200");
    expect(found?.teamName).toBe("Acme");
    expect(found?.botUserId).toBe("U200");
    expect(found?.status).toBe("active");
    expect(typeof found?.config.botToken).toBe("string");
  });

  test("getByTeamId resolves cross-org from app_installations (no org context)", async () => {
    await seedAgentRow("throwaway", { organizationId: "org-a" });
    const { store } = await buildStore();
    const created = await store.upsertByTeam("org-a", "T300", {
      botToken: "xoxb-a",
    });

    // No orgContext bound — mirrors the public /slack/events route.
    const found = await store.getByTeamId("T300");
    expect(found?.id).toBe(created.id);
    expect(found?.organizationId).toBe("org-a");
    expect(found?.teamId).toBe("T300");
  });

  test("idempotent per (org, team): same id, one mirror row, refreshed metadata", async () => {
    await seedAgentRow("throwaway", { organizationId: "org-inst" });
    const { store } = await buildStore();
    const first = await store.upsertByTeam("org-inst", "T250", {
      teamName: "Acme",
      botToken: "xoxb-first",
    });
    const second = await store.upsertByTeam("org-inst", "T250", {
      teamName: "Acme Renamed",
      botToken: "xoxb-second",
    });

    expect(second.id).toBe(first.id);
    expect(await countAppRowsForInstall(first.id)).toBe(1);
    const found = await store.getById(first.id);
    expect(found?.teamName).toBe("Acme Renamed");
    expect(await store.list("org-inst")).toHaveLength(1);
  });

  test("a fresh install from another org supersedes the prior (one active per team)", async () => {
    await seedAgentRow("ta", { organizationId: "org-a2" });
    await seedAgentRow("tb", { organizationId: "org-b2" });
    const { store } = await buildStore();

    const a = await store.upsertByTeam("org-a2", "T600", { botToken: "xoxb-a" });
    const b = await store.upsertByTeam("org-b2", "T600", { botToken: "xoxb-b" });

    // org-a's mirror demoted; org-b is the single active install.
    expect((await store.getById(a.id))?.status).toBe("stopped");
    expect((await store.getById(b.id))?.status).toBe("active");
    const found = await store.getByTeamId("T600");
    expect(found?.id).toBe(b.id);
    expect(found?.organizationId).toBe("org-b2");

    // DB-level: exactly one active Slack app_installations row for the team.
    const sql = getDb();
    const active = await sql`
      SELECT count(*)::int AS n FROM app_installations
      WHERE provider = 'slack' AND external_tenant_id = 'T600' AND status = 'active'
    `;
    expect(Number(active[0].n)).toBe(1);
  });

  test("A->B->A transfer: org A keeps ONE mirror row, no duplicate external_id, list returns one id", async () => {
    // Regression: an org-A install transferred to B and back to A must not leave
    // org A with two app_installations rows sharing the same external_id (which
    // would make list('org-a') return duplicate ids).
    await seedAgentRow("ta", { organizationId: "org-aba-a" });
    await seedAgentRow("tb", { organizationId: "org-aba-b" });
    const { store } = await buildStore();
    const sql = getDb();

    const a1 = await store.upsertByTeam("org-aba-a", "TABA", { botToken: "x1" });
    await store.upsertByTeam("org-aba-b", "TABA", { botToken: "x2" });
    const a2 = await store.upsertByTeam("org-aba-a", "TABA", { botToken: "x3" });

    // The legacy store reuses org A's slackinst- id on the return; the mirror
    // must reactivate org A's single row, not create a second one with that id.
    expect(a2.id).toBe(a1.id);
    expect(a2.status).toBe("active");

    // No duplicate (org, external_id) rows for org A.
    const orgARows = await sql`
      SELECT id, metadata ->> 'external_id' AS ext FROM app_installations
      WHERE provider = 'slack' AND external_tenant_id = 'TABA'
        AND organization_id = 'org-aba-a'
    `;
    expect(orgARows).toHaveLength(1);
    expect(orgARows[0].ext).toBe(a1.id);

    // list('org-aba-a') returns a single id (no duplicates).
    const listed = await store.list("org-aba-a");
    expect(listed.map((r) => r.id)).toEqual([a1.id]);

    // Exactly one active row for the team, owned by A.
    const active = await sql`
      SELECT organization_id FROM app_installations
      WHERE provider = 'slack' AND external_tenant_id = 'TABA' AND status = 'active'
    `;
    expect(active).toHaveLength(1);
    expect(active[0].organization_id).toBe("org-aba-a");
    expect((await store.getByTeamId("TABA"))?.id).toBe(a1.id);
  });

  test("markStopped flips both tables; getByTeamId routing skips stopped", async () => {
    await seedAgentRow("throwaway", { organizationId: "org-inst" });
    const { store } = await buildStore();
    const row = await store.upsertByTeam("org-inst", "T500", {
      botToken: "xoxb-x",
    });

    await store.markStopped(row.id);
    expect((await store.getById(row.id))?.status).toBe("stopped");

    const sql = getDb();
    const appRows = await sql`
      SELECT status FROM app_installations
      WHERE provider = 'slack' AND metadata ->> 'external_id' = ${row.id}
    `;
    expect(appRows[0].status).toBe("suspended");
  });

  test("delete removes both tables + the secret", async () => {
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    const { resolveSecretValue } = await import("../../secrets/index.js");
    await seedAgentRow("throwaway", { organizationId: "org-inst" });
    const { store, secretStore } = await buildStore();
    const row = await store.upsertByTeam("org-inst", "T400", {
      botToken: "xoxb-doomed",
    });

    await store.delete(row.id);

    expect(await store.getById(row.id)).toBeNull();
    expect(await countAppRowsForInstall(row.id)).toBe(0);
    const sql = getDb();
    const legacyRows =
      await sql`SELECT id FROM slack_installations WHERE id = ${row.id}`;
    expect(legacyRows).toHaveLength(0);
    const resolved = await orgContext.run({ organizationId: "org-inst" }, () =>
      resolveSecretValue(secretStore, row.config.botToken)
    );
    expect(resolved).toBeUndefined();
  });

  test("read fallback: a legacy-only row (no mirror) still resolves", async () => {
    await seedAgentRow("throwaway", { organizationId: "org-legacy" });
    const { store, legacy } = await buildStore();

    // Write ONLY the legacy row (simulating a pre-backfill / un-mirrored install).
    const legacyRow = await legacy.upsertByTeam("org-legacy", "T700", {
      teamName: "Legacy Co",
      botToken: "xoxb-legacy",
    });
    // No app_installations row exists yet.
    expect(await countAppRowsForInstall(legacyRow.id)).toBe(0);

    // Both lookups must still resolve via the legacy fallback.
    const byId = await store.getById(legacyRow.id);
    expect(byId?.id).toBe(legacyRow.id);
    expect(byId?.teamName).toBe("Legacy Co");

    const byTeam = await store.getByTeamId("T700");
    expect(byTeam?.id).toBe(legacyRow.id);
    expect(byTeam?.organizationId).toBe("org-legacy");

    // list() also falls back when there is no mirror for the org.
    const listed = await store.list("org-legacy");
    expect(listed.map((r) => r.id)).toContain(legacyRow.id);
  });

  test("a FAILED mirror write is NOT swallowed — install errors instead of routing stale", async () => {
    // Reads PREFER app_installations. If the mirror write fails during an A->B
    // transfer, app_installations stays on org A while legacy moves to org B —
    // getByTeamId (preferring app_installations) would then route to the STALE
    // old org. The mirror failure must therefore be rethrown so the caller
    // errors/retries, never silently succeeding on a stale mirror.
    const { createPostgresAppInstallationStore } = await import(
      "../../../lobu/stores/app-installation-store.js"
    );
    await seedAgentRow("ta", { organizationId: "org-stale-a" });
    await seedAgentRow("tb", { organizationId: "org-stale-b" });

    const postgresSecretStore = new PostgresSecretStore();
    const secretStore = new SecretStoreRegistry(postgresSecretStore, {
      secret: postgresSecretStore,
    });
    // A generic store whose upsert fails ONLY for org-stale-b (the transfer
    // target) — org A's first install mirrors fine, the B transfer mirror throws.
    const realAppStore = createPostgresAppInstallationStore();
    const failingAppStore = {
      ...realAppStore,
      upsert: async (install: Parameters<typeof realAppStore.upsert>[0]) => {
        if (install.organizationId === "org-stale-b") {
          throw new Error("simulated mirror write failure");
        }
        return realAppStore.upsert(install);
      },
    };
    const store = createSlackAppInstallationStore(secretStore, {
      appInstallationStore: failingAppStore,
    });

    // A installs cleanly (both tables on org A).
    const a = await store.upsertByTeam("org-stale-a", "TSTALE", {
      botToken: "xoxb-a",
    });
    expect((await store.getByTeamId("TSTALE"))?.organizationId).toBe(
      "org-stale-a"
    );

    // Transfer to B: the legacy write succeeds but the mirror throws. The whole
    // upsert must reject — the caller (OAuth install) sees the failure and retries
    // rather than believing the transfer landed.
    await expect(
      store.upsertByTeam("org-stale-b", "TSTALE", { botToken: "xoxb-b" })
    ).rejects.toThrow(/simulated mirror write failure/);

    // app_installations was never updated to B (its mirror write threw), so it
    // still reflects org A — proving the failure was surfaced, not swallowed into
    // a half-applied transfer the reads would trust. (The id is A's, not a new B
    // row that getByTeamId would route to.)
    const stillA = await store.getById(a.id);
    expect(stillA?.organizationId).toBe("org-stale-a");
    expect(stillA?.status).toBe("active");
  });

  describe("degrade when slack_installations is dropped (contract deploy window)", () => {
    // The contract release drops slack_installations via a pre-upgrade hook
    // while these (expand) pods may still serve installs. Every legacy read AND
    // write must tolerate the missing table and degrade to app_installations.
    async function dropLegacyTable() {
      const sql = getDb();
      await sql`DROP TABLE IF EXISTS slack_installations`;
    }

    // The outer beforeEach only TRUNCATEs (it doesn't re-run migrations), so a
    // DROP in one test would leave the table gone for the next test AND for other
    // test files in the same process. Recreate it after the outer reset (each
    // test starts table-present) and once more in afterAll (so the last test's
    // DROP never leaks beyond this file).
    async function recreateLegacyTable() {
      const sql = getDb();
      await sql`
        CREATE TABLE IF NOT EXISTS public.slack_installations (
          id text NOT NULL,
          organization_id text NOT NULL,
          team_id text NOT NULL,
          team_name text,
          bot_user_id text,
          config jsonb DEFAULT '{}'::jsonb NOT NULL,
          status text DEFAULT 'active'::text NOT NULL,
          created_at timestamp with time zone DEFAULT now() NOT NULL,
          updated_at timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT slack_installations_pkey PRIMARY KEY (id),
          CONSTRAINT slack_installations_status_check
            CHECK ((status = ANY (ARRAY['active'::text, 'stopped'::text, 'error'::text]))),
          CONSTRAINT slack_installations_org_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE,
          CONSTRAINT slack_installations_org_team_uniq UNIQUE (organization_id, team_id)
        )
      `;
    }

    beforeEach(recreateLegacyTable);
    afterAll(recreateLegacyTable);

    test("upsertByTeam installs via app_installations only (no throw)", async () => {
      const { orgContext } = await import("../../../lobu/stores/org-context.js");
      const { resolveSecretValue } = await import("../../secrets/index.js");
      await seedAgentRow("throwaway", { organizationId: "org-drop" });
      const { store, secretStore } = await buildStore();
      await dropLegacyTable();

      const row = await store.upsertByTeam("org-drop", "TDROP", {
        teamName: "Dropped Co",
        botUserId: "UDROP",
        botToken: "xoxb-after-drop",
      });

      // Stable slackinst- id minted by the degraded path; token by ref.
      expect(row.id.startsWith("slackinst-")).toBe(true);
      expect(row.status).toBe("active");
      expect(row.config.botToken).not.toBe("xoxb-after-drop");
      expect(await countAppRowsForInstall(row.id)).toBe(1);
      const resolved = await orgContext.run({ organizationId: "org-drop" }, () =>
        resolveSecretValue(secretStore, row.config.botToken)
      );
      expect(resolved).toBe("xoxb-after-drop");

      // Reads resolve from app_installations even with the table gone.
      expect((await store.getById(row.id))?.teamName).toBe("Dropped Co");
      expect((await store.getByTeamId("TDROP"))?.id).toBe(row.id);
    });

    test("a reinstall after the drop reuses the same external id (stable secret prefix)", async () => {
      await seedAgentRow("throwaway", { organizationId: "org-drop2" });
      const { store } = await buildStore();
      // First install while the table still exists (dual-write).
      const first = await store.upsertByTeam("org-drop2", "TD2", {
        botToken: "xoxb-1",
      });
      await dropLegacyTable();
      // Reinstall after the drop must reuse the same app_installations row + id.
      const second = await store.upsertByTeam("org-drop2", "TD2", {
        teamName: "Renamed",
        botToken: "xoxb-2",
      });

      expect(second.id).toBe(first.id);
      expect(await countAppRowsForInstall(first.id)).toBe(1);
      expect((await store.getById(first.id))?.teamName).toBe("Renamed");
    });

    test("getById / getByTeamId / list degrade to app_installations (no throw)", async () => {
      await seedAgentRow("throwaway", { organizationId: "org-drop3" });
      const { store } = await buildStore();
      const row = await store.upsertByTeam("org-drop3", "TD3", {
        botToken: "xoxb-x",
      });
      await dropLegacyTable();

      // app_installations-backed reads still work...
      expect((await store.getById(row.id))?.id).toBe(row.id);
      expect((await store.getByTeamId("TD3"))?.id).toBe(row.id);
      expect((await store.list("org-drop3")).map((r) => r.id)).toContain(row.id);
      // ...and a miss returns null/[] (degraded legacy fallback), not a throw.
      expect(await store.getById("slackinst-nope")).toBeNull();
      expect(await store.getByTeamId("T-nope")).toBeNull();
      expect(await store.list("org-empty")).toEqual([]);
    });

    test("markStopped + delete degrade (no throw); delete purges the secret", async () => {
      const { orgContext } = await import("../../../lobu/stores/org-context.js");
      const { resolveSecretValue } = await import("../../secrets/index.js");
      await seedAgentRow("throwaway", { organizationId: "org-drop4" });
      const { store, secretStore } = await buildStore();
      const row = await store.upsertByTeam("org-drop4", "TD4", {
        botToken: "xoxb-doomed",
      });
      await dropLegacyTable();

      await store.markStopped(row.id);
      expect((await store.getById(row.id))?.status).toBe("stopped");

      await store.delete(row.id);
      expect(await store.getById(row.id)).toBeNull();
      expect(await countAppRowsForInstall(row.id)).toBe(0);
      const resolved = await orgContext.run({ organizationId: "org-drop4" }, () =>
        resolveSecretValue(secretStore, row.config.botToken)
      );
      expect(resolved).toBeUndefined();
    });
  });
});
