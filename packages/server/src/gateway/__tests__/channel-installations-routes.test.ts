import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";
import { ChannelBindingService } from "../channels/binding-service.js";
import { createPostgresAppInstallationStore } from "../../lobu/stores/app-installation-store.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import type { SecretStore } from "../secrets/index.js";
import { AgentMetadataStore } from "../auth/agent-metadata-store.js";
import { UserAgentsStore } from "../auth/user-agents-store.js";
import { createPostgresAgentConfigStore } from "../../lobu/stores/postgres-stores.js";
import { createChannelBindingRoutes } from "../routes/public/channels.js";
import { listCatalogConnectorDefinitions } from "../../utils/connector-catalog.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import type { SlackWebApi } from "../connections/slack-web.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG_ID = "test-org-installs";
const USER_ID = "user-installs-1";
const AGENT_ID = "agent-installs-1";
const TEAM_ID = "T_TEST_TEAM";
const EXTERNAL_ID = "slackinst-testabc";
const SLACK_USER_ID = "U_TEST_USER";
const DM_CHANNEL_ID = "D_TEST_DM";

// The bot token is stored PLAINTEXT (not a `secret://` ref) so resolveSecretValue
// returns it directly and the stub secret store is never consulted.
const BOT_TOKEN = "xoxb-test-token";

const noopSecretStore: SecretStore = { get: async () => null };

function makeSlackWebStub() {
  const posted: Array<{ channel: string; text: string }> = [];
  let openDmCalledWith: string | null = null;
  const api: SlackWebApi = {
    async openDm(botToken, slackUserId) {
      expect(botToken).toBe(BOT_TOKEN);
      openDmCalledWith = slackUserId;
      return DM_CHANNEL_ID;
    },
    async postMessage(botToken, channel, text) {
      expect(botToken).toBe(BOT_TOKEN);
      posted.push({ channel, text });
    },
  };
  return {
    api,
    posted,
    get openDmCalledWith() {
      return openDmCalledWith;
    },
  };
}

describe("channel installation routes", () => {
  let agentMetadataStore: AgentMetadataStore;
  let userAgentsStore: UserAgentsStore;
  let channelBindingService: ChannelBindingService;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
    // Warm the connector catalog: GET /installations joins connector metadata via
    // listCatalogConnectorDefinitions, which cold-compiles the bundled connectors
    // (~5s) the first time when no prebuilt manifest exists (CI's integration job
    // skips build:server). Warming here (cached) keeps the per-test handler call
    // under the 5s timeout.
    await listCatalogConnectorDefinitions();
  }, 30_000);

  beforeEach(async () => {
    await resetTestDatabase();
    agentMetadataStore = new AgentMetadataStore(createPostgresAgentConfigStore());
    userAgentsStore = new UserAgentsStore();
    channelBindingService = new ChannelBindingService();

    await orgContext.run({ organizationId: ORG_ID }, async () => {
      await seedAgentRow(AGENT_ID, {
        organizationId: ORG_ID,
        name: "Installs Agent",
        ownerPlatform: "external",
        ownerUserId: USER_ID,
      });
      await userAgentsStore.addAgent("external", USER_ID, AGENT_ID);

      // A connected Slack workspace for this org.
      await createPostgresAppInstallationStore().upsert({
        organizationId: ORG_ID,
        provider: "slack",
        providerInstance: "cloud",
        providerAppId: "cloud",
        externalTenantId: TEAM_ID,
        status: "active",
        metadata: {
          external_id: EXTERNAL_ID,
          team_name: "Test Workspace",
          config: { platform: "slack", botToken: BOT_TOKEN },
        },
      });

      // The caller's user + its linked "Sign in with Slack" account.
      await getDb()`
        INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", principal_kind)
        VALUES (${USER_ID}, ${"Test User"}, ${"test@example.com"}, ${false}, now(), now(), ${"human"})
        ON CONFLICT (id) DO NOTHING
      `;
      await getDb()`
        INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
        VALUES (${"acct-1"}, ${SLACK_USER_ID}, ${"slack"}, ${USER_ID}, now(), now())
      `;
    });
  });

  afterEach(() => {
    setAuthProvider(null);
  });

  function createApp(slackWeb: SlackWebApi) {
    const app = new Hono();
    app.route(
      "/api/v1/agents/:agentId/channels",
      createChannelBindingRoutes({
        channelBindingService,
        userAgentsStore,
        agentMetadataStore,
        appInstallationStore: createPostgresAppInstallationStore(),
        secretStore: noopSecretStore,
        slackWeb,
      })
    );
    return app;
  }

  function authAs(userId: string) {
    setAuthProvider(() => ({
      userId,
      platform: "external",
      exp: Date.now() + 60_000,
    }));
  }

  test("GET /installations lists the org's connected workspaces", async () => {
    authAs(USER_ID);
    const stub = makeSlackWebStub();
    const res = await orgContext.run({ organizationId: ORG_ID }, () =>
      createApp(stub.api).request(
        `/api/v1/agents/${AGENT_ID}/channels/installations?provider=slack`,
        { method: "GET", headers: { host: "localhost" } }
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      installations: Array<Record<string, unknown>>;
    };
    expect(body.installations).toHaveLength(1);
    const install = body.installations[0]!;
    expect(install.provider).toBe("slack");
    expect(install.externalId).toBe(EXTERNAL_ID);
    expect(install.tenantId).toBe(TEAM_ID);
    expect(install.tenantName).toBe("Test Workspace");
    expect(install.status).toBe("active");
  });

  test("GET /installations rejects a session that does not own the agent", async () => {
    authAs("intruder");
    const stub = makeSlackWebStub();
    const res = await orgContext.run({ organizationId: ORG_ID }, () =>
      createApp(stub.api).request(
        `/api/v1/agents/${AGENT_ID}/channels/installations`,
        { method: "GET", headers: { host: "localhost" } }
      )
    );
    expect(res.status).toBe(401);
  });

  test("POST connect-dm opens a DM, binds it, and welcomes the user", async () => {
    authAs(USER_ID);
    const stub = makeSlackWebStub();
    const res = await orgContext.run({ organizationId: ORG_ID }, () =>
      createApp(stub.api).request(
        `/api/v1/agents/${AGENT_ID}/channels/installations/${EXTERNAL_ID}/connect-dm`,
        { method: "POST", headers: { host: "localhost" } }
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.channelId).toBe(DM_CHANNEL_ID);
    expect(body.teamId).toBe(TEAM_ID);

    // The DM was opened with the caller's linked Slack identity.
    expect(stub.openDmCalledWith).toBe(SLACK_USER_ID);

    // A binding row now routes the DM channel to this agent.
    const bindings = await orgContext.run({ organizationId: ORG_ID }, () =>
      channelBindingService.listBindings(AGENT_ID, ORG_ID)
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.platform).toBe("slack");
    expect(bindings[0]!.channelId).toBe(DM_CHANNEL_ID);
    expect(bindings[0]!.teamId).toBe(TEAM_ID);

    // And the welcome DM was posted to that channel.
    expect(stub.posted).toHaveLength(1);
    expect(stub.posted[0]!.channel).toBe(DM_CHANNEL_ID);
  });

  test("POST connect-dm 404s for an external id outside the caller's org", async () => {
    authAs(USER_ID);
    const stub = makeSlackWebStub();
    const res = await orgContext.run({ organizationId: ORG_ID }, () =>
      createApp(stub.api).request(
        `/api/v1/agents/${AGENT_ID}/channels/installations/slackinst-nope/connect-dm`,
        { method: "POST", headers: { host: "localhost" } }
      )
    );
    expect(res.status).toBe(404);
  });

  test("POST connect-dm rejects a revoked/suspended install — no DM, no binding", async () => {
    authAs(USER_ID);
    // Turn the connected workspace off. A revoked/suspended install must not
    // yield a bot token or create a binding (the token may be dead and the
    // workspace was intentionally disabled).
    await orgContext.run({ organizationId: ORG_ID }, () =>
      createPostgresAppInstallationStore().setStatusByExternalId(
        "slack",
        EXTERNAL_ID,
        "suspended"
      )
    );
    const stub = makeSlackWebStub();
    const res = await orgContext.run({ organizationId: ORG_ID }, () =>
      createApp(stub.api).request(
        `/api/v1/agents/${AGENT_ID}/channels/installations/${EXTERNAL_ID}/connect-dm`,
        { method: "POST", headers: { host: "localhost" } }
      )
    );
    expect(res.status).toBe(404);
    expect(stub.openDmCalledWith).toBeNull();
    const bindings = await orgContext.run({ organizationId: ORG_ID }, () =>
      channelBindingService.listBindings(AGENT_ID, ORG_ID)
    );
    expect(bindings).toHaveLength(0);
  });
});
