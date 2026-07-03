/**
 * Tests for `lobu init --from-org`.
 *
 * The canonical gate: bootstrap a project from stubbed cloud state, then load
 * the generated `lobu.config.ts` back through `loadDesiredStateFromConfig` and
 * assert the resulting DesiredState matches the stubbed cloud input
 * (entities/relationships/watchers/connections/authProfiles/agents), modulo
 * write-only secret values (placeholders) and `installedAt` timestamps.
 *
 * Network is stubbed through an injected fetch impl returning the canned
 * responses listAgents / listEntityTypes / etc. produce. The fixture dir lives
 * UNDER `import.meta.dir` so jiti resolves the externalized `@lobu/cli/config`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadDesiredStateFromConfig } from "../../apply/desired-state.js";
import { initFromOrg } from "../bootstrap.js";

const tempDirs: string[] = [];

function mkFixtureDir(): string {
  const dir = mkdtempSync(join(import.meta.dir, "fixture-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Route by URL substring. A handler receives the parsed request body so routes
 * sharing a URL (e.g. `manage_connections` carries `list` alongside other
 * actions) can branch on the body `action`.
 */
function buildFetch(
  routes: Record<string, (body: Record<string, unknown>) => unknown>
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    // Order matters — match the most specific patterns first.
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(handler(body)), { status: 200 });
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

const ORIG_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of [
    "LOBU_API_URL",
    "LOBU_TOKEN",
    "LOBU_ORG",
    "LOBU_CONTEXT_DIR",
  ]) {
    ORIG_ENV[key] = process.env[key];
  }
  process.env.LOBU_API_URL = "https://example.test";
  process.env.LOBU_TOKEN = "test-token";
  process.env.LOBU_ORG = "acme";
});

afterEach(() => {
  for (const [key, val] of Object.entries(ORIG_ENV)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

/** Stubbed cloud state covering every resource family the bootstrap maps. */
function fullOrgRoutes(): Record<string, () => unknown> {
  return {
    "/oauth/userinfo": () => ({
      organizations: [{ id: "org-1", slug: "acme", name: "Acme Inc" }],
    }),
    "/agents/sales/config": () => ({
      installedProviders: [{ providerId: "anthropic", installedAt: 111 }],
      providerModelPreferences: { anthropic: "claude/sonnet-4-5" },
      modelSelection: { mode: "auto" },
      networkConfig: {
        allowedDomains: ["github.com", ".github.com"],
        deniedDomains: ["evil.com"],
      },
      toolsConfig: { allowedTools: ["Read"], strictMode: true },
      preApprovedTools: ["/mcp/gmail/tools/send_email"],
      guardrails: ["secret-scan"],
      nixConfig: { packages: ["jq", "ffmpeg"] },
      soulMd: "Be concise.",
      identityMd: "You are sales.",
      updatedAt: 0,
    }),
    // listAgents
    "/agents": () => ({
      agents: [
        { agentId: "sales", name: "Sales", description: "Revenue agent" },
      ],
    }),
    "watchers?watcher_id": () => ({
      watcher: {
        reaction_script:
          "export default async (ctx, client) => {\n  await client.knowledge.save({ content: 'ok', semantic_type: 'digest' });\n};\n",
        description: null,
      },
    }),
    "watchers?include_details": () => ({
      watchers: [
        {
          slug: "account-health",
          watcher_id: "1",
          name: "Account health",
          agent_id: "sales",
          prompt: "Poll CRM data.",
          schedule: "0 */12 * * *",
          sources: [{ name: "content", query: "SELECT * FROM events" }],
          tags: ["sales", "health"],
          notification_channel: "both",
          notification_priority: "high",
          min_cooldown_seconds: 1800,
        },
      ],
    }),
    manage_entity_schema: () => {
      // The mapper uses a single endpoint for both entity_type and
      // relationship_type list actions; return a body carrying both keys.
      return {
        // Real server shape: per-type fields live inside `metadata_schema`
        // (a JSON Schema), not top-level `properties`/`required`. The client
        // hoists them back out for the diff/bootstrap.
        entity_types: [
          {
            slug: "lead",
            name: "Lead",
            description: "A sales lead",
            metadata_schema: {
              type: "object",
              required: ["stage"],
              properties: {
                stage: { type: "string", "x-table-label": "Stage" },
              },
            },
          },
          { slug: "pilot", name: "Pilot" },
        ],
        relationship_types: [
          {
            slug: "converted-to",
            name: "Converted To",
            description: "Lead to pilot",
            rules: [{ source: "lead", target: "pilot" }],
          },
        ],
      };
    },
    manage_auth_profiles: () => ({
      auth_profiles: [
        {
          slug: "github-account",
          display_name: "GitHub account",
          connector_key: "github",
          profile_kind: "oauth_account",
          status: "active",
        },
        {
          slug: "github-app",
          display_name: "GitHub OAuth App",
          connector_key: "github",
          profile_kind: "oauth_app",
          status: "active",
        },
      ],
    }),
    manage_connections: () => ({
      connections: [
        {
          id: 7,
          slug: "github-lobu",
          connector_key: "github",
          display_name: "GitHub — lobu",
          status: "active",
          auth_profile_slug: "github-account",
          app_auth_profile_slug: "github-app",
          config: { repo_owner: "lobu-ai", repo_name: "lobu" },
          device_worker_id: null,
        },
      ],
    }),
    manage_feeds: () => ({
      feeds: [
        {
          id: 1,
          connection_id: 7,
          feed_key: "stargazers",
          display_name: "Stars",
          status: "active",
          schedule: "0 */6 * * *",
          config: { repo_owner: "lobu-ai", repo_name: "lobu" },
        },
      ],
    }),
  };
}

describe("lobu init --from-org", () => {
  test("bootstraps a project that round-trips through loadDesiredStateFromConfig", async () => {
    const dir = mkFixtureDir();
    await initFromOrg({
      targetDir: dir,
      fetchImpl: buildFetch(fullOrgRoutes()),
    });

    // The config file exists and references the org metadata.
    const source = readFileSync(join(dir, "lobu.config.ts"), "utf-8");
    expect(source).toContain('org: "acme"');
    expect(source).toContain('orgName: "Acme Inc"');

    // The bootstrap wrote the agent-dir markdown + the reaction script.
    expect(readFileSync(join(dir, "agents", "sales", "SOUL.md"), "utf-8")).toBe(
      "Be concise.\n"
    );
    expect(
      readFileSync(
        join(dir, "reactions", "account-health.reaction.ts"),
        "utf-8"
      )
    ).toContain("client.knowledge.save");
    expect(readFileSync(join(dir, ".env.example"), "utf-8")).toContain(
      "ANTHROPIC_API_KEY="
    );

    // Round-trip: load the generated config back to DesiredState.
    const env = { ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv;
    const { state } = await loadDesiredStateFromConfig({ cwd: dir, env });

    // ── agents ───────────────────────────────────────────────────────────
    expect(state.memory).toEqual({ org: "acme", name: "Acme Inc" });
    const agent = state.agents[0];
    expect(agent?.metadata).toEqual({
      agentId: "sales",
      name: "Sales",
      description: "Revenue agent",
    });
    expect(agent?.settings.installedProviders?.[0]?.providerId).toBe(
      "anthropic"
    );
    expect(agent?.settings.providerModelPreferences).toEqual({
      anthropic: "claude/sonnet-4-5",
    });
    expect(agent?.settings.networkConfig).toEqual({
      allowedDomains: ["github.com", ".github.com"],
      deniedDomains: ["evil.com"],
    });
    expect(agent?.settings.toolsConfig).toEqual({
      allowedTools: ["Read"],
      strictMode: true,
    });
    expect(agent?.settings.preApprovedTools).toEqual([
      "/mcp/gmail/tools/send_email",
    ]);
    expect(agent?.settings.guardrails).toEqual(["secret-scan"]);
    expect(agent?.settings.nixConfig?.packages).toEqual(["jq", "ffmpeg"]);
    expect(agent?.settings.soulMd).toBe("Be concise.");
    expect(agent?.settings.identityMd).toBe("You are sales.");
    // Secret resolves from env to the real value (write-only placeholder filled).
    expect(agent?.providerKeys).toEqual([
      { providerId: "anthropic", value: "sk-test" },
    ]);
    expect(state.requiredSecrets).toContain("ANTHROPIC_API_KEY");

    // ── memory schema ──────────────────────────────────────────────────────
    expect(state.memorySchema.entityTypes.map((e) => e.slug)).toEqual([
      "lead",
      "pilot",
    ]);
    expect(state.memorySchema.entityTypes[0]).toEqual({
      slug: "lead",
      name: "Lead",
      description: "A sales lead",
      required: ["stage"],
      properties: { stage: { type: "string", "x-table-label": "Stage" } },
    });
    expect(state.memorySchema.relationshipTypes[0]).toEqual({
      slug: "converted-to",
      name: "Converted To",
      description: "Lead to pilot",
      rules: [{ source: "lead", target: "pilot" }],
    });

    // ── watchers ───────────────────────────────────────────────────────────
    const w = state.watchers[0];
    expect(w?.slug).toBe("account-health");
    expect(w?.agent).toBe("sales");
    expect(w?.name).toBe("Account health");
    expect(w?.prompt).toBe("Poll CRM data.");
    expect(w?.schedule).toBe("0 */12 * * *");
    // No keyingConfig means this round-trips as an untyped watcher that uses
    // the worker's free-form `{ summary }` fallback.
    expect(w?.keyingConfig).toBeUndefined();
    expect(w?.sources).toEqual([
      { name: "content", query: "SELECT * FROM events" },
    ]);
    expect(w?.tags).toEqual(["sales", "health"]);
    expect(w?.notificationChannel).toBe("both");
    expect(w?.notificationPriority).toBe("high");
    expect(w?.minCooldownSeconds).toBe(1800);
    expect(w?.reactionScript?.sourceCode).toContain("client.knowledge.save");

    // ── auth profiles ──────────────────────────────────────────────────────
    expect(state.connectors.authProfiles).toHaveLength(2);
    const ghAccount = state.connectors.authProfiles.find(
      (p) => p.slug === "github-account"
    );
    const ghApp = state.connectors.authProfiles.find(
      (p) => p.slug === "github-app"
    );
    expect(ghAccount).toMatchObject({
      slug: "github-account",
      connector: "github",
      kind: "oauth_account",
      name: "GitHub account",
    });
    // Interactive kind → no credentials.
    expect(ghAccount?.credentials).toBeUndefined();
    expect(ghApp).toMatchObject({
      slug: "github-app",
      connector: "github",
      kind: "oauth_app",
    });
    // oauth_app credentials are placeholder env refs (write-only on the server).
    expect(Object.keys(ghApp?.credentials ?? {})).toContain(
      "GITHUB_APP_CLIENT_SECRET"
    );

    // ── connections ────────────────────────────────────────────────────────
    const conn = state.connectors.connections[0];
    expect(conn?.slug).toBe("github-lobu");
    expect(conn?.connector).toBe("github");
    expect(conn?.name).toBe("GitHub — lobu");
    expect(conn?.authProfileSlug).toBe("github-account");
    expect(conn?.appAuthProfileSlug).toBe("github-app");
    expect(conn?.config).toEqual({ repo_owner: "lobu-ai", repo_name: "lobu" });
    expect(conn?.feeds).toEqual([
      {
        feedKey: "stargazers",
        name: "Stars",
        schedule: "0 */6 * * *",
        config: { repo_owner: "lobu-ai", repo_name: "lobu" },
      },
    ]);
  });

  test("empty org → minimal config that still round-trips", async () => {
    const dir = mkFixtureDir();
    await initFromOrg({
      targetDir: dir,
      fetchImpl: buildFetch({
        "/oauth/userinfo": () => ({
          organizations: [{ id: "org-1", slug: "acme", name: "Acme Inc" }],
        }),
        "/agents/lone/config": () => ({ updatedAt: 0 }),
        "/agents": () => ({ agents: [{ agentId: "lone", name: "Lone" }] }),
        "watchers?include_details": () => ({ watchers: [] }),
        manage_entity_schema: () => ({
          entity_types: [],
          relationship_types: [],
        }),
        manage_auth_profiles: () => ({ auth_profiles: [] }),
        manage_connections: () => ({ connections: [] }),
      }),
    });

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.agents[0]?.metadata.agentId).toBe("lone");
    expect(state.memorySchema.entityTypes).toHaveLength(0);
    expect(state.watchers).toHaveLength(0);
    expect(state.connectors.connections).toHaveLength(0);
  });

  test("env auth profile → credentials keyed by the connector's auth-schema field, not <SLUG>_VALUE", async () => {
    const dir = mkFixtureDir();
    await initFromOrg({
      targetDir: dir,
      fetchImpl: buildFetch({
        "/oauth/userinfo": () => ({
          organizations: [{ id: "org-1", slug: "acme", name: "Acme Inc" }],
        }),
        "/agents/lone/config": () => ({ updatedAt: 0 }),
        "/agents": () => ({ agents: [{ agentId: "lone", name: "Lone" }] }),
        "watchers?include_details": () => ({ watchers: [] }),
        manage_entity_schema: () => ({
          entity_types: [],
          relationship_types: [],
        }),
        manage_auth_profiles: () => ({
          auth_profiles: [
            {
              slug: "stripe-key",
              display_name: "Stripe API key",
              connector_key: "stripe",
              profile_kind: "env",
              status: "active",
            },
          ],
        }),
        manage_connections: () => ({ connections: [] }),
        manage_catalog: (body) => {
          const stripe = {
            id: "stripe",
            name: "Stripe",
            detail: {
              auth_schema: {
                methods: [
                  {
                    type: "env_keys",
                    fields: [{ key: "api_key", required: true, secret: true }],
                  },
                ],
              },
            },
          };
          if (body.action === "list_catalog") {
            return { catalogs: { connectors: { entries: [stripe] } } };
          }
          if (body.action === "list_installed") {
            return { installed: { connectors: { items: [stripe] } } };
          }
          throw new Error(
            `unexpected manage_catalog action: ${String(body.action)}`
          );
        },
      }),
    });

    const source = readFileSync(join(dir, "lobu.config.ts"), "utf-8");
    // The credential KEY is the connector's real auth-schema field (`api_key`),
    // env var derived from slug+field — NOT `STRIPE_KEY_VALUE` as the KEY.
    expect(source).toContain("api_key: secret(");
    expect(source).toContain('secret("STRIPE_KEY_API_KEY")');
    expect(source).not.toContain("STRIPE_KEY_VALUE");
    // The stale "rename credential keys" TODO is gone once real keys are emitted.
    expect(source).not.toContain("rename credential keys");

    // Round-trips: the credential field survives back through DesiredState.
    const env = { STRIPE_KEY_API_KEY: "sk_live_x" } as NodeJS.ProcessEnv;
    const { state } = await loadDesiredStateFromConfig({ cwd: dir, env });
    const profile = state.connectors.authProfiles.find(
      (p) => p.slug === "stripe-key"
    );
    expect(Object.keys(profile?.credentials ?? {})).toEqual(["api_key"]);
    expect(profile?.credentials?.api_key).toBe("sk_live_x");
  });

  test("platform secret config → secret() placeholder, never the redacted literal", async () => {
    const dir = mkFixtureDir();
    await initFromOrg({
      targetDir: dir,
      fetchImpl: buildFetch({
        "/oauth/userinfo": () => ({
          organizations: [{ id: "org-1", slug: "acme", name: "Acme Inc" }],
        }),
        manage_connections: () => ({
          connections: [
            {
              id: 1,
              slug: "agentconn-bot-telegram",
              connector_key: "telegram",
              agent_id: "bot",
              credential_mode: "byo",
              status: "active",
              // GET round-trip: `platform` key + redacted secret + a literal.
              config: {
                platform: "telegram",
                botToken: "***oken",
                mode: "webhook",
              },
            },
          ],
        }),
        "/agents/bot/config": () => ({ updatedAt: 0 }),
        "/agents": () => ({ agents: [{ agentId: "bot", name: "Bot" }] }),
        "watchers?include_details": () => ({ watchers: [] }),
        manage_entity_schema: () => ({
          entity_types: [],
          relationship_types: [],
        }),
        manage_auth_profiles: () => ({ auth_profiles: [] }),
      }),
    });

    const source = readFileSync(join(dir, "lobu.config.ts"), "utf-8");
    // The secret is emitted as a secret() ref (env name derived from agent+key),
    // never the opaque `***oken` literal; the non-secret `mode` stays a literal.
    expect(source).toContain('botToken: secret("BOT_TELEGRAM_BOTTOKEN")');
    expect(source).not.toContain("***oken");
    expect(source).toContain('mode: "webhook"');

    // Round-trips: the regenerated config loads back into DesiredState.
    process.env.BOT_TELEGRAM_BOTTOKEN = "dummy-token-value";
    try {
      const { state } = await loadDesiredStateFromConfig({ cwd: dir });
      const platform = state.agents[0]?.platforms[0];
      expect(platform?.type).toBe("telegram");
      // The secret() ref resolves to the real env value (the server stores the
      // incoming plaintext as the secret), not the `$VAR` placeholder.
      expect(platform?.config.botToken).toBe("dummy-token-value");
      expect(platform?.config.mode).toBe("webhook");
    } finally {
      process.env.BOT_TELEGRAM_BOTTOKEN = undefined;
    }
  });

  test("non-identifier platform config key → quoted key + valid POSIX env var", async () => {
    const dir = mkFixtureDir();
    await initFromOrg({
      targetDir: dir,
      fetchImpl: buildFetch({
        "/oauth/userinfo": () => ({
          organizations: [{ id: "org-1", slug: "acme", name: "Acme Inc" }],
        }),
        manage_connections: () => ({
          connections: [
            {
              id: 1,
              slug: "agentconn-bot-telegram",
              connector_key: "telegram",
              agent_id: "bot",
              credential_mode: "byo",
              status: "active",
              // A hyphenated config key: the emitted TS key must be quoted, and
              // the derived secret env var must be a valid POSIX name (no `-`).
              config: { platform: "telegram", "bot-token": "***oken" },
            },
          ],
        }),
        "/agents/bot/config": () => ({ updatedAt: 0 }),
        "/agents": () => ({ agents: [{ agentId: "bot", name: "Bot" }] }),
        "watchers?include_details": () => ({ watchers: [] }),
        manage_entity_schema: () => ({
          entity_types: [],
          relationship_types: [],
        }),
        manage_auth_profiles: () => ({ auth_profiles: [] }),
      }),
    });

    const source = readFileSync(join(dir, "lobu.config.ts"), "utf-8");
    const envExample = readFileSync(join(dir, ".env.example"), "utf-8");
    // Key quoted, env var sanitized (hyphen → underscore), no invalid POSIX key.
    expect(source).toContain('"bot-token": secret("BOT_TELEGRAM_BOT_TOKEN")');
    expect(source).not.toContain("BOT-TOKEN");
    expect(envExample).toContain("BOT_TELEGRAM_BOT_TOKEN=");
    expect(envExample).not.toMatch(/^[A-Z0-9_]*-/m);

    // Round-trips: the regenerated config loads (proves the .env key is valid).
    process.env.BOT_TELEGRAM_BOT_TOKEN = "dummy";
    try {
      const { state } = await loadDesiredStateFromConfig({ cwd: dir });
      expect(state.agents[0]?.platforms[0]?.config["bot-token"]).toBe("dummy");
    } finally {
      process.env.BOT_TELEGRAM_BOT_TOKEN = undefined;
    }
  });

  test("oauth_app profile → credentials keyed by the connector's oauth method (clientIdKey/clientSecretKey)", async () => {
    const dir = mkFixtureDir();
    await initFromOrg({
      targetDir: dir,
      fetchImpl: buildFetch({
        "/oauth/userinfo": () => ({
          organizations: [{ id: "org-1", slug: "acme", name: "Acme Inc" }],
        }),
        "/agents/lone/config": () => ({ updatedAt: 0 }),
        "/agents": () => ({ agents: [{ agentId: "lone", name: "Lone" }] }),
        "watchers?include_details": () => ({ watchers: [] }),
        manage_entity_schema: () => ({
          entity_types: [],
          relationship_types: [],
        }),
        manage_auth_profiles: () => ({
          auth_profiles: [
            {
              slug: "slack-app",
              display_name: "Slack OAuth app",
              connector_key: "slack",
              profile_kind: "oauth_app",
              status: "active",
            },
          ],
        }),
        manage_connections: () => ({ connections: [] }),
        manage_catalog: (body) => {
          const slack = {
            id: "slack",
            name: "Slack",
            detail: {
              auth_schema: {
                methods: [
                  {
                    type: "oauth",
                    provider: "slack",
                    requiredScopes: ["chat:write"],
                    clientIdKey: "SLACK_OAUTH_CLIENT_ID",
                    clientSecretKey: "SLACK_OAUTH_CLIENT_SECRET",
                  },
                ],
              },
            },
          };
          if (body.action === "list_catalog") {
            return { catalogs: { connectors: { entries: [slack] } } };
          }
          if (body.action === "list_installed") {
            return { installed: { connectors: { items: [slack] } } };
          }
          throw new Error(
            `unexpected manage_catalog action: ${String(body.action)}`
          );
        },
      }),
    });

    const source = readFileSync(join(dir, "lobu.config.ts"), "utf-8");
    // Both oauth credential keys come from the method (NOT the SLACK_APP_CLIENT_SECRET
    // placeholder), and the stale rename-TODO is gone.
    expect(source).toContain("SLACK_OAUTH_CLIENT_ID: secret(");
    expect(source).toContain("SLACK_OAUTH_CLIENT_SECRET: secret(");
    expect(source).not.toContain("rename credential keys");
  });

  test("relationship-type rules hydrate via list_rules (real list omits them)", async () => {
    const dir = mkFixtureDir();
    await initFromOrg({
      targetDir: dir,
      fetchImpl: buildFetch({
        "/oauth/userinfo": () => ({
          organizations: [{ id: "org-1", slug: "acme", name: "Acme Inc" }],
        }),
        "/agents/lone/config": () => ({ updatedAt: 0 }),
        "/agents": () => ({ agents: [{ agentId: "lone", name: "Lone" }] }),
        "watchers?include_details": () => ({ watchers: [] }),
        // The REAL server `list` action omits rules (only `list_rules` returns
        // them). Branch on the action so this mirrors production: list → no
        // rules; list_rules → the rule rows in the server's snake_case shape.
        manage_entity_schema: (body) => {
          if (body.action === "list_rules") {
            return {
              rules: [
                {
                  id: 1,
                  source_entity_type_slug: "contact",
                  target_entity_type_slug: "company",
                },
              ],
            };
          }
          return {
            entity_types: [
              { slug: "contact", name: "Contact" },
              { slug: "company", name: "Company" },
            ],
            relationship_types: [{ slug: "works-at", name: "Works at" }],
          };
        },
        manage_auth_profiles: () => ({ auth_profiles: [] }),
        manage_connections: () => ({ connections: [] }),
      }),
    });

    const source = readFileSync(join(dir, "lobu.config.ts"), "utf-8");
    // The rule was hydrated from list_rules and emitted, using the entity
    // handles (not raw slugs) — proving the round-trip isn't lossy.
    expect(source).toMatch(/rules:\s*\[/);
    expect(source).toContain("source:");
    expect(source).toContain("target:");

    // Round-trips: the rule survives back into DesiredState.
    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    const rel = state.memorySchema.relationshipTypes.find(
      (r) => r.slug === "works-at"
    );
    expect(rel?.rules).toEqual([{ source: "contact", target: "company" }]);
  });

  test("public/cross-org + system types are NOT declared (only owned ones)", async () => {
    // The list endpoint returns the org's own types PLUS public types from
    // OTHER orgs (and the system `$member`). Only the org's own, non-system
    // types belong in a generated config — foreign ones would emit colliding
    // `defineEntityType` keys that don't apply.
    const dir = mkFixtureDir();
    await initFromOrg({
      targetDir: dir,
      fetchImpl: buildFetch({
        "/oauth/userinfo": () => ({
          organizations: [{ id: "org-1", slug: "acme", name: "Acme Inc" }],
        }),
        "/agents/lone/config": () => ({ updatedAt: 0 }),
        "/agents": () => ({ agents: [{ agentId: "lone", name: "Lone" }] }),
        "watchers?include_details": () => ({ watchers: [] }),
        manage_entity_schema: (body) => {
          if (body.action === "list_rules") {
            // The owned cross-org rel type binds an owned type to a NON-owned
            // (public) one — that target must survive as a string ref.
            if (body.slug === "tracked-via") {
              return {
                rules: [
                  {
                    id: 1,
                    source_entity_type_slug: "lead",
                    target_entity_type_slug: "investor",
                  },
                ],
              };
            }
            return { rules: [] };
          }
          return {
            entity_types: [
              { slug: "lead", name: "Lead", organization_id: "org-1" },
              { slug: "pilot", name: "Pilot", organization_id: "org-1" },
              // System type owned by this org — server-provisioned, rejects create.
              { slug: "$member", name: "Member", organization_id: "org-1" },
              // Public type from another org.
              {
                slug: "investor",
                name: "Investor",
                organization_id: "org-pub",
              },
              // Same key as an owned type, but from a public org (a collision
              // source if both were declared).
              {
                slug: "lead",
                name: "Lead (foreign)",
                organization_id: "org-pub",
              },
            ],
            relationship_types: [
              {
                slug: "converted-to",
                name: "Converted To",
                organization_id: "org-1",
              },
              {
                slug: "tracked-via",
                name: "Tracked Via",
                organization_id: "org-1",
              },
              {
                slug: "invested-in",
                name: "Invested In",
                organization_id: "org-pub",
              },
            ],
          };
        },
        manage_auth_profiles: () => ({ auth_profiles: [] }),
        manage_connections: () => ({ connections: [] }),
      }),
    });

    const source = readFileSync(join(dir, "lobu.config.ts"), "utf-8");
    // Owned, non-system types are declared.
    expect(source).toContain('key: "lead"');
    expect(source).toContain('key: "pilot"');
    expect(source).toContain('key: "converted-to"');
    expect(source).toContain('key: "tracked-via"');
    // Foreign (public-org) and system types are NOT declared.
    expect(source).not.toContain('key: "investor"');
    expect(source).not.toContain('key: "$member"');
    expect(source).not.toContain('key: "invested-in"');
    // The cross-org rule target survives as a string ref (the type isn't declared).
    expect(source).toContain('target: "investor"');

    // Round-trip: only the owned types land in DesiredState, exactly once each.
    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.memorySchema.entityTypes.map((e) => e.slug).sort()).toEqual([
      "lead",
      "pilot",
    ]);
    expect(
      state.memorySchema.relationshipTypes.map((r) => r.slug).sort()
    ).toEqual(["converted-to", "tracked-via"]);
  });
});
