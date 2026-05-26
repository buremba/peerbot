/**
 * Reproducers for two gateway/connections config-handling bugs:
 *
 *   #2 (security) — Telegram webhook forgeable when `secretToken` is unset.
 *       The adapter only verifies `x-telegram-bot-api-secret-token` when a
 *       secretToken is configured, and the public webhook route only checks
 *       the connection exists. `addConnection` must auto-generate a strong
 *       secretToken for Telegram connections created without one, persist it,
 *       and `configurePlatformWebhook` must register it via setWebhook so the
 *       adapter always verifies.
 *
 *   #8 — `configsEqual` was shallow (`!==` on top-level values), so a changed
 *       NESTED config field (e.g. an OAuth block or scopes array) compared
 *       equal by reference and `needsRestart` stayed false → a stale config
 *       persisted without restarting the adapter. The comparison must be deep.
 *
 * Uses the embedded Postgres gateway test harness; no network (fetch mocked).
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
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
}, 60_000);

beforeEach(async () => {
  await resetTestDatabase();
}, 30_000);

async function buildManager(orgId: string, agentId: string) {
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
  manager.slackCoordinator = manager.buildSlackCoordinator();

  return { manager, connectionStore, secretStore, orgContext };
}

describe("ChatInstanceManager — Telegram webhook secret (finding #2)", () => {
  test("addConnection auto-generates and persists a secretToken when none is supplied", async () => {
    const orgId = "org-tg-secret";
    const agentId = "agent-tg-secret";
    const { manager, connectionStore, secretStore, orgContext } =
      await buildManager(orgId, agentId);

    // Stub the adapter-boot side of addConnection so we exercise only the
    // auto-gen + persist path (booting a real Telegram adapter would hit the
    // network). The auto-gen happens before persistConnection regardless.
    manager.startInstance = async () => {
      /* no-op */
    };

    const created = await orgContext.run({ organizationId: orgId }, () =>
      manager.addConnection(
        "telegram",
        agentId,
        { platform: "telegram", botToken: "123456:fake-token" },
        { allowGroups: true }
      )
    );

    // The returned connection carries a strong (>=32 char) secretToken.
    const generated = created.config.secretToken as string;
    expect(typeof generated).toBe("string");
    expect(generated.length).toBeGreaterThanOrEqual(32);

    // It is persisted (as a `secret://` ref — "secretToken" is a secret field)
    // and resolves back to the generated value.
    const stored = await orgContext.run({ organizationId: orgId }, () =>
      connectionStore.getConnection(created.id)
    );
    expect(stored).not.toBeNull();
    const storedToken = (stored!.config as any).secretToken as string;
    expect(typeof storedToken).toBe("string");
    expect(storedToken.length).toBeGreaterThan(0);
    expect(storedToken.startsWith("secret://")).toBe(true);

    // The persisted ref resolves back to the generated value — so the adapter
    // gets the real token at boot and registers it via setWebhook.
    const resolved = await orgContext.run({ organizationId: orgId }, () =>
      secretStore.get(storedToken)
    );
    expect(resolved).toBe(generated);
  });

  test("addConnection preserves a caller-supplied secretToken", async () => {
    const orgId = "org-tg-keep";
    const agentId = "agent-tg-keep";
    const { manager, orgContext } = await buildManager(orgId, agentId);
    manager.startInstance = async () => {
      /* no-op */
    };

    const created = await orgContext.run({ organizationId: orgId }, () =>
      manager.addConnection(
        "telegram",
        agentId,
        {
          platform: "telegram",
          botToken: "123456:fake-token",
          secretToken: "caller-chosen-secret-token-value-1234",
        },
        { allowGroups: true }
      )
    );
    expect(created.config.secretToken).toBe(
      "caller-chosen-secret-token-value-1234"
    );
  });

  test("configurePlatformWebhook registers the secret_token via setWebhook", async () => {
    const orgId = "org-tg-hook";
    const agentId = "agent-tg-hook";
    const { manager } = await buildManager(orgId, agentId);

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as any;
    try {
      await manager.configurePlatformWebhook(
        {
          id: "conn-hook",
          platform: "telegram",
          config: {
            platform: "telegram",
            botToken: "123456:fake-token",
            secretToken: "the-generated-secret-token-abcdef0123",
          },
          settings: { allowGroups: true },
          metadata: {},
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        "https://gw.example.com/api/v1/webhooks/conn-hook"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toContain("/setWebhook");
    const sentBody = JSON.parse(String(call[1].body));
    expect(sentBody.secret_token).toBe("the-generated-secret-token-abcdef0123");
    expect(sentBody.url).toBe(
      "https://gw.example.com/api/v1/webhooks/conn-hook"
    );
  });

  test("ensureTelegramWebhookSecret backfills + persists a token for an existing no-token connection", async () => {
    const orgId = "org-tg-backfill";
    const agentId = "agent-tg-backfill";
    const { manager, connectionStore, orgContext } = await buildManager(
      orgId,
      agentId
    );

    // Seed a Telegram row WITHOUT a secretToken — the pre-fix forgeable shape
    // for connections created before auto-generation existed.
    await orgContext.run({ organizationId: orgId }, async () => {
      await connectionStore.saveConnection({
        id: "conn-legacy-tg",
        platform: "telegram",
        agentId,
        organizationId: orgId,
        config: { platform: "telegram", botToken: "123456:fake-token" },
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    // Drive the backfill the way startInstanceUnscoped does (config already
    // resolved to plaintext; here it has no secretToken).
    const runtimeConnection: any = {
      id: "conn-legacy-tg",
      platform: "telegram",
      agentId,
      organizationId: orgId,
      config: { platform: "telegram", botToken: "123456:fake-token" },
      settings: { allowGroups: true },
      metadata: {},
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await orgContext.run({ organizationId: orgId }, () =>
      manager.ensureTelegramWebhookSecret(runtimeConnection)
    );

    // In-memory config now carries a strong plaintext token (so this boot's
    // adapter verifies it and configurePlatformWebhook registers it).
    const token = runtimeConnection.config.secretToken as string;
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThanOrEqual(32);

    // The stored row gained a persisted (secret://-ref) token.
    const stored = await orgContext.run({ organizationId: orgId }, () =>
      connectionStore.getConnection("conn-legacy-tg")
    );
    const storedToken = (stored!.config as any).secretToken as string;
    expect(typeof storedToken).toBe("string");
    expect(storedToken.startsWith("secret://")).toBe(true);

    // A second backfill (e.g. another replica / a later restart) adopts the
    // already-persisted token instead of generating a fresh one.
    const secondConnection: any = {
      ...runtimeConnection,
      config: { platform: "telegram", botToken: "123456:fake-token" },
    };
    await orgContext.run({ organizationId: orgId }, () =>
      manager.ensureTelegramWebhookSecret(secondConnection)
    );
    expect(secondConnection.config.secretToken).toBe(token);
  });

  test("concurrent backfills for the same connection converge on one token (multi-replica)", async () => {
    const orgId = "org-tg-concurrent";
    const agentId = "agent-tg-concurrent";
    const { manager, connectionStore, secretStore, orgContext } =
      await buildManager(orgId, agentId);

    await orgContext.run({ organizationId: orgId }, async () => {
      await connectionStore.saveConnection({
        id: "conn-concurrent-tg",
        platform: "telegram",
        agentId,
        organizationId: orgId,
        config: { platform: "telegram", botToken: "123456:fake-token" },
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    // Two simulated replicas backfill the SAME legacy connection at once. The
    // row-locked claim must serialize them so both runtime configs (and the
    // persisted row) end up with one identical token — never divergent ones
    // that would leave a pod verifying a token Telegram no longer sends.
    const makeRuntime = () => ({
      id: "conn-concurrent-tg",
      platform: "telegram",
      agentId,
      organizationId: orgId,
      config: { platform: "telegram", botToken: "123456:fake-token" } as any,
      settings: { allowGroups: true },
      metadata: {},
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    // Several replicas race at once: a naive get-then-save lets multiple see
    // "no token" before any persists, so they diverge. The row lock serializes
    // them.
    const replicas = Array.from({ length: 8 }, makeRuntime);
    await orgContext.run({ organizationId: orgId }, () =>
      Promise.all(
        replicas.map((r) => manager.ensureTelegramWebhookSecret(r))
      )
    );

    const tokens = replicas.map((r) => r.config.secretToken as string);
    for (const t of tokens) {
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThanOrEqual(32);
    }
    // Every replica converged on a single token (no divergence).
    expect(new Set(tokens).size).toBe(1);

    // And it matches the single persisted row's token.
    const stored = await orgContext.run({ organizationId: orgId }, () =>
      connectionStore.getConnection("conn-concurrent-tg")
    );
    const storedRef = (stored!.config as any).secretToken as string;
    const resolvedStored = await orgContext.run(
      { organizationId: orgId },
      () => secretStore.get(storedRef)
    );
    expect(resolvedStored).toBe(tokens[0]);
  });
});

describe("ChatInstanceManager — Telegram webhook auth E2E (finding #2)", () => {
  // End-to-end: create a Telegram connection with no secretToken, then drive
  // the real webhook handler (manager.handleWebhook → the live Chat SDK
  // telegram adapter, the exact path POST /api/v1/webhooks/:id reaches) and
  // assert the auto-generated secret is actually enforced — wrong/missing
  // token is rejected (401), correct token is accepted. No real Telegram: the
  // adapter's getMe/setWebhook are stubbed via a mocked fetch.

  /** A Telegram update body the handler would otherwise dispatch. */
  const FORGED_UPDATE = JSON.stringify({
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Mallory" },
      text: "/promote me to admin",
    },
  });

  async function startTelegramInstance(
    manager: any,
    orgContext: any,
    orgId: string,
    connectionId: string,
    secretToken: string | undefined
  ): Promise<void> {
    // Build the live Chat + telegram adapter exactly like startInstance would,
    // carrying the (resolved) secretToken, and register it on the manager so
    // manager.handleWebhook routes to chat.webhooks.telegram. getMe/setWebhook
    // are no-ops via the mocked fetch.
    const { Chat } = await import("chat");
    const { createTelegramAdapter } = await import("@chat-adapter/telegram");
    const { createGatewayStateAdapter } = await import(
      "../connections/state-adapter.js"
    );

    const adapter = createTelegramAdapter({
      platform: "telegram",
      botToken: "123456:fake-token",
      mode: "webhook",
      ...(secretToken ? { secretToken } : {}),
    } as any);
    const stateAdapter = await orgContext.run(
      { organizationId: orgId },
      () => createGatewayStateAdapter()
    );
    const chat = new Chat({
      userName: `bot-${connectionId}`,
      adapters: { telegram: adapter },
      state: stateAdapter,
      logger: "warn",
    });
    await chat.initialize();

    manager.instances.set(connectionId, {
      connection: {
        id: connectionId,
        platform: "telegram",
        organizationId: orgId,
        config: {
          platform: "telegram",
          botToken: "123456:fake-token",
          ...(secretToken ? { secretToken } : {}),
        },
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      chat,
      conversationState: { listHistoryChannels: async () => [] },
      messageBridge: {},
    });
  }

  function webhookRequest(connectionId: string, secretHeader?: string) {
    return new Request(
      `https://gw.example.com/api/v1/webhooks/${connectionId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secretHeader
            ? { "x-telegram-bot-api-secret-token": secretHeader }
            : {}),
        },
        body: FORGED_UPDATE,
      }
    );
  }

  test("auto-generated secret is enforced: wrong/missing rejected, correct accepted", async () => {
    const orgId = "org-tg-e2e";
    const agentId = "agent-tg-e2e";
    const { manager, connectionStore, secretStore, orgContext } =
      await buildManager(orgId, agentId);

    const originalFetch = globalThis.fetch;
    // Stub Telegram REST (getMe / setWebhook) so adapter init + webhook
    // registration never touch the network.
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ ok: true, result: { id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ) as any;

    try {
      // Create the connection with NO secretToken — addConnection must
      // auto-generate one. Stub the heavy adapter-boot (full services) here;
      // we drive the real webhook handler separately below.
      manager.startInstance = async () => {
        /* exercised via startTelegramInstance below */
      };
      const created = await orgContext.run({ organizationId: orgId }, () =>
        manager.addConnection(
          "telegram",
          agentId,
          { platform: "telegram", botToken: "123456:fake-token" },
          { allowGroups: true }
        )
      );

      const realToken = created.config.secretToken as string;
      expect(typeof realToken).toBe("string");
      expect(realToken.length).toBeGreaterThanOrEqual(32);

      // Persisted as a resolvable ref.
      const stored = await orgContext.run({ organizationId: orgId }, () =>
        connectionStore.getConnection(created.id)
      );
      const storedRef = (stored!.config as any).secretToken as string;
      expect(storedRef.startsWith("secret://")).toBe(true);
      const resolved = await orgContext.run({ organizationId: orgId }, () =>
        secretStore.get(storedRef)
      );
      expect(resolved).toBe(realToken);

      // Bring up the real adapter carrying the auto-generated token.
      await startTelegramInstance(
        manager,
        orgContext,
        orgId,
        created.id,
        realToken
      );

      // No secret header → forged webhook REJECTED (401), not dispatched.
      const noHeader = await manager.handleWebhook(
        created.id,
        webhookRequest(created.id)
      );
      expect(noHeader.status).toBe(401);

      // Wrong secret → REJECTED.
      const wrong = await manager.handleWebhook(
        created.id,
        webhookRequest(created.id, "definitely-not-the-secret")
      );
      expect(wrong.status).toBe(401);

      // Correct secret → ACCEPTED (not 401; the handler proceeds).
      const right = await manager.handleWebhook(
        created.id,
        webhookRequest(created.id, realToken)
      );
      expect(right.status).not.toBe(401);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a connection with NO secret token is forgeable (the pre-fix hazard)", async () => {
    // Pins the vulnerability the auto-gen + backfill close: the adapter accepts
    // an unsigned webhook when no secretToken is configured. This is why
    // addConnection auto-generates and startInstance backfills — so this state
    // is never reached in practice.
    const orgId = "org-tg-e2e-vuln";
    const agentId = "agent-tg-e2e-vuln";
    const { manager, orgContext } = await buildManager(orgId, agentId);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ ok: true, result: { id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ) as any;
    try {
      await startTelegramInstance(
        manager,
        orgContext,
        orgId,
        "conn-no-secret",
        undefined
      );
      // No secretToken on the adapter → an unsigned forged update is ACCEPTED.
      const res = await manager.handleWebhook(
        "conn-no-secret",
        webhookRequest("conn-no-secret")
      );
      expect(res.status).not.toBe(401);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("ChatInstanceManager — config change detection (finding #8)", () => {
  // updateConnection restarts only `active` connections. We seed the row as
  // `stopped` so no adapter boot is attempted; we observe needsRestart's effect
  // indirectly via whether stopInstance/startInstance run. Cleaner: spy on the
  // private startInstance + stopInstance and assert they fire (or not) for a
  // nested change. We keep status `active` but stub both lifecycle hooks.
  let restored: (() => void) | null = null;
  afterEach(() => {
    restored?.();
    restored = null;
  });

  async function seedActiveConnection(
    manager: any,
    connectionStore: any,
    orgContext: any,
    orgId: string,
    agentId: string,
    config: Record<string, unknown>
  ): Promise<string> {
    const id = "conn-cfg";
    await orgContext.run({ organizationId: orgId }, async () => {
      await connectionStore.saveConnection({
        id,
        platform: config.platform,
        agentId,
        organizationId: orgId,
        config,
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    // Pretend the instance is warm so updateConnection's `active` branch runs.
    manager.instances.set(id, {
      connection: {
        id,
        platform: config.platform,
        agentId,
        organizationId: orgId,
        config,
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      chat: {},
      conversationState: {},
      messageBridge: {},
    });
    return id;
  }

  test("a changed NESTED config field flips needsRestart to true", async () => {
    const orgId = "org-cfg-nested";
    const agentId = "agent-cfg-nested";
    const { manager, connectionStore, orgContext } = await buildManager(
      orgId,
      agentId
    );

    // Discord config with a nested object/array that differs only deep down.
    const initialConfig = {
      platform: "discord",
      botToken: "tok-1",
      mentionRoleIds: ["role-A", "role-B"],
    };
    const id = await seedActiveConnection(
      manager,
      connectionStore,
      orgContext,
      orgId,
      agentId,
      initialConfig
    );

    let stopped = 0;
    let started = 0;
    const origStop = manager.stopInstance.bind(manager);
    const origStart = manager.startInstance.bind(manager);
    manager.stopInstance = async (cid: string) => {
      stopped++;
      manager.instances.delete(cid);
    };
    manager.startInstance = async () => {
      started++;
    };
    restored = () => {
      manager.stopInstance = origStop;
      manager.startInstance = origStart;
    };

    // Change only a nested array element. A shallow compare sees the array
    // reference differ from the resolved-previous (also reconstructed), but the
    // ORIGINAL bug compared the *same* nested reference and missed real changes.
    // Concretely: re-applying an identical config must NOT restart, while a
    // genuine nested change MUST restart. Test the genuine-change direction.
    await orgContext.run({ organizationId: orgId }, () =>
      manager.updateConnection(id, {
        config: {
          platform: "discord",
          botToken: "tok-1",
          mentionRoleIds: ["role-A", "role-CHANGED"],
        },
      })
    );

    expect(started).toBe(1);
    expect(stopped).toBe(1);
  });

  test("re-applying an identical nested config does NOT restart", async () => {
    const orgId = "org-cfg-same";
    const agentId = "agent-cfg-same";
    const { manager, connectionStore, orgContext } = await buildManager(
      orgId,
      agentId
    );

    const config = {
      platform: "discord",
      botToken: "tok-1",
      mentionRoleIds: ["role-A", "role-B"],
    };
    const id = await seedActiveConnection(
      manager,
      connectionStore,
      orgContext,
      orgId,
      agentId,
      config
    );

    let restartFired = false;
    const origStop = manager.stopInstance.bind(manager);
    const origStart = manager.startInstance.bind(manager);
    manager.stopInstance = async () => {
      restartFired = true;
    };
    manager.startInstance = async () => {
      restartFired = true;
    };
    restored = () => {
      manager.stopInstance = origStop;
      manager.startInstance = origStart;
    };

    await orgContext.run({ organizationId: orgId }, () =>
      manager.updateConnection(id, {
        config: {
          platform: "discord",
          botToken: "tok-1",
          // Same values, NEW array reference + different key order.
          mentionRoleIds: ["role-A", "role-B"],
        },
      })
    );

    expect(restartFired).toBe(false);
  });
});
