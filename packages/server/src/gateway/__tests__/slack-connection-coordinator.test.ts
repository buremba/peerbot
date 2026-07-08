import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { getDb } from "../../db/client.js";
import {
  getSlackInstallByEnterpriseId,
  upsertSlackInstallByTeam,
} from "../../lobu/stores/slack-installations.js";
import {
  maybeSendSlackWorkspaceWelcome,
  SlackConnectionCoordinator,
} from "../connections/slack-connection-coordinator.js";
import type { PlatformConnection } from "../connections/types.js";
import { ensureDbForGatewayTests } from "./helpers/db-setup.js";

function createSlackConnection(
  id: string,
  metadata: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
	settings: PlatformConnection["settings"] = { allowGroups: true },
): PlatformConnection {
  return {
    id,
    platform: "slack",
    agentId: "template",
    config: {
      platform: "slack",
      signingSecret: "signing-secret",
      clientId: "client-id",
      clientSecret: "client-secret",
      ...config,
    } as any,
    settings,
    metadata,
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  };
}

type Deps = ConstructorParameters<typeof SlackConnectionCoordinator>[0];
type AppStore = ReturnType<Deps["getAppInstallationStore"]>;
type AppRow = Awaited<ReturnType<AppStore["upsert"]>>;
type TrackedAppStore = AppStore & { __upsertCalls: Array<Record<string, any>> };
type TrackedSecretStore = ReturnType<Deps["getSecretStore"]> & {
	__putCalls: string[];
};

/**
 * In-memory AppInstallationStore so the Slack install projection
 * (upsertSlackInstallByTeam / getSlackInstallByTeamId) runs end-to-end in this
 * unit test — no Postgres. Implements just the methods the projection uses;
 * `upsert` enforces one-active-per-team (the real store's invariant).
 */
function makeAppInstallationStore(): TrackedAppStore {
  let nextId = 1;
  const rows: AppRow[] = [];
	const upsertCalls: Array<Record<string, any>> = [];
  const tupleEq = (r: AppRow, u: any) =>
    r.provider === u.provider &&
    r.providerInstance === u.providerInstance &&
    r.providerAppId === u.providerAppId &&
    r.externalTenantId === u.externalTenantId;
  return {
		upsert: async (u: any) => {
			upsertCalls.push(u);
      const status = u.status ?? "active";
      if (status === "active") {
				const active = rows.find((r) => tupleEq(r, u) && r.status === "active");
        if (active && active.organizationId === u.organizationId) {
          // In-place update: preserve requested metadata keys from the existing
          // row (matches the real store's race-safe external_id claim).
          const merged = { ...(u.metadata ?? {}) };
          for (const key of u.preserveMetadataKeysOnUpdate ?? []) {
            if (active.metadata?.[key] !== undefined) {
              merged[key] = active.metadata[key];
            }
          }
          active.metadata = merged;
          active.authProfileId = u.authProfileId ?? null;
          active.updatedAt = Date.now();
          return active;
        }
        if (active) active.status = "suspended";
      }
      const row: AppRow = {
        id: nextId++,
        organizationId: u.organizationId,
        provider: u.provider,
        providerInstance: u.providerInstance,
        providerAppId: u.providerAppId,
        externalTenantId: u.externalTenantId,
        authProfileId: u.authProfileId ?? null,
        status,
        metadata: u.metadata ?? {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      rows.push(row);
      return row;
		},
		resolveActiveByTenant: async (key: any) => {
			return rows.find((r) => tupleEq(r, key) && r.status === "active") ?? null;
		},
		resolveSoleActiveByMetadata: async (
			provider: string,
			providerAppId: string,
			key: string,
			value: string,
		) => {
			const matches = rows.filter(
				(r) =>
					r.provider === provider &&
					r.providerAppId === providerAppId &&
					r.status === "active" &&
					r.metadata[key] === value,
			);
			// Unambiguous only — 2+ matches ⇒ null (see resolveSoleActiveByMetadata).
			return matches.length === 1 ? matches[0] : null;
		},
		resolveActiveByMetadataFlag: async (
			provider: string,
			providerAppId: string,
			key: string,
			value: string,
			flagKey: string,
		) => {
			const matches = rows.filter(
				(r) =>
					r.provider === provider &&
					r.providerAppId === providerAppId &&
					r.status === "active" &&
					r.metadata[key] === value &&
					r.metadata[flagKey] === true,
			);
			// Unambiguous only — 2+ matches ⇒ null (see resolveActiveByMetadataFlag).
			return matches.length === 1 ? matches[0] : null;
		},
		getByTenantAndOrg: async (key: any, org: string) => {
      const matches = rows.filter(
				(r) => tupleEq(r, key) && r.organizationId === org,
      );
      matches.sort(
        (a, b) =>
          Number(b.status === "active") - Number(a.status === "active") ||
					b.updatedAt - a.updatedAt,
      );
      return matches[0] ?? null;
		},
		resolveByExternalId: async (provider: string, externalId: string) => {
      const matches = rows.filter(
				(r) => r.provider === provider && r.metadata.external_id === externalId,
      );
      matches.sort(
        (a, b) =>
          Number(b.status === "active") - Number(a.status === "active") ||
					b.updatedAt - a.updatedAt,
      );
      return matches[0] ?? null;
		},
		listByProviderAndOrg: async (provider: string, org: string) =>
      rows
        .filter((r) => r.provider === provider && r.organizationId === org)
				.sort((a, b) => b.createdAt - a.createdAt),
		getById: async (id: number) => rows.find((r) => r.id === id) ?? null,
		listByOrg: async (org: string) =>
			rows.filter((r) => r.organizationId === org),
		setStatus: async (id: number, status: any) => {
      const r = rows.find((x) => x.id === id);
      if (r) r.status = status;
		},
		revoke: async () => undefined,
		setStatusByExternalId: async (
			provider: string,
			externalId: string,
			status: any,
		) => {
        for (const r of rows) {
          if (r.provider === provider && r.metadata.external_id === externalId) {
            r.status = status;
          }
        }
		},
		deleteByExternalId: async (provider: string, externalId: string) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (r.provider === provider && r.metadata.external_id === externalId) {
          rows.splice(i, 1);
        }
      }
		},
		__upsertCalls: upsertCalls,
	} as unknown as TrackedAppStore;
}

/** No-op secret store: returns a deterministic ref so token persistence works. */
function makeSecretStore(): TrackedSecretStore {
	const putCalls: string[] = [];
  return {
		get: async () => null,
		put: async (name: string) => {
			putCalls.push(name);
			return `secret://${encodeURIComponent(name)}`;
		},
		delete: async () => undefined,
		list: async () => [],
		__putCalls: putCalls,
	} as unknown as TrackedSecretStore;
}

/** Deps stub with sensible no-op defaults; override per test. */
function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    createStateAdapter: mock(async () => ({})),
    ensureConnectionRunning: mock(async () => true),
    forwardWebhook: mock(async () => new Response("ok")),
    getRunningChat: () => undefined,
    listSlackConnections: async () => [],
    getAppInstallationStore: () => makeAppInstallationStore(),
    getSecretStore: () => makeSecretStore(),
    ...overrides,
  };
}

const SLACK_ENV_KEYS = [
  "SLACK_SIGNING_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_BOT_TOKEN",
  "SLACK_ENCRYPTION_KEY",
  "SLACK_INSTALLATION_KEY_PREFIX",
  "SLACK_USER_NAME",
] as const;

describe("SlackConnectionCoordinator", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    for (const key of SLACK_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // The managed-install path now dual-writes a `connections` projection (Stage
    // 2a), whose organization_id FKs `organization` — seed the test org so the
    // write-through INSERT is satisfied (an OAuth install always has a real org).
    await getDb()`
      INSERT INTO organization (id, name, slug)
      VALUES ('org-acme', 'Acme', 'org-acme') ON CONFLICT DO NOTHING
    `;
    await getDb()`DELETE FROM connections WHERE organization_id = 'org-acme'`;
  });

  afterEach(async () => {
    for (const key of SLACK_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await getDb()`DELETE FROM connections WHERE organization_id = 'org-acme'`;
  });

  test("handleAppWebhook routes a matched team to its OAuth installation", async () => {
    const body = JSON.stringify({ team_id: "T777", type: "event_callback" });
    const forwarded: string[] = [];
    const appStore = makeAppInstallationStore();
    const secretStore = makeSecretStore();
    // Seed an OAuth install for the team (no BYO connection exists).
    const seeded = await upsertSlackInstallByTeam(
      appStore,
      secretStore,
      "org-acme",
      "T777",
			{ botToken: "xoxb-T777" },
    );
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        listSlackConnections: async () => [],
        getAppInstallationStore: () => appStore,
        getSecretStore: () => secretStore,
        forwardWebhook: mock(async (connectionId: string) => {
          forwarded.push(connectionId);
          return new Response("ok");
        }),
			}),
    );

    const response = await coordinator.handleAppWebhook(
      new Request("https://gateway.example.com/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
			}),
    );

    expect(response.status).toBe(200);
    expect(forwarded).toEqual([seeded.id]);
  });

  test("Grid: a DM stamped with a sibling team id routes via the enterprise fallback", async () => {
    // A Slack Enterprise Grid workspace is installed against one team id, but its
    // message.im events arrive stamped with a DIFFERENT sibling workspace's
    // team_id — only the shared enterprise_id links them. The exact team-id
    // lookup misses; routing must fall back to the enterprise id.
    const forwarded: string[] = [];
    const appStore = makeAppInstallationStore();
    const secretStore = makeSecretStore();
    const seeded = await upsertSlackInstallByTeam(
      appStore,
      secretStore,
      "org-acme",
      "T-INSTALL",
      { botToken: "xoxb-grid", enterpriseId: "E-GRID" },
    );
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        listSlackConnections: async () => [],
        getAppInstallationStore: () => appStore,
        getSecretStore: () => secretStore,
        forwardWebhook: mock(async (connectionId: string) => {
          forwarded.push(connectionId);
          return new Response("ok");
        }),
      }),
    );

    // Event's team_id is a SIBLING (T-SIBLING), not the install's (T-INSTALL);
    // the shared enterprise id resolves it.
    const response = await coordinator.handleAppWebhook(
      new Request("https://gateway.example.com/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "event_callback",
          team_id: "T-SIBLING",
          enterprise_id: "E-GRID",
          event: { type: "message", channel_type: "im" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(forwarded).toEqual([seeded.id]);
  });

  test("Grid: the enterprise fallback is exact — a foreign enterprise id misses", async () => {
    // The fallback must not leak across Grids: an install for E-GRID must NOT be
    // returned when resolving a different enterprise id.
    const appStore = makeAppInstallationStore();
    const secretStore = makeSecretStore();
    const seeded = await upsertSlackInstallByTeam(
      appStore,
      secretStore,
      "org-acme",
      "T-INSTALL",
      { botToken: "xoxb-grid", enterpriseId: "E-GRID" },
    );
    expect(await getSlackInstallByEnterpriseId(appStore, "E-GRID")).toMatchObject(
      { id: seeded.id },
    );
    expect(await getSlackInstallByEnterpriseId(appStore, "E-OTHER")).toBeNull();
  });

  test("Grid: enterprise fallback is null when the enterprise has MULTIPLE installs", async () => {
    // A Grid enterprise can host many workspaces, each with its own install
    // (distinct org/bindings). The enterprise id alone can't say which one a
    // sibling-workspace DM belongs to — resolving to an arbitrary install would
    // cross-tenant misroute. So the fallback must return null when 2+ installs
    // share the enterprise, and the coordinator must NOT forward.
    const forwarded: string[] = [];
    const appStore = makeAppInstallationStore();
    const secretStore = makeSecretStore();
    // Two workspaces of one Grid enterprise, each its own install (same seed org
    // to satisfy the connections-projection FK; the ambiguity is on the shared
    // enterprise id, which is what matters — 2 installs, 1 enterprise).
    await upsertSlackInstallByTeam(appStore, secretStore, "org-acme", "T-AAA", {
      botToken: "xoxb-a",
      enterpriseId: "E-GRID",
    });
    await upsertSlackInstallByTeam(appStore, secretStore, "org-acme", "T-BBB", {
      botToken: "xoxb-b",
      enterpriseId: "E-GRID",
    });
    // Store-level: two installs share E-GRID ⇒ ambiguous ⇒ null.
    expect(await getSlackInstallByEnterpriseId(appStore, "E-GRID")).toBeNull();

    // Coordinator: a DM from a third sibling (T-CCC) must NOT be forwarded to
    // either install.
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        listSlackConnections: async () => [],
        getAppInstallationStore: () => appStore,
        getSecretStore: () => secretStore,
        forwardWebhook: mock(async (connectionId: string) => {
          forwarded.push(connectionId);
          return new Response("ok");
        }),
      }),
    );
    // The DM matches no install (T-CCC) and the enterprise is ambiguous, so it
    // falls through the install path. Downstream fallbacks (default connection /
    // OAuth chat) aren't stubbed here and may throw — that's fine; the assertion
    // is that it NEVER forwarded to one of the E-GRID installs.
    await coordinator
      .handleAppWebhook(
        new Request("https://gateway.example.com/slack/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "event_callback",
            team_id: "T-CCC",
            enterprise_id: "E-GRID",
            event: { type: "message", channel_type: "im" },
          }),
        }),
      )
      .catch(() => undefined);
    expect(forwarded).toEqual([]);
  });

  test("a stopped BYO connection does not preempt an active OAuth installation", async () => {
    const body = JSON.stringify({ team_id: "T888", type: "event_callback" });
    const forwarded: string[] = [];
    const appStore = makeAppInstallationStore();
    const secretStore = makeSecretStore();
    // An active OAuth install exists for the team.
    const seeded = await upsertSlackInstallByTeam(
      appStore,
      secretStore,
      "org-acme",
      "T888",
			{ botToken: "xoxb-T888" },
    );
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        // ...alongside a STOPPED BYO connection for the same team. Routing must
        // reach the install, not 503 on the stopped row.
        listSlackConnections: async () => [
					{
						...createSlackConnection("conn-stopped", { teamId: "T888" }),
						status: "stopped",
					},
        ],
        getAppInstallationStore: () => appStore,
        getSecretStore: () => secretStore,
        forwardWebhook: mock(async (connectionId: string) => {
          forwarded.push(connectionId);
          return new Response("ok");
        }),
			}),
    );

    const response = await coordinator.handleAppWebhook(
      new Request("https://gateway.example.com/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
			}),
    );

    expect(response.status).toBe(200);
    expect(forwarded).toEqual([seeded.id]);
  });

  test("resolveAdapterConfig sources app creds from env (requireOAuth)", async () => {
    process.env.SLACK_SIGNING_SECRET = "env-signing";
    process.env.SLACK_CLIENT_ID = "env-client-id";
    process.env.SLACK_CLIENT_SECRET = "env-client-secret";

    const coordinator = new SlackConnectionCoordinator(makeDeps());
    const config = coordinator.resolveAdapterConfig({ requireOAuth: true });

    expect(config).toMatchObject({
      platform: "slack",
      signingSecret: "env-signing",
      clientId: "env-client-id",
      clientSecret: "env-client-secret",
    });
  });

  test("resolveAdapterConfig throws when Slack env is absent", () => {
    const coordinator = new SlackConnectionCoordinator(makeDeps());
    expect(() => coordinator.resolveAdapterConfig()).toThrow(
			/SLACK_SIGNING_SECRET/,
    );
		expect(() =>
			coordinator.resolveAdapterConfig({ requireOAuth: true }),
		).toThrow(/SLACK_SIGNING_SECRET/);
  });

  test("handleAppWebhook prefers an exact team match", async () => {
    const body = JSON.stringify({ team_id: "T123", type: "event_callback" });
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        forwardWebhook: mock(async (connectionId: string, request: Request) => {
          return new Response(`${connectionId}:${await request.text()}`);
        }),
        listSlackConnections: async () => [
          createSlackConnection("conn-team", { teamId: "T123" }),
          createSlackConnection("conn-default"),
        ],
			}),
    );

    const response = await coordinator.handleAppWebhook(
      new Request("https://gateway.example.com/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
			}),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`conn-team:${body}`);
  });

  test("handleAppWebhook routes a matched team without any Slack env (BYO)", async () => {
    // Sanity: env-sourcing in resolveAdapterConfig must not affect routing of a
    // webhook that resolves to a concrete connection — that path uses the
    // connection's own adapter, never resolveAdapterConfig. Env is unset here
    // (beforeEach cleared it) and routing must still succeed.
    const body = JSON.stringify({ team_id: "T777", type: "event_callback" });
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        forwardWebhook: mock(async (connectionId: string) => {
          return new Response(connectionId);
        }),
        listSlackConnections: async () => [
          createSlackConnection("conn-byo", { teamId: "T777" }),
        ],
			}),
    );

    const response = await coordinator.handleAppWebhook(
      new Request("https://gateway.example.com/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
			}),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("conn-byo");
  });

  test("handleAppWebhook falls back to the shared preview Slack connection", async () => {
    const body = JSON.stringify({ type: "url_verification" });
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        forwardWebhook: mock(async (connectionId: string, request: Request) => {
          return new Response(`${connectionId}:${await request.text()}`);
        }),
        // The shared/hosted connection is the only safe no-team-match default:
        // it is explicitly previewMode and carries no teamId.
        listSlackConnections: async () => [
          createSlackConnection(
            "conn-default",
            {},
            {},
						{ allowGroups: true, previewMode: true },
          ),
        ],
			}),
    );

    const response = await coordinator.handleAppWebhook(
      new Request("https://gateway.example.com/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
			}),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`conn-default:${body}`);
  });

  test("getDefaultConnection refuses a non-preview tenant connection without a team match", async () => {
    // A plain tenant connection (no previewMode, no teamId) must never be the
    // no-team-match default — forwarding an unmatched-team webhook to it would
    // cross tenants (its own bot token). The fallback must fail closed.
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        listSlackConnections: async () => [
          createSlackConnection("conn-tenant"),
        ],
			}),
    );

    expect(await coordinator.getDefaultConnection()).toBeNull();
  });

  test("getDefaultConnection returns the previewMode connection", async () => {
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        listSlackConnections: async () => [
          createSlackConnection("conn-tenant", { teamId: "T1" }),
          createSlackConnection(
            "conn-preview",
            {},
            {},
						{ allowGroups: true, previewMode: true },
          ),
        ],
			}),
    );

    const def = await coordinator.getDefaultConnection();
    expect(def?.id).toBe("conn-preview");
  });

  test("handleAppWebhook sends a welcome DM for team_join events", async () => {
    const post = mock(async () => undefined);
    const openDM = mock(async () => ({ post }));
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        getRunningChat: () => ({ openDM }),
        listSlackConnections: async () => [
          createSlackConnection("conn-team", { teamId: "T123" }),
        ],
			}),
    );

    const response = await coordinator.handleAppWebhook(
      new Request("https://gateway.example.com/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "event_callback",
          team_id: "T123",
          event: {
            type: "team_join",
            user: {
              id: "U123",
              profile: { display_name: "Ada" },
            },
          },
        }),
			}),
    );

    expect(response.status).toBe(200);
    expect(openDM).toHaveBeenCalledWith("U123");
    expect(post).toHaveBeenCalledWith(
			"Welcome to Lobu, Ada. Mention me in a channel or send me a DM to start a thread. Use `/lobu help` to see the built-in commands.",
    );
  });

  describe("maybeSendSlackWorkspaceWelcome (first-agent-bound installer DM)", () => {
    const TEAM = "T-WELCOME";

    /** A SlackWebApi stub that records openDm/postMessage calls. */
    function makeWelcomeWeb() {
      const openDm = mock(async () => "D-WELCOME");
      const postMessage = mock(async () => undefined);
      return {
        openDm,
        postMessage,
        conversationMembers: async () => [],
        conversationInfo: async () => ({ name: null, isPrivate: false }),
        usersInfo: async () => ({ isAdmin: false, isOwner: false }),
        revokeToken: async () => true,
        authTest: async () => ({ teamId: TEAM }),
        exchangeOAuthCode: async () => {
          throw new Error("not used");
        },
      };
    }

    /** A secret store whose get() resolves any ref to the installed bot token. */
    function makeResolvingSecretStore() {
      return {
        get: async () => "xoxb-welcome-token",
        put: async (name: string) => `secret://${encodeURIComponent(name)}`,
        delete: async () => undefined,
        list: async () => [],
      } as unknown as ReturnType<Deps["getSecretStore"]>;
    }

    async function seedActiveInstall(installerUserId: string | null) {
      await getDb()`DELETE FROM app_installations WHERE external_tenant_id = ${TEAM}`;
      const metadata: Record<string, unknown> = {
        external_id: `slackinst-${TEAM}`,
        config: { platform: "slack", botToken: "secret://installations/x/botToken" },
      };
      if (installerUserId) metadata.installer_user_id = installerUserId;
      await getDb()`
        INSERT INTO app_installations
          (organization_id, provider, provider_instance, provider_app_id,
           external_tenant_id, status, metadata)
        VALUES
          ('org-acme', 'slack', 'cloud', 'cloud', ${TEAM}, 'active',
           ${getDb().json(metadata)})
      `;
    }

    afterEach(async () => {
      await getDb()`DELETE FROM app_installations WHERE external_tenant_id = ${TEAM}`;
    });

    test("fires exactly once on the first binding, then never again", async () => {
      await seedActiveInstall("U-INSTALLER");
      const secretStore = makeResolvingSecretStore();

      // First binding → one welcome DM to the installer.
      const web1 = makeWelcomeWeb();
      await maybeSendSlackWorkspaceWelcome({
        teamId: TEAM,
        secretStore,
        web: web1,
      });
      expect(web1.openDm).toHaveBeenCalledTimes(1);
      expect(web1.openDm.mock.calls[0]?.[0]).toBe("xoxb-welcome-token");
      expect(web1.openDm.mock.calls[0]?.[1]).toBe("U-INSTALLER");
      expect(web1.postMessage).toHaveBeenCalledTimes(1);
      expect(web1.postMessage.mock.calls[0]?.[1]).toBe("D-WELCOME");

      // Second binding → the persisted welcome_dm_sent marker is already set, so
      // NO second DM (multi-replica-safe at-most-once).
      const web2 = makeWelcomeWeb();
      await maybeSendSlackWorkspaceWelcome({
        teamId: TEAM,
        secretStore,
        web: web2,
      });
      expect(web2.openDm).not.toHaveBeenCalled();
      expect(web2.postMessage).not.toHaveBeenCalled();
    });

    test("does not send for an unclaimed (non-active) workspace", async () => {
      // A pending (unclaimed) install has installer id but is not active — the
      // three preconditions are not all met, so no DM.
      await getDb()`DELETE FROM app_installations WHERE external_tenant_id = ${TEAM}`;
      await getDb()`
        INSERT INTO app_installations
          (organization_id, provider, provider_instance, provider_app_id,
           external_tenant_id, status, metadata)
        VALUES
          (NULL, 'slack', 'cloud', 'cloud', ${TEAM}, 'pending',
           ${getDb().json({ installer_user_id: "U-INSTALLER" })})
      `;
      const web = makeWelcomeWeb();
      await maybeSendSlackWorkspaceWelcome({
        teamId: TEAM,
        secretStore: makeResolvingSecretStore(),
        web,
      });
      expect(web.openDm).not.toHaveBeenCalled();
      expect(web.postMessage).not.toHaveBeenCalled();
    });

    test("does not send when the install has no recorded installer id", async () => {
      await seedActiveInstall(null);
      const web = makeWelcomeWeb();
      await maybeSendSlackWorkspaceWelcome({
        teamId: TEAM,
        secretStore: makeResolvingSecretStore(),
        web,
      });
      expect(web.openDm).not.toHaveBeenCalled();
      expect(web.postMessage).not.toHaveBeenCalled();
    });
  });
});
