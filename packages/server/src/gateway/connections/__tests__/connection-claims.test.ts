/**
 * Multi-replica contracts for the connection-row model (#1139 successor):
 *
 *  1. `connection_claims` lease: exactly ONE replica runs an exclusive
 *     (long-polling) connection. Two managers sharing a DB tick their claim
 *     loops; one wins, the other must not start. Lease handoff works via
 *     explicit release (shutdown) and via heartbeat expiry (pod death).
 *  2. Row-versioned hydration: a replica serving a connection re-hydrates
 *     when the stored row is newer (config edited on any replica) and tears
 *     down when the row is stopped/deleted — no cross-pod restart fan-out.
 *  3. `idx_agent_connections_slack_workspace`: the DB refuses a second
 *     non-stopped Slack connection for the same (org, workspace), closing
 *     the concurrent-install race.
 *
 * Two ChatInstanceManager instances against ONE embedded Postgres simulate
 * two replicas. Adapter startup is stubbed (network-free): hydrateFromRow is
 * replaced with a recorder that registers a fake instance, exactly like the
 * real path's outcome, while the claim SQL and ensure logic stay real.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "../../__tests__/helpers/db-setup.js";

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  await ensureDbForGatewayTests();
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
}, 60_000);

beforeEach(async () => {
  await resetTestDatabase();
}, 30_000);

async function buildReplica() {
  const { ChatInstanceManager } = await import("../chat-instance-manager.js");
  const { createPostgresAgentConnectionStore } = await import(
    "../../../lobu/stores/postgres-stores.js"
  );
  const { PostgresSecretStore } = await import(
    "../../../lobu/stores/postgres-secret-store.js"
  );
  const { SecretStoreRegistry } = await import("../../secrets/index.js");

  const connectionStore = createPostgresAgentConnectionStore();
  const postgresSecretStore = new PostgresSecretStore();
  const secretStore = new SecretStoreRegistry(postgresSecretStore, {
    secret: postgresSecretStore,
  });
  const services = {
    getPublicGatewayUrl: () => "",
    getSecretStore: () => secretStore,
    getConnectionStore: () => connectionStore,
    getChannelBindingService: () => ({ getBinding: async () => null }),
    getCommandRegistry: () => undefined,
  } as any;

  const manager = new ChatInstanceManager() as any;
  manager.services = services;
  manager.publicGatewayUrl = "";
  manager.connectionStore = connectionStore;

  // Network-free start: register a fake instance the way the real
  // hydrateFromRow would, and record the call.
  manager.hydrateCalls = [] as string[];
  manager.hydrateFromRow = async (stored: any) => {
    manager.hydrateCalls.push(stored.id);
    manager.instances.set(stored.id, {
      connection: { id: stored.id, platform: stored.platform },
      chat: {},
      conversationState: {},
      messageBridge: {},
      rowVersion: stored.updatedAt,
    });
  };

  return { manager, connectionStore };
}

async function seedTelegramPolling(
  connectionStore: any,
  orgId: string,
  agentId: string,
  connectionId: string
): Promise<void> {
  const { orgContext } = await import("../../../lobu/stores/org-context.js");
  await seedAgentRow(agentId, { organizationId: orgId });
  await orgContext.run({ organizationId: orgId }, async () => {
    await connectionStore.saveConnection({
      id: connectionId,
      platform: "telegram",
      agentId,
      organizationId: orgId,
      config: {
        platform: "telegram",
        botToken: "12345:fake",
        mode: "polling",
      },
      settings: { allowGroups: true },
      metadata: {},
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

describe("connection_claims lease (exclusive transports)", () => {
  test("exactly one of two replicas runs a polling connection; handoff on release and on expiry", async () => {
    const { getDb } = await import("../../../db/client.js");
    const { manager: a } = await buildReplica();
    const { manager: b, connectionStore } = await buildReplica();

    await seedTelegramPolling(connectionStore, "org-lease", "agent-lease", "conn-poll");

    // Both replicas tick: exactly one must hold the instance.
    await a.exclusiveTick();
    await b.exclusiveTick();
    const aHas = a.instances.has("conn-poll");
    const bHas = b.instances.has("conn-poll");
    expect(aHas !== bHas).toBe(true);

    const owner = aHas ? a : b;
    const other = aHas ? b : a;

    // Renewal: the owner keeps the lease across ticks; the other still can't start.
    await owner.exclusiveTick();
    await other.exclusiveTick();
    expect(owner.instances.has("conn-poll")).toBe(true);
    expect(other.instances.has("conn-poll")).toBe(false);

    // Explicit release (clean shutdown): the peer claims on its next tick.
    await owner.shutdown();
    await other.exclusiveTick();
    expect(other.instances.has("conn-poll")).toBe(true);

    // Heartbeat expiry (pod death): age the claim past the TTL; a fresh
    // replica must be able to take over without any release.
    const { manager: c } = await buildReplica();
    await getDb()`
      UPDATE connection_claims
      SET heartbeat_at = now() - interval '120 seconds'
      WHERE connection_id = 'conn-poll'
    `;
    await c.exclusiveTick();
    expect(c.instances.has("conn-poll")).toBe(true);
    // The stale former owner loses on its next tick and stops its loop.
    await other.exclusiveTick();
    expect(other.instances.has("conn-poll")).toBe(false);
  });

  test("request paths never start an exclusive connection on a non-owner replica", async () => {
    const { manager: a } = await buildReplica();
    const { manager: b, connectionStore } = await buildReplica();
    await seedTelegramPolling(connectionStore, "org-req", "agent-req", "conn-poll-2");

    await a.exclusiveTick();
    expect(a.instances.has("conn-poll-2")).toBe(true);

    // A webhook/fan-out path on the non-owner must refuse, not start a
    // second polling loop.
    const ok = await b.warmConnection("conn-poll-2");
    expect(ok).toBe(false);
    expect(b.instances.has("conn-poll-2")).toBe(false);
    expect(b.hydrateCalls).toEqual([]);
  });
});

describe("row-versioned lazy hydration (webhook transports)", () => {
  async function seedSlack(
    connectionStore: any,
    orgId: string,
    agentId: string,
    connectionId: string
  ): Promise<void> {
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    await seedAgentRow(agentId, { organizationId: orgId });
    await orgContext.run({ organizationId: orgId }, async () => {
      await connectionStore.saveConnection({
        id: connectionId,
        platform: "slack",
        agentId,
        organizationId: orgId,
        config: { platform: "slack", botToken: "xoxb-fake" },
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
  }

  test("a config edit on replica A re-hydrates replica B on next use; a stop tears it down", async () => {
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    const { manager: a, connectionStore } = await buildReplica();
    const { manager: b } = await buildReplica();
    await seedSlack(connectionStore, "org-rv", "agent-rv", "conn-rv");

    // Replica B serves the connection (cold pod, lazy hydration).
    expect(await b.warmConnection("conn-rv")).toBe(true);
    expect(b.hydrateCalls).toEqual(["conn-rv"]);

    // Fresh memo: a second use does NOT re-hydrate.
    expect(await b.warmConnection("conn-rv")).toBe(true);
    expect(b.hydrateCalls).toEqual(["conn-rv"]);

    // Replica A edits the row (store bumps updated_at). The next use on B
    // must re-hydrate from the new row — no cross-pod fan-out involved.
    await new Promise((r) => setTimeout(r, 5));
    await orgContext.run({ organizationId: "org-rv" }, async () => {
      await connectionStore.updateConnection("conn-rv", {
        config: { platform: "slack", botToken: "xoxb-rotated" } as any,
      });
    });
    expect(await b.warmConnection("conn-rv")).toBe(true);
    expect(b.hydrateCalls).toEqual(["conn-rv", "conn-rv"]);

    // Replica A stops the row; B's next use tears its local instance down.
    await orgContext.run({ organizationId: "org-rv" }, async () => {
      await connectionStore.updateConnection("conn-rv", { status: "stopped" });
    });
    expect(await b.warmConnection("conn-rv")).toBe(false);
    expect(b.instances.has("conn-rv")).toBe(false);
    void a;
  });
});

describe("updateConnection config rejection (parity with addConnection)", () => {
  test("flipping a Telegram connection to polling under cloud mode is refused before persist", async () => {
    const originalCloud = process.env.LOBU_CLOUD_MODE;
    process.env.LOBU_CLOUD_MODE = "1";
    try {
      const { orgContext } = await import(
        "../../../lobu/stores/org-context.js"
      );
      const { manager, connectionStore } = await buildReplica();
      await seedAgentRow("agent-upd-rej", { organizationId: "org-upd-rej" });
      await orgContext.run({ organizationId: "org-upd-rej" }, async () => {
        await connectionStore.saveConnection({
          id: "conn-upd-rej",
          platform: "telegram",
          agentId: "agent-upd-rej",
          organizationId: "org-upd-rej",
          config: {
            platform: "telegram",
            botToken: "12345:fake",
            mode: "webhook",
          },
          settings: { allowGroups: true },
          metadata: {},
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      });

      await expect(
        orgContext.run({ organizationId: "org-upd-rej" }, () =>
          manager.updateConnection("conn-upd-rej", {
            config: {
              platform: "telegram",
              botToken: "12345:fake",
              mode: "polling",
            },
          })
        )
      ).rejects.toThrow(/Polling mode/);

      // The refused config must NOT have been persisted.
      const stored = await orgContext.run(
        { organizationId: "org-upd-rej" },
        () => connectionStore.getConnection("conn-upd-rej")
      );
      expect((stored!.config as any).mode).toBe("webhook");
    } finally {
      if (originalCloud !== undefined) {
        process.env.LOBU_CLOUD_MODE = originalCloud;
      } else {
        delete process.env.LOBU_CLOUD_MODE;
      }
    }
  });

  test("a failing eager restart in updateConnection marks the persisted row errored", async () => {
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    const { manager, connectionStore } = await buildReplica();
    await seedAgentRow("agent-upd-err", { organizationId: "org-upd-err" });
    await orgContext.run({ organizationId: "org-upd-err" }, async () => {
      await connectionStore.saveConnection({
        id: "conn-upd-err",
        platform: "slack",
        agentId: "agent-upd-err",
        organizationId: "org-upd-err",
        config: { platform: "slack", botToken: "xoxb-old" },
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    manager.hydrateFromRow = async () => {
      throw new Error("adapter exploded");
    };

    await expect(
      orgContext.run({ organizationId: "org-upd-err" }, () =>
        manager.updateConnection("conn-upd-err", {
          config: { platform: "slack", botToken: "xoxb-broken" },
        })
      )
    ).rejects.toThrow("adapter exploded");

    // The new config persisted (the edit isn't silently lost), but the row
    // must reflect that it cannot start — not sit `active` until next use.
    const stored = await orgContext.run({ organizationId: "org-upd-err" }, () =>
      connectionStore.getConnection("conn-upd-err")
    );
    expect(stored!.status).toBe("error");
    expect(stored!.errorMessage ?? "").toContain("adapter exploded");
  });
});

describe("idx_agent_connections_slack_workspace (install race)", () => {
  test("a second non-stopped Slack connection for the same (org, teamId) is refused by the DB", async () => {
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    const { connectionStore } = await buildReplica();
    await seedAgentRow("agent-slack-uniq", { organizationId: "org-uniq" });

    const row = (id: string) => ({
      id,
      platform: "slack",
      agentId: "agent-slack-uniq",
      organizationId: "org-uniq",
      config: { platform: "slack", botToken: "xoxb-1" },
      settings: { allowGroups: true },
      metadata: { teamId: "T0DUP" },
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await orgContext.run({ organizationId: "org-uniq" }, async () => {
      await connectionStore.saveConnection(row("conn-uniq-1"));
    });

    let failed: unknown = null;
    await orgContext.run({ organizationId: "org-uniq" }, async () => {
      try {
        await connectionStore.saveConnection(row("conn-uniq-2"));
      } catch (error) {
        failed = error;
      }
    });
    expect(String(failed)).toContain("idx_agent_connections_slack_workspace");

    // A stopped duplicate is allowed (history rows demoted by the migration).
    await orgContext.run({ organizationId: "org-uniq" }, async () => {
      await connectionStore.saveConnection({
        ...row("conn-uniq-3"),
        status: "stopped" as const,
      });
    });

    // A different workspace in the same org is allowed.
    await orgContext.run({ organizationId: "org-uniq" }, async () => {
      await connectionStore.saveConnection({
        ...row("conn-uniq-4"),
        metadata: { teamId: "T0OTHER" },
      });
    });
  });
});
