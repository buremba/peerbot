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

async function build() {
  const { createPostgresAppInstallationStore } = await import(
    "../../../lobu/stores/app-installation-store.js"
  );
  const { PostgresSecretStore } = await import(
    "../../../lobu/stores/postgres-secret-store.js"
  );
  const { SecretStoreRegistry } = await import("../../secrets/index.js");
  const postgresSecretStore = new PostgresSecretStore();
  const secretStore = new SecretStoreRegistry(postgresSecretStore, {
    secret: postgresSecretStore,
  });
  const slack = await import("../../../lobu/stores/slack-installations.js");
  return { store: createPostgresAppInstallationStore(), secretStore, slack };
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
});
