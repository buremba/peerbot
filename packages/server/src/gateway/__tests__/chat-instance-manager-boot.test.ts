/**
 * Regression coverage for connection status health, previously owned by the
 * eager boot loop in ChatInstanceManager.initialize() and now owned by the
 * single-claimant `connection-health` sweep (sweepConnectionHealth).
 *
 * Pins the behaviour that prod regressed against on 2026-05-13 (#692): an
 * encryption-key parser tightening made every connection's secret resolution
 * throw, rows were marked `status='error'` — and the followup fix did not
 * recover them because nothing retried `error` rows. The sweep must:
 *
 *   1. Mark connections whose secret refs no longer resolve as `error`,
 *      under the connection's own org context (saveConnection requires it —
 *      the sweep runs request-less).
 *   2. Recover `error` rows whose recorded failure was a secret-resolution
 *      failure once resolution succeeds again (the #692 class), without
 *      flipping rows errored by live startup failures (dead tokens).
 *
 * Uses the embedded Postgres gateway test harness; no network — the sweep
 * never starts adapters.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  await ensureDbForGatewayTests();
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
});

beforeEach(async () => {
  await resetTestDatabase();
});

async function buildManagerAndStores(orgId: string, agentId: string) {
  await seedAgentRow(agentId, { organizationId: orgId });

  const { ChatInstanceManager } = await import(
    "../connections/chat-instance-manager.js"
  );
  const { createPostgresAgentConnectionStore } = await import(
    "../../lobu/stores/postgres-stores.js"
  );
  const { PostgresSecretStore } = await import(
    "../../lobu/stores/postgres-secret-store.js"
  );
  const { SecretStoreRegistry } = await import("../secrets/index.js");
  const { orgContext } = await import("../../lobu/stores/org-context.js");

  const connectionStore = createPostgresAgentConnectionStore();
  const postgresSecretStore = new PostgresSecretStore();
  const secretStore = new SecretStoreRegistry(postgresSecretStore, {
    secret: postgresSecretStore,
  });

  return {
    manager: new ChatInstanceManager() as any,
    connectionStore,
    secretStore,
    orgContext,
  };
}

/**
 * Wire the manager's collaborators without initialize() — initialize starts
 * the exclusive-claim runner, which is not under test here and whose async
 * tick would race the assertions.
 */
function wireManager(manager: any, services: any): void {
  manager.services = services;
  manager.publicGatewayUrl = "";
  manager.connectionStore = services.getConnectionStore();
}

describe("connection-health sweep (boot-loop successor)", () => {
  test("recovers `error` rows whose secret-resolution failure has healed (#692 class)", async () => {
    const orgId = "test-org-recover";
    const agentId = "agent-recover";
    const { manager, connectionStore, secretStore, orgContext } =
      await buildManagerAndStores(orgId, agentId);

    // Persist the secret + connection row in the correct org so the
    // secret resolution at boot succeeds. Seed status=`error` to mimic the
    // post-regression state — the row should be retried, succeed, and the
    // error marker cleared.
    const tokenRef = await orgContext.run(
      { organizationId: orgId },
      () =>
        secretStore.put(
          "connections/conn-recover-test/botToken",
          "test-bot-token-value"
        )
    );
    await orgContext.run({ organizationId: orgId }, async () => {
      await connectionStore.saveConnection({
        id: "conn-recover-test",
        platform: "telegram",
        agentId,
        organizationId: orgId,
        config: { platform: "telegram", botToken: tokenRef },
        settings: { allowGroups: true },
        metadata: {},
        status: "error",
        errorMessage:
          'Startup failed: Failed to resolve secret ref for connection conn-recover-test field "botToken"',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const services = {
      getPublicGatewayUrl: () => "",
      getSecretStore: () => secretStore,
      getConnectionStore: () => connectionStore,
      getChannelBindingService: () => ({ getBindingForConnection: async () => null }),
      getCommandRegistry: () => undefined,
    } as any;

    wireManager(manager, services);
    const result = await manager.sweepConnectionHealth();
    expect(result.recovered).toBe(1);

    const stored = await orgContext.run({ organizationId: orgId }, () =>
      connectionStore.getConnection("conn-recover-test")
    );
    expect(stored).not.toBeNull();
    // The secret resolves again, and the recorded failure was a
    // resolution failure — the sweep must un-stick the row.
    expect(stored!.status).toBe("active");
    expect(stored!.errorMessage ?? null).toBeNull();
  });

  test("does NOT recover `error` rows whose failure was not provably healed", async () => {
    const orgId = "test-org-no-recover";
    const agentId = "agent-no-recover";
    const { manager, connectionStore, secretStore, orgContext } =
      await buildManagerAndStores(orgId, agentId);

    const tokenRef = await orgContext.run({ organizationId: orgId }, () =>
      secretStore.put("connections/conn-dead-token/botToken", "resolvable")
    );
    await orgContext.run({ organizationId: orgId }, async () => {
      await connectionStore.saveConnection({
        id: "conn-dead-token",
        platform: "telegram",
        agentId,
        organizationId: orgId,
        config: { platform: "telegram", botToken: tokenRef },
        settings: { allowGroups: true },
        metadata: {},
        // Live startup failure (e.g. revoked token): secrets resolve fine,
        // but only a successful real start may clear this.
        status: "error",
        errorMessage: "Startup failed: Telegram getMe returned 401",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const services = {
      getPublicGatewayUrl: () => "",
      getSecretStore: () => secretStore,
      getConnectionStore: () => connectionStore,
      getChannelBindingService: () => ({ getBindingForConnection: async () => null }),
      getCommandRegistry: () => undefined,
    } as any;
    wireManager(manager, services);

    const result = await manager.sweepConnectionHealth();
    expect(result.recovered).toBe(0);

    const stored = await orgContext.run({ organizationId: orgId }, () =>
      connectionStore.getConnection("conn-dead-token")
    );
    expect(stored!.status).toBe("error");
  });

  test("marks failed connections as `error` under the connection's org context", async () => {
    // Seed a connection that points at a secret ref pointing at a
    // non-existent name. Resolution will fail; the catch block must mark
    // the row `error` — and that update is a per-tenant write that
    // requires org context to be bound. If the catch path forgets to
    // wrap in orgContext.run() the SaveConnection call throws "no org
    // context" and the row stays `active`, hiding the failure.

    const orgId = "test-org-error-mark";
    const agentId = "agent-error-mark";
    const { manager, connectionStore, secretStore, orgContext } =
      await buildManagerAndStores(orgId, agentId);

    await orgContext.run({ organizationId: orgId }, async () => {
      await connectionStore.saveConnection({
        id: "conn-error-mark",
        platform: "slack",
        agentId,
        organizationId: orgId,
        config: {
          platform: "slack",
          // Deliberately bogus ref — the underlying secret was never put.
          botToken: "secret://connections%2Fconn-error-mark%2FbotToken",
          signingSecret: "test-signing",
        },
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const services = {
      getPublicGatewayUrl: () => "",
      getSecretStore: () => secretStore,
      getConnectionStore: () => connectionStore,
      getChannelBindingService: () => ({ getBindingForConnection: async () => null }),
      getCommandRegistry: () => undefined,
    } as any;

    wireManager(manager, services);
    const result = await manager.sweepConnectionHealth();
    expect(result.errored).toBe(1);

    const stored = await orgContext.run({ organizationId: orgId }, () =>
      connectionStore.getConnection("conn-error-mark")
    );
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("error");
    expect(stored!.errorMessage ?? "").toContain(
      "Failed to resolve secret ref"
    );
  });

  test("startInstance rebinds to the connection's org even when caller's org differs", async () => {
    // Cross-tenant isolation: an admin in org B triggering a flow that
    // ends up calling startInstance on org A's connection must still
    // resolve org A's secret (the row's org), not query org B's bucket.
    // Without the unconditional rebind in startInstance, the caller's
    // org wins and the secret lookup returns null.

    const orgA = "test-org-A";
    const orgB = "test-org-B";
    const agentA = "agent-A";

    const { manager, connectionStore, secretStore, orgContext } =
      await buildManagerAndStores(orgA, agentA);
    await seedAgentRow("agent-B", { organizationId: orgB });

    // Secret stored in org A's bucket.
    const tokenRef = await orgContext.run({ organizationId: orgA }, () =>
      secretStore.put(
        "connections/conn-cross-org/botToken",
        "real-org-A-token"
      )
    );

    await orgContext.run({ organizationId: orgA }, async () => {
      await connectionStore.saveConnection({
        id: "conn-cross-org",
        platform: "telegram",
        agentId: agentA,
        organizationId: orgA,
        config: { platform: "telegram", botToken: tokenRef },
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const services = {
      getPublicGatewayUrl: () => "",
      getSecretStore: () => secretStore,
      getConnectionStore: () => connectionStore,
      getChannelBindingService: () => ({ getBindingForConnection: async () => null }),
      getCommandRegistry: () => undefined,
    } as any;
    manager.services = services;
    manager.publicGatewayUrl = "";
    manager.connectionStore = connectionStore;

    // Look up the connection from the store using its own org context,
    // then call startInstance from *org B's* context. The previous
    // implementation would skip the rebind because the caller already
    // had an org — and would query org B's secret bucket and 404. The
    // current implementation rebinds unconditionally.
    const stored = await orgContext.run({ organizationId: orgA }, () =>
      connectionStore.getConnection("conn-cross-org")
    );
    expect(stored).not.toBeNull();

    let secretResolutionError: string | null = null;
    await orgContext.run({ organizationId: orgB }, async () => {
      try {
        // The adapter init will probably still fail (fake token, no
        // Telegram), but that failure is not a secret-resolution failure
        // — and that's the point of this test.
        await manager.startInstance({
          id: stored!.id,
          platform: stored!.platform,
          agentId: stored!.agentId,
          organizationId: stored!.organizationId,
          config: stored!.config,
          settings: stored!.settings,
          metadata: stored!.metadata,
          status: stored!.status,
          createdAt: stored!.createdAt,
          updatedAt: stored!.updatedAt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Failed to resolve secret ref")) {
          secretResolutionError = msg;
        }
      }
    });

    expect(secretResolutionError).toBeNull();
  });
});
