import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getDb } from "../../db/client.js";
import { upsertSlackInstallByTeam } from "../../lobu/stores/slack-installations.js";
import { SlackConnectionCoordinator } from "../connections/slack-connection-coordinator.js";
import type { PlatformConnection } from "../connections/types.js";

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

  test("ensureWorkspaceInstallation persists an app_installations row with only tenant data", async () => {
    // The OAuth install is an org/workspace-installation resource, not an agent
    // connection — it's an app_installations row (provider=slack) keyed on the
    // team tuple, never agent_connections. Only tenant data (bot token by ref +
    // teamName/botUserId) is recorded; app-level creds stay env-sourced.
    const appStore = makeAppInstallationStore();
    const secretStore = makeSecretStore();
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        getAppInstallationStore: () => appStore,
        getSecretStore: () => secretStore,
			}),
    );

    const result = await coordinator.ensureWorkspaceInstallation(
      "org-acme",
      "T123",
			{ botToken: "xoxb-tenant-token", botUserId: "U123", teamName: "Acme" },
    );

    expect(result.installationId.startsWith("slackinst-")).toBe(true);

    // Token-first: the bot token is persisted to the secret store BEFORE the row
    // is activated, so a persist failure can never leave an active row without a
    // token. The happy path is a SINGLE activation upsert that already carries the
    // token ref in config (no separate claim/write round-trip).
		expect(secretStore.__putCalls).toHaveLength(1);
		expect(secretStore.__putCalls[0]).toBe(
			`installations/${result.installationId}/botToken`,
    );
		expect(appStore.__upsertCalls).toHaveLength(1);
		const a = appStore.__upsertCalls[0] as Record<string, any>;
    expect(a.provider).toBe("slack");
    expect(a.providerInstance).toBe("cloud");
    expect(a.providerAppId).toBe("cloud");
    expect(a.externalTenantId).toBe("T123");
    expect(a.organizationId).toBe("org-acme");
    expect(a.status).toBe("active");
    expect(a.authProfileId).toBeNull();
    expect(a.metadata.external_id).toBe(result.installationId);
    expect(a.preserveMetadataKeysOnUpdate).toEqual(["external_id"]);
    // The single write carries the tenant data + the bot token as a secret ref
    // (never plaintext).
    expect(a.metadata.team_name).toBe("Acme");
    expect(a.metadata.bot_user_id).toBe("U123");
    expect(a.metadata.config.platform).toBe("slack");
    expect(typeof a.metadata.config.botToken).toBe("string");
    expect(a.metadata.config.botToken).not.toBe("xoxb-tenant-token");
    // No app secrets anywhere in the recorded row.
		expect(JSON.stringify(appStore.__upsertCalls)).not.toContain(
			"signingSecret",
		);
		expect(JSON.stringify(appStore.__upsertCalls)).not.toContain(
			"clientSecret",
		);
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
});
