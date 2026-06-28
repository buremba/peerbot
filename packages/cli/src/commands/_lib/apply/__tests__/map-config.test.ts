import { describe, expect, test } from "bun:test";
import {
  defineAgent,
  defineAuthProfile,
  defineConfig,
  defineConnection,
  defineConnector,
  defineEntityType,
  defineRelationshipType,
  defineWatcher,
  secret,
} from "@lobu/cli/config";
import {
  mapProjectToDesiredState,
  mergeAgentDirArtifacts,
} from "../map-config.js";
import type { AgentSettings } from "@lobu/core";

const env: NodeJS.ProcessEnv = {
  ANTHROPIC_API_KEY: "sk-test",
  GH_SECRET: "ghs_test",
};

describe("mapProjectToDesiredState", () => {
  test("maps agents: providers, network (deduped), resolved provider keys", () => {
    const crm = defineAgent({
      id: "crm",
      providers: [
        {
          id: "anthropic",
          model: "claude-sonnet-4-6",
          key: secret("ANTHROPIC_API_KEY"),
        },
      ],
      network: { allowed: ["github.com", "github.com"], denied: ["evil.com"] },
    });
    const state = mapProjectToDesiredState(
      defineConfig({ org: "o", agents: [crm] }),
      env
    );
    const agent = state.agents[0];
    expect(agent?.metadata.agentId).toBe("crm");
    expect(agent?.metadata.name).toBe("crm"); // defaults to id
    expect(agent?.settings.installedProviders?.[0]?.providerId).toBe(
      "anthropic"
    );
    expect(agent?.settings.providerModelPreferences).toEqual({
      anthropic: "claude-sonnet-4-6",
    });
    expect(agent?.settings.networkConfig?.allowedDomains).toEqual([
      "github.com",
    ]);
    expect(agent?.settings.networkConfig?.deniedDomains).toEqual(["evil.com"]);
    expect(agent?.providerKeys).toEqual([
      { providerId: "anthropic", value: "sk-test" },
    ]);
    expect(state.requiredSecrets).toContain("ANTHROPIC_API_KEY");
    expect(state.memory).toEqual({ org: "o" });
  });

  test("maps agent platforms: stable id + RESOLVED secret values + literals + collected secrets", () => {
    const bot = defineAgent({
      id: "support-bot",
      platforms: [
        {
          type: "telegram",
          config: { botToken: secret("TELEGRAM_BOT_TOKEN") },
        },
        {
          type: "slack",
          name: "ops",
          config: { botToken: "$SLACK_BOT_TOKEN", appType: "MultiTenant" },
          channels: ["T1/C1"],
        },
      ],
    });
    // The server stores the incoming plaintext as the secret, so the mapper
    // must send the RESOLVED env value (not the `$VAR` placeholder).
    const platformEnv: NodeJS.ProcessEnv = {
      ...env,
      TELEGRAM_BOT_TOKEN: "tg-real-token",
      SLACK_BOT_TOKEN: "sk-real-token",
    };
    const state = mapProjectToDesiredState(
      defineConfig({ org: "o", agents: [bot] }),
      platformEnv
    );
    const platforms = state.agents[0]?.platforms ?? [];
    expect(platforms).toHaveLength(2);
    // Stable id is deterministic from (agentId, type, name?).
    expect(platforms[0]?.stableId).toBe("support-bot-telegram");
    expect(platforms[1]?.stableId).toBe("support-bot-slack-ops");
    // secret()/$VAR resolve to the real value; literals pass through.
    expect(platforms[0]?.config).toEqual({ botToken: "tg-real-token" });
    expect(platforms[1]?.config).toEqual({
      botToken: "sk-real-token",
      appType: "MultiTenant",
    });
    expect(platforms[1]?.channels).toEqual(["T1/C1"]);
    expect(state.requiredSecrets).toContain("TELEGRAM_BOT_TOKEN");
    expect(state.requiredSecrets).toContain("SLACK_BOT_TOKEN");
  });

  test("rejects two platforms whose names collapse to the same stable id", () => {
    const bot = defineAgent({
      id: "bot",
      platforms: [
        { type: "slack", name: "ops", config: { botToken: secret("T") } },
        { type: "slack", name: "ops!", config: { botToken: secret("T") } },
      ],
    });
    expect(() =>
      mapProjectToDesiredState(defineConfig({ org: "o", agents: [bot] }), env)
    ).toThrow(/same id|distinct names/i);
  });

  test("rejects duplicate slugs across declarative collections (config parity)", () => {
    const a = defineAgent({ id: "a" });
    const e1 = defineEntityType({ key: "company", name: "C1" });
    const e2 = defineEntityType({ key: "company", name: "C2" });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ org: "o", agents: [a], entities: [e1, e2] }),
        env
      )
    ).toThrow(/duplicate entity type key "company"/i);

    const c1 = defineConnection({ slug: "gh", connector: "github" });
    const c2 = defineConnection({ slug: "gh", connector: "github" });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ org: "o", agents: [a], connections: [c1, c2] }),
        env
      )
    ).toThrow(/duplicate connection slug "gh"/i);

    const w1 = defineWatcher({
      slug: "w",
      agent: a,
      prompt: "p",
    });
    const w2 = defineWatcher({
      slug: "w",
      agent: a,
      prompt: "p",
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ org: "o", agents: [a], watchers: [w1, w2] }),
        env
      )
    ).toThrow(/duplicate watcher slug "w"/i);
  });

  test("rejects channels on a non-slack platform", () => {
    const bot = defineAgent({
      id: "bot",
      platforms: [{ type: "telegram", config: {}, channels: ["T1/C1"] }],
    });
    expect(() =>
      mapProjectToDesiredState(defineConfig({ org: "o", agents: [bot] }), env)
    ).toThrow(/channel bindings are only supported on slack/i);
  });

  test("rejects a malformed slack channel string", () => {
    const bot = defineAgent({
      id: "bot",
      platforms: [{ type: "slack", config: {}, channels: ["not-a-channel"] }],
    });
    expect(() =>
      mapProjectToDesiredState(defineConfig({ org: "o", agents: [bot] }), env)
    ).toThrow(/invalid channel|teamId.*channelId/i);
  });

  test("maps entities + relationships with typed-handle slugs", () => {
    const person = defineEntityType({ key: "person", name: "Person" });
    const org = defineEntityType({ key: "org" });
    const worksAt = defineRelationshipType({
      key: "works_at",
      rules: [{ source: person, target: org }],
    });
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [],
        entities: [person, org],
        relationships: [worksAt],
      })
    );
    expect(state.memorySchema.entityTypes.map((e) => e.slug)).toEqual([
      "person",
      "org",
    ]);
    expect(state.memorySchema.relationshipTypes[0]?.rules).toEqual([
      { source: "person", target: "org" },
    ]);
  });

  test("maps a derived entity's backing ({ sql }); stored entities carry none", () => {
    const subscription = defineEntityType({
      key: "subscription",
      name: "Subscription",
      backing: {
        sql: "SELECT company_id, SUM(amount) AS spend FROM revolut GROUP BY company_id",
      },
    });
    const company = defineEntityType({ key: "company", name: "Company" });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], entities: [subscription, company] })
    );
    const byKey = Object.fromEntries(
      state.memorySchema.entityTypes.map((e) => [e.slug, e])
    );
    expect(byKey.subscription?.backing).toEqual({
      sql: "SELECT company_id, SUM(amount) AS spend FROM revolut GROUP BY company_id",
    });
    // stored (default) entities never carry backing — keeps the diff churn-free
    expect(byKey.company?.backing).toBeUndefined();
  });

  test("maps a declared entity's metrics; non-metric entities carry none", () => {
    const company = defineEntityType({
      key: "company",
      name: "Company",
      properties: { aliases: { type: "array" } },
      eventSets: {
        charges: {
          by: "alias",
          field: "metadata->>'description'",
          against: "aliases",
          where: "semantic_type='transaction'",
          dedupeKey: ["metadata->>'date'", "metadata->>'amount'"],
        },
      },
      segments: {
        outflow: {
          description: "Money out.",
          where: "metadata->>'direction'='out'",
          on: "event",
          appliedBefore: "dedupe",
        },
      },
      measures: {
        spend: {
          eventSet: "charges",
          agg: "sum",
          expr: "(metadata->>'amount')::numeric",
          segments: ["outflow"],
          description: "Total outflow.",
        },
      },
      dimensions: {
        currency: { expr: "metadata->>'currency'", description: "Currency." },
      },
    });
    const person = defineEntityType({ key: "person", name: "Person" });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], entities: [company, person] })
    );
    const byKey = Object.fromEntries(
      state.memorySchema.entityTypes.map((e) => [e.slug, e])
    );
    // The four metric fields round-trip verbatim under `metrics`.
    expect(byKey.company?.metrics?.measures?.spend?.agg).toBe("sum");
    expect(byKey.company?.metrics?.eventSets?.charges?.by).toBe("alias");
    expect(byKey.company?.metrics?.segments?.outflow?.on).toBe("event");
    expect(byKey.company?.metrics?.dimensions?.currency?.expr).toBe(
      "metadata->>'currency'"
    );
    // A non-metric entity carries no `metrics` — keeps the diff churn-free.
    expect(byKey.person?.metrics).toBeUndefined();
  });

  test("rejects invalid metrics at load time (measure naming a missing eventSet)", () => {
    const bad = defineEntityType({
      key: "company",
      name: "Company",
      measures: {
        spend: {
          eventSet: "charges", // not declared
          agg: "sum",
          expr: "x",
          description: "Spend.",
        },
      },
    });
    expect(() =>
      mapProjectToDesiredState(defineConfig({ agents: [], entities: [bad] }))
    ).toThrow(/invalid metrics.*eventSet "charges"/i);
  });

  test("rejects an empty backing.sql at load time (before any remote mutation)", () => {
    const bad = defineEntityType({
      key: "bad",
      name: "Bad",
      backing: { sql: "   " },
    });
    expect(() =>
      mapProjectToDesiredState(defineConfig({ agents: [], entities: [bad] }))
    ).toThrow(/empty backing\.sql/i);
  });

  test("carries prune into DesiredState (defaults false when unset)", () => {
    expect(mapProjectToDesiredState(defineConfig({ agents: [] })).prune).toBe(
      false
    );
    expect(
      mapProjectToDesiredState(defineConfig({ agents: [], prune: true })).prune
    ).toBe(true);
    expect(
      mapProjectToDesiredState(defineConfig({ agents: [], prune: false })).prune
    ).toBe(false);
  });

  test("maps watchers: agent handle, sources record, notification", () => {
    const crm = defineAgent({ id: "crm" });
    const watcher = defineWatcher({
      agent: crm,
      slug: "health",
      prompt: "assess",
      sources: { accounts: "SELECT 1" },
      schedule: "0 */12 * * *",
      notification: { channel: "both", priority: "high" },
      minCooldownSeconds: 1800,
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [crm], watchers: [watcher] })
    );
    const dw = state.watchers[0];
    expect(dw?.agent).toBe("crm");
    expect(dw?.sources).toEqual([{ name: "accounts", query: "SELECT 1" }]);
    expect(dw?.notificationChannel).toBe("both");
    expect(dw?.notificationPriority).toBe("high");
    expect(dw?.minCooldownSeconds).toBe(1800);
  });

  test("maps watcher reactionsGuidance + agentKind", () => {
    const crm = defineAgent({ id: "crm" });
    const watcher = defineWatcher({
      agent: crm,
      slug: "w",
      prompt: "p",
      reactionsGuidance: "Notify the account owner.",
      agentKind: "notifier",
    });
    const dw = mapProjectToDesiredState(
      defineConfig({ agents: [crm], watchers: [watcher] })
    ).watchers[0];
    expect(dw?.reactionsGuidance).toBe("Notify the account owner.");
    expect(dw?.agentKind).toBe("notifier");
  });

  test("normalizes keyingConfig camelCase → snake_case for the server", () => {
    const crm = defineAgent({ id: "crm" });
    const watcher = defineWatcher({
      agent: crm,
      slug: "pricing",
      prompt: "extract",
      keyingConfig: {
        entityType: "price",
        entityPath: "prices",
        keyFields: ["sku"],
        keyOutputField: "price_key",
      },
    });
    const dw = mapProjectToDesiredState(
      defineConfig({ agents: [crm], watchers: [watcher] })
    ).watchers[0];
    // Server reads snake_case (watcher-extraction-schema.ts / promote-keyed-entities.ts);
    // camelCase would silently land the watcher as untyped.
    expect(dw?.keyingConfig).toEqual({
      entity_type: "price",
      entity_path: "prices",
      key_fields: ["sku"],
      key_output_field: "price_key",
    });
  });

  test("throws when a watcher names an unknown agent", () => {
    const watcher = defineWatcher({
      agent: "ghost",
      slug: "x",
      prompt: "p",
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [], watchers: [watcher] })
      )
    ).toThrow(/ghost/);
  });

  test("maps connections + auth profiles; resolves connector class + secret creds", () => {
    const github = defineConnector({
      key: "github",
      name: "GitHub",
      version: "1.0.0",
      feeds: {
        stars: {
          name: "Stars",
          sync: async () => ({ events: [], checkpoint: null }),
        },
      },
    });
    const auth = defineAuthProfile({
      slug: "gh-app",
      connector: github,
      authKind: "oauth_app",
      credentials: { clientSecret: secret("GH_SECRET") },
    });
    const conn = defineConnection({
      slug: "gh",
      connector: github,
      authProfile: auth,
      feeds: [{ feed: "stars", schedule: "0 */6 * * *" }],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], authProfiles: [auth], connections: [conn] }),
      env
    );
    const ap = state.connectors.authProfiles[0];
    expect(ap?.connector).toBe("github"); // class resolved to its key
    expect(ap?.kind).toBe("oauth_app");
    // Non-interactive auth-profile creds resolve to the REAL env value (apply
    // pushes the value to the DB), matching the TOML loader — not the $VAR.
    expect(ap?.credentials).toEqual({ clientSecret: "ghs_test" });
    expect(state.requiredSecrets).toContain("GH_SECRET");
    const dc = state.connectors.connections[0];
    expect(dc?.connector).toBe("github");
    expect(dc?.authProfileSlug).toBe("gh-app");
    expect(dc?.feeds).toEqual([{ feedKey: "stars", schedule: "0 */6 * * *" }]);
  });

  test("folds `managedBy` (org only — no url) into the connection config", () => {
    const conn = defineConnection({
      slug: "gh-managed",
      connector: "github",
      config: { existing: true },
      managedBy: { org: "lobu-managed" },
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], connections: [conn] })
    );
    const dc = state.connectors.connections[0];
    // No connection-supplied URL: a connection can never redirect where the
    // cloud PAT is sent (it always targets the instance's LOBU_CLOUD_URL).
    expect(dc?.config).toEqual({
      existing: true,
      managedBy: { org: "lobu-managed" },
    });
  });

  test("a managedBy connection KEEPS its feeds (local data syncs)", () => {
    // Stage 5: the LOCAL managedBy connection is NOT consent-only, so it keeps
    // its feeds — `lobu apply` creates them locally and the connection syncs.
    const conn = defineConnection({
      slug: "gh-managed-feeds",
      connector: "github",
      managedBy: { org: "lobu-managed" },
      feeds: [{ feed: "stars", schedule: "0 */6 * * *" }],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], connections: [conn] })
    );
    const dc = state.connectors.connections[0];
    expect(dc?.config).toEqual({ managedBy: { org: "lobu-managed" } });
    // consent_only is NOT set — the local managed connection can have feeds.
    expect(dc?.config?.consent_only).toBeUndefined();
    expect(dc?.feeds).toEqual([{ feedKey: "stars", schedule: "0 */6 * * *" }]);
  });

  test("a connection without `managedBy` carries no managedBy in config", () => {
    const conn = defineConnection({
      slug: "gh-plain",
      connector: "github",
      config: { existing: true },
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], connections: [conn] })
    );
    const dc = state.connectors.connections[0];
    expect(dc?.config).toEqual({ existing: true });
    expect(dc?.config?.managedBy).toBeUndefined();
  });

  test("rejects an invalid connection slug", () => {
    const conn = defineConnection({ slug: "Bad_Slug", connector: "github" });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [], connections: [conn] })
      )
    ).toThrow(/connection slug/);
  });

  test("rejects an invalid cron schedule", () => {
    const crm = defineAgent({ id: "crm" });
    const watcher = defineWatcher({
      agent: crm,
      slug: "w",
      prompt: "p",
      schedule: "not-a-cron",
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [crm], watchers: [watcher] })
      )
    ).toThrow(/invalid schedule/);
  });

  test("rejects a sub-minute cron schedule (parity with TOML/server)", () => {
    const crm = defineAgent({ id: "crm" });
    const watcher = defineWatcher({
      agent: crm,
      slug: "w",
      prompt: "p",
      schedule: "*/30 * * * * *",
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [crm], watchers: [watcher] })
      )
    ).toThrow(/too frequent/);
  });

  test("rejects credentials on an interactive auth profile", () => {
    const auth = defineAuthProfile({
      slug: "gh-acct",
      connector: "github",
      authKind: "oauth_account",
      credentials: { token: secret("X") },
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [], authProfiles: [auth] })
      )
    ).toThrow(/credentials must not be set/);
  });

  test("rejects duplicate feed keys in a connection", () => {
    const conn = defineConnection({
      slug: "gh",
      connector: "github",
      feeds: [{ feed: "stars" }, { feed: "stars" }],
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [], connections: [conn] })
      )
    ).toThrow(/more than once/);
  });

  test("--only skips connectors and their secrets", () => {
    const auth = defineAuthProfile({
      slug: "gh-app",
      connector: "github",
      authKind: "oauth_app",
      credentials: { clientSecret: secret("GH_SECRET") },
    });
    const conn = defineConnection({
      slug: "gh",
      connector: "github",
      authProfile: auth,
    });
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [defineAgent({ id: "crm" })],
        authProfiles: [auth],
        connections: [conn],
      }),
      env,
      "agents"
    );
    expect(state.connectors.authProfiles).toEqual([]);
    expect(state.connectors.connections).toEqual([]);
    expect(state.requiredSecrets).not.toContain("GH_SECRET");
    expect(state.agents).toHaveLength(1);
  });

  test("maps network allow/deny domains", () => {
    const agent = defineAgent({
      id: "ofc",
      network: {
        allowed: ["api.z.ai"],
        denied: ["evil.example.com"],
      },
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [agent] }),
      env
    );
    const net = state.agents[0]?.settings.networkConfig;
    expect(net?.allowedDomains).toEqual(["api.z.ai"]);
    expect(net?.deniedDomains).toEqual(["evil.example.com"]);
  });

  test("maps tools, guardrails, nix packages", () => {
    const agent = defineAgent({
      id: "a",
      tools: {
        preApproved: ["/mcp/gmail/tools/send_email"],
        allowed: ["Bash", "Bash"],
        denied: ["Delete"],
        strict: true,
      },
      guardrails: ["secret-scan", "secret-scan", "pii-scan"],
      nixPackages: ["ffmpeg", "ffmpeg", "python311"],
    });
    const settings = mapProjectToDesiredState(
      defineConfig({ agents: [agent] }),
      env
    ).agents[0]?.settings;
    expect(settings?.preApprovedTools).toEqual(["/mcp/gmail/tools/send_email"]);
    expect(settings?.toolsConfig).toEqual({
      allowedTools: ["Bash"],
      deniedTools: ["Delete"],
      strictMode: true,
    });
    expect(settings?.guardrails).toEqual(["secret-scan", "pii-scan"]);
    expect(settings?.nixConfig).toEqual({ packages: ["ffmpeg", "python311"] });
  });

  test("maps custom MCP servers and collects oauth/header secret refs", () => {
    const agent = defineAgent({
      id: "a",
      mcpServers: {
        linear: {
          url: "https://mcp.linear.app/sse",
          type: "sse",
          headers: { Authorization: "$LINEAR_TOKEN" },
          oauth: {
            authUrl: "https://linear.app/oauth/authorize",
            tokenUrl: "https://api.linear.app/oauth/token",
            clientId: "cid",
            clientSecret: secret("LINEAR_CLIENT_SECRET"),
            scopes: ["read"],
          },
        },
      },
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [agent] }),
      env
    );
    const linear = state.agents[0]?.settings.mcpServers?.linear as
      | Record<string, unknown>
      | undefined;
    expect(linear?.url).toBe("https://mcp.linear.app/sse");
    expect(linear?.headers).toEqual({ Authorization: "$LINEAR_TOKEN" });
    expect(linear?.oauth).toEqual({
      authUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      clientId: "cid",
      clientSecret: "$LINEAR_CLIENT_SECRET",
      scopes: ["read"],
    });
    expect(state.requiredSecrets).toEqual(
      expect.arrayContaining(["LINEAR_TOKEN", "LINEAR_CLIENT_SECRET"])
    );
  });

  test("maps org metadata into memory", () => {
    const state = mapProjectToDesiredState(
      defineConfig({
        org: "lobu-team",
        orgName: "Lobu Team",
        orgDescription: "Office-ops agents",
        organizationId: "org_123",
        agents: [defineAgent({ id: "a" })],
      })
    );
    expect(state.memory).toEqual({
      org: "lobu-team",
      name: "Lobu Team",
      description: "Office-ops agents",
      organizationId: "org_123",
    });
  });

  test("hosted chat entry (slack, no config) is not mapped into a connection", () => {
    const agent = defineAgent({
      id: "a",
      platforms: [{ type: "slack", surfaces: ["dm", "channel"] }],
    });
    const mapped = mapProjectToDesiredState(
      defineConfig({ agents: [agent] }),
      env
    ).agents[0];
    // The hosted bot is reached via a `/lobu link` claim, not a self-hosted
    // connection — it must NOT become a credential-less platform row.
    expect(mapped?.platforms).toEqual([]);
  });

  test("hosted telegram entry (no config) is not mapped into a connection", () => {
    const agent = defineAgent({ id: "a", platforms: [{ type: "telegram" }] });
    const mapped = mapProjectToDesiredState(
      defineConfig({ agents: [agent] }),
      env
    ).agents[0];
    expect(mapped?.platforms).toEqual([]);
  });

  test("self-hosted chat entry (slack with botToken) IS mapped into a connection", () => {
    const agent = defineAgent({
      id: "a",
      platforms: [
        { type: "slack", config: { botToken: secret("SLACK_BOT_TOKEN") } },
      ],
    });
    const mapped = mapProjectToDesiredState(
      defineConfig({ agents: [agent] }),
      env
    ).agents[0];
    expect(mapped?.platforms).toHaveLength(1);
    expect(mapped?.platforms?.[0]?.type).toBe("slack");
  });

  test("rest platform (empty config, not hosted) IS mapped into a connection", () => {
    const agent = defineAgent({
      id: "a",
      platforms: [{ type: "rest", config: {} }],
    });
    const mapped = mapProjectToDesiredState(
      defineConfig({ agents: [agent] }),
      env
    ).agents[0];
    expect(mapped?.platforms).toHaveLength(1);
    expect(mapped?.platforms?.[0]?.type).toBe("rest");
  });

  test("collects mcp env + oauth clientId/clientSecret $VAR refs (parity with collectEnvRefs)", () => {
    const agent = defineAgent({
      id: "a",
      mcpServers: {
        svc: {
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "$SVC_TOKEN" },
          oauth: {
            authUrl: "https://a",
            tokenUrl: "https://t",
            clientId: "$SVC_CLIENT_ID",
            clientSecret: "$SVC_CLIENT_SECRET",
          },
        },
      },
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [agent] }),
      env
    );
    expect(state.requiredSecrets).toEqual(
      expect.arrayContaining([
        "SVC_TOKEN",
        "SVC_CLIENT_ID",
        "SVC_CLIENT_SECRET",
      ])
    );
    // A `$VAR`-string clientSecret is passed through verbatim.
    const oauth = (
      state.agents[0]?.settings.mcpServers?.svc as Record<string, unknown>
    ).oauth as Record<string, unknown>;
    expect(oauth.clientSecret).toBe("$SVC_CLIENT_SECRET");
  });

  test("omits absent agent settings (no empty config objects)", () => {
    const settings = mapProjectToDesiredState(
      defineConfig({ agents: [defineAgent({ id: "a" })] }),
      env
    ).agents[0]?.settings;
    expect(settings).not.toHaveProperty("networkConfig");
    expect(settings).not.toHaveProperty("toolsConfig");
    expect(settings).not.toHaveProperty("preApprovedTools");
    expect(settings).not.toHaveProperty("guardrails");
    expect(settings).not.toHaveProperty("nixConfig");
    expect(settings).not.toHaveProperty("mcpServers");
  });
});

describe("mergeAgentDirArtifacts", () => {
  test("sets prompt markdown and skillsConfig", () => {
    const settings: Partial<AgentSettings> = {};
    mergeAgentDirArtifacts(
      settings,
      { soulMd: "soul", identityMd: "id", userMd: "user" },
      [{ repo: "local/s", name: "s", content: "body", enabled: true }]
    );
    expect(settings.soulMd).toBe("soul");
    expect(settings.identityMd).toBe("id");
    expect(settings.userMd).toBe("user");
    expect(settings.skillsConfig?.skills).toHaveLength(1);
    expect(settings.skillsConfig?.skills[0]?.name).toBe("s");
  });

  test("preserves agent network; unions skill nix packages", () => {
    const settings: Partial<AgentSettings> = {
      networkConfig: {
        allowedDomains: ["agent.com"],
        deniedDomains: ["blocked.com"],
      },
      nixConfig: { packages: ["ffmpeg"] },
    };
    mergeAgentDirArtifacts(settings, {}, [
      {
        repo: "local/s",
        name: "s",
        content: "b",
        enabled: true,
        nixPackages: ["python311", "ffmpeg"],
      },
    ]);
    // Skills no longer contribute network — the agent's config is untouched.
    expect(settings.networkConfig?.allowedDomains).toEqual(["agent.com"]);
    expect(settings.networkConfig?.deniedDomains).toEqual(["blocked.com"]);
    // Agent + skill nix packages are unioned + deduped.
    expect(settings.nixConfig?.packages).toEqual(["ffmpeg", "python311"]);
  });

  test("no markdown / no skills leaves settings untouched", () => {
    const settings: Partial<AgentSettings> = {};
    mergeAgentDirArtifacts(settings, {}, []);
    expect(settings).toEqual({});
  });
});
