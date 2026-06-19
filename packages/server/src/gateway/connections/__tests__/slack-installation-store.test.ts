/**
 * Real-Postgres tests for the per-workspace Slack install store (the "Add to
 * Slack" OAuth path). The bot token must round-trip through the secret store
 * (never plaintext in the row), the row must be idempotent per (org, team) on
 * re-install, and team lookup must work cross-org (the public /slack/events
 * route has no org context).
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
    store: createPostgresSlackInstallationStore(secretStore),
    secretStore,
  };
}

describe("SlackInstallationStore", () => {
  test("upsertByTeam persists tenant data; token goes to the secret store, not the row", async () => {
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    const { resolveSecretValue } = await import("../../secrets/index.js");
    await seedAgentRow("throwaway", { organizationId: "org-inst" });
    const { store, secretStore } = await buildStore();

    const row = await store.upsertByTeam("org-inst", "T100", {
      teamName: "Acme",
      botUserId: "U100",
      botToken: "xoxb-real-token",
    });

    expect(row.id.startsWith("slackinst-")).toBe(true);
    expect(row.organizationId).toBe("org-inst");
    expect(row.teamId).toBe("T100");
    expect(row.teamName).toBe("Acme");
    expect(row.status).toBe("active");
    // Row stores a ref, never the plaintext token.
    expect(typeof row.config.botToken).toBe("string");
    expect(row.config.botToken).not.toBe("xoxb-real-token");
    // The ref resolves to the real token (under the install org's bucket).
    const resolved = await orgContext.run({ organizationId: "org-inst" }, () =>
      resolveSecretValue(secretStore, row.config.botToken)
    );
    expect(resolved).toBe("xoxb-real-token");
  });

  test("upsertByTeam is idempotent per (org, team): same id, refreshed token", async () => {
    await seedAgentRow("throwaway", { organizationId: "org-inst" });
    const { store } = await buildStore();

    const first = await store.upsertByTeam("org-inst", "T200", {
      teamName: "Acme",
      botToken: "xoxb-first",
    });
    const second = await store.upsertByTeam("org-inst", "T200", {
      teamName: "Acme Renamed",
      botToken: "xoxb-second",
    });

    expect(second.id).toBe(first.id);
    expect(second.teamName).toBe("Acme Renamed");
    expect(await store.list("org-inst")).toHaveLength(1);
  });

  test("getByTeamId resolves cross-org (no org context)", async () => {
    await seedAgentRow("throwaway", { organizationId: "org-a" });
    const { store } = await buildStore();
    const created = await store.upsertByTeam("org-a", "T300", {
      botToken: "xoxb-a",
    });

    // No orgContext bound — mirrors the public /slack/events route.
    const found = await store.getByTeamId("T300");
    expect(found?.id).toBe(created.id);
    expect(found?.organizationId).toBe("org-a");
  });

  test("a fresh install from another org supersedes the prior one (one active per team)", async () => {
    await seedAgentRow("ta", { organizationId: "org-a2" });
    await seedAgentRow("tb", { organizationId: "org-b2" });
    const { store } = await buildStore();

    const a = await store.upsertByTeam("org-a2", "T600", { botToken: "xoxb-a" });
    const b = await store.upsertByTeam("org-b2", "T600", { botToken: "xoxb-b" });

    // org-a's row is demoted; org-b is the single active install.
    expect((await store.getById(a.id))?.status).toBe("stopped");
    expect((await store.getById(b.id))?.status).toBe("active");
    const found = await store.getByTeamId("T600");
    expect(found?.id).toBe(b.id);
    expect(found?.organizationId).toBe("org-b2");
  });

  test("delete removes the row and its secret", async () => {
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    const { resolveSecretValue } = await import("../../secrets/index.js");
    await seedAgentRow("throwaway", { organizationId: "org-inst" });
    const { store, secretStore } = await buildStore();

    const row = await store.upsertByTeam("org-inst", "T400", {
      botToken: "xoxb-doomed",
    });
    await store.delete(row.id);

    expect(await store.getById(row.id)).toBeNull();
    const resolved = await orgContext.run({ organizationId: "org-inst" }, () =>
      resolveSecretValue(secretStore, row.config.botToken)
    );
    expect(resolved).toBeUndefined();
  });

  test("markStopped flips status; getByTeamId still finds it but routing skips stopped", async () => {
    await seedAgentRow("throwaway", { organizationId: "org-inst" });
    const { store } = await buildStore();
    const row = await store.upsertByTeam("org-inst", "T500", {
      botToken: "xoxb-x",
    });

    await store.markStopped(row.id);
    const found = await store.getById(row.id);
    expect(found?.status).toBe("stopped");
  });
});
