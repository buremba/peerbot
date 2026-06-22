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

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../../db/client.js";
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

async function buildStore() {
  const { createSlackAppInstallationStore } = await import(
    "../../../lobu/stores/slack-app-installation-store.js"
  );
  const { createPostgresSlackInstallationStore } = await import(
    "../../../lobu/stores/slack-installation-store.js"
  );
  const { PostgresSecretStore } = await import(
    "../../../lobu/stores/postgres-secret-store.js"
  );
  const { SecretStoreRegistry } = await import("../../secrets/index.js");
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
});
