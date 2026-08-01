import { describe, expect, test } from "bun:test";
import {
  defineAgent,
  defineAuthProfile,
  defineBehavior,
  defineConfig,
  defineConnection,
  defineConnector,
  defineEntityType,
  defineRelationshipType,
  secret,
} from "@lobu/cli/config";
import type { AgentSettings } from "@lobu/core";
import { resolveBehaviorConnectionRefs } from "../apply-cmd.js";
import {
  mapProjectToDesiredState,
  mergeAgentDirArtifacts,
} from "../map-config.js";

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
    // The provider collapses to a single ordered `models` list entry
    // (`<provider>/<model>`) — no separate installedProviders/defaultModel.
    expect(agent?.settings.models).toEqual(["anthropic/claude-sonnet-4-6"]);
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

  test("#5: multiple providers → ordered models list; already-qualified model not double-prefixed", () => {
    const multi = defineAgent({
      id: "multi",
      providers: [
        { id: "openai", model: "gpt-5", key: secret("ANTHROPIC_API_KEY") },
        // Already `<slug>/…`-qualified (provider-native id with a slash).
        {
          id: "openrouter",
          model: "openrouter/anthropic/claude-sonnet-5",
          key: secret("ANTHROPIC_API_KEY"),
        },
      ],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ org: "o", agents: [multi] }),
      env
    );
    const agent = state.agents[0];
    // Order preserved (index 0 = primary); no `<slug>/<slug>/…` double-prefix.
    expect(agent?.settings.models).toEqual([
      "openai/gpt-5",
      "openrouter/anthropic/claude-sonnet-5",
    ]);
  });

  test("#3: a provider with NO model maps to the sentinel ref (no crash)", () => {
    // `lobu init --provider chatgpt` emits a provider with no model (ChatGPT has
    // no catalog default). map-config must NOT crash on p.model.trim() — it maps
    // to the `<slug>/__unresolved__` restriction sentinel so the agent stays
    // gated (never allow-all).
    const chat = defineAgent({
      id: "chat",
      providers: [{ id: "chatgpt", key: secret("ANTHROPIC_API_KEY") }],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ org: "o", agents: [chat] }),
      env
    );
    expect(state.agents[0]?.settings.models).toEqual([
      "chatgpt/__unresolved__",
    ]);
  });

  test("#3: mixed — a model-less provider (sentinel) alongside a concrete one", () => {
    const mixed = defineAgent({
      id: "mixed",
      providers: [
        { id: "chatgpt", key: secret("ANTHROPIC_API_KEY") },
        { id: "openai", model: "gpt-5", key: secret("ANTHROPIC_API_KEY") },
      ],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ org: "o", agents: [mixed] }),
      env
    );
    expect(state.agents[0]?.settings.models).toEqual([
      "chatgpt/__unresolved__",
      "openai/gpt-5",
    ]);
  });

  test("#5: a provider with NO id is a config error (never emits '/__unresolved__')", () => {
    const bad = defineAgent({
      id: "bad",
      // A provider entry with no id is meaningless — must throw at map time,
      // not silently emit a bogus "/__unresolved__" ref the server rejects.
      providers: [{} as any],
    });
    expect(() =>
      mapProjectToDesiredState(defineConfig({ org: "o", agents: [bad] }), env)
    ).toThrow(/provider with no "id"/);
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

    const w1 = defineBehavior({
      slug: "w",
      agent: a,
      skills: ["s"],
    });
    const w2 = defineBehavior({
      slug: "w",
      agent: a,
      skills: ["s"],
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ org: "o", agents: [a], behaviors: [w1, w2] }),
        env
      )
    ).toThrow(/duplicate Behavior slug "w"/i);
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

  test("preserves explicit null keying so apply can untype a Behavior", () => {
    const agent = defineAgent({ id: "radar" });
    const behavior = defineBehavior({
      agent,
      slug: "social-radar",
      prompt: "Rank social posts.",
      keyingConfig: null,
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [agent], behaviors: [behavior] })
    );

    expect(state.watchers[0]?.keyingConfig).toBeNull();
  });

  test("BYO chat connection carries credentialMode + resolves secret config", () => {
    const slack = defineConnection({
      slug: "team-slack",
      connector: "slack",
      credentialMode: "byo",
      config: {
        botToken: secret("SLACK_BOT_TOKEN"),
        reconnect: true,
      },
    });
    const state = mapProjectToDesiredState(
      defineConfig({ org: "o", agents: [], connections: [slack] }),
      { ...env, SLACK_BOT_TOKEN: "xoxb-real-token" }
    );
    const conn = state.connectors.connections.find(
      (c) => c.slug === "team-slack"
    );
    // BYO chat connection must be persisted as a chat connection: it needs a
    // non-null credential_mode (the gateway only treats non-null rows as chat)
    // and its secret() config resolved to the real token (not the SecretRef).
    expect(conn).toBeDefined();
    expect(conn?.credentialMode).toBe("byo");
    expect(conn?.config).toEqual({
      botToken: "xoxb-real-token",
      reconnect: true,
    });
    // the secret ref is collected so the apply secrets gate fails loud if unset
    expect(state.requiredSecrets).toContain("SLACK_BOT_TOKEN");
  });

  test("rejects BYO chat fields the chat upsert cannot apply", () => {
    const auth = defineAuthProfile({
      slug: "slack-auth",
      connector: "slack",
      authKind: "env",
    });
    const cases = [
      { authProfile: auth },
      { appAuthProfile: auth },
      { deviceWorkerId: "00000000-0000-0000-0000-000000000001" },
      { feeds: [{ feed: "channels" }] },
    ];

    for (const unsupported of cases) {
      expect(() =>
        mapProjectToDesiredState(
          defineConfig({
            org: "o",
            agents: [],
            authProfiles: [auth],
            connections: [
              defineConnection({
                slug: "team-slack",
                connector: "slack",
                credentialMode: "byo",
                config: { botToken: "xoxb-test" },
                ...unsupported,
              }),
            ],
          }),
          env
        )
      ).toThrow(/BYO chat connection.*cannot declare/);
    }
  });

  test("hosted chat connection is filtered out of apply (never persisted)", () => {
    const slack = defineConnection({
      slug: "team-slack",
      connector: "slack",
      credentialMode: "hosted",
      surfaces: ["dm", "channel"],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ org: "o", agents: [], connections: [slack] }),
      env
    );
    // hosted bots are reached via /lobu link, never a persisted connection row
    expect(
      state.connectors.connections.find((c) => c.slug === "team-slack")
    ).toBeUndefined();
  });

  test("rejects hosted chat fields that would be silently ignored", () => {
    const cases = [
      { authProfile: "slack-auth" },
      { appAuthProfile: "slack-app" },
      { deviceWorkerId: "00000000-0000-0000-0000-000000000001" },
      { feeds: [{ feed: "channels" }] },
    ];

    for (const unsupported of cases) {
      expect(() =>
        mapProjectToDesiredState(
          defineConfig({
            org: "o",
            agents: [],
            connections: [
              defineConnection({
                slug: "team-slack",
                connector: "slack",
                credentialMode: "hosted",
                ...unsupported,
              }),
            ],
          }),
          env
        )
      ).toThrow(/hosted chat connection.*cannot declare/);
    }
  });

  test("rejects hosted mode for a connector without hosted-bot support", () => {
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({
          org: "o",
          agents: [],
          connections: [
            defineConnection({
              slug: "hosted-github",
              connector: "github",
              credentialMode: "hosted",
            }),
          ],
        }),
        env
      )
    ).toThrow(/does not support the hosted Lobu bot/);
  });

  test("rejects contradictory chat credential modes", () => {
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({
          org: "o",
          agents: [],
          connections: [
            defineConnection({
              slug: "managed-slack",
              connector: "slack",
              credentialMode: "byo",
              managedBy: { org: "cloud" },
            }),
          ],
        }),
        env
      )
    ).toThrow(/cannot combine credentialMode "byo" with managedBy/);
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

  test("maps behaviors: agent handle, sources record, notification", () => {
    const crm = defineAgent({ id: "crm" });
    const github = defineConnection({
      slug: "github-main",
      connector: "github",
    });
    const watcher = defineBehavior({
      agent: crm,
      slug: "health",
      skills: ["s"],
      sources: {
        accounts: "SELECT 1",
        ctx: { query: "SELECT 2", context: true },
      },
      notification: { channel: "both", priority: "high" },
      minCooldownSeconds: 1800,
      triggers: [
        {
          kind: "event",
          connector_key: "github",
          connection: github,
          event_types: ["pull_request.opened"],
        },
        { kind: "schedule", cron: "0 */12 * * *" },
      ],
    });
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [crm],
        behaviors: [watcher],
        connections: [github],
      })
    );
    const dw = state.watchers[0];
    expect(dw?.agent).toBe("crm");
    expect(dw?.sources).toEqual([
      { name: "accounts", query: "SELECT 1" },
      { name: "ctx", query: "SELECT 2", context: true },
    ]);
    expect(dw?.notificationChannel).toBe("both");
    expect(dw?.notificationPriority).toBe("high");
    expect(dw?.minCooldownSeconds).toBe(1800);
    expect(dw?.triggers?.[1]).toEqual({
      kind: "schedule",
      cron: "0 */12 * * *",
      timezone: null,
      execution: "window",
      active_run: "coalesce",
      skip_if_unchanged: true,
    });
    expect(dw?.triggers?.[0]).toMatchObject({
      connector_key: "github",
      connectionSlug: "github-main",
      execution: "turn",
      active_run: "queue",
      output: "silent",
      skip_if_unchanged: true,
    });

    resolveBehaviorConnectionRefs(
      state.watchers,
      new Map([["github-main", 91]]),
      true
    );
    expect(state.watchers[0]?.triggers?.[0]).toMatchObject({
      connector_key: "github",
      connection_id: 91,
    });
    expect(state.watchers[0]?.triggers?.[0]).not.toHaveProperty(
      "connectionSlug"
    );
  });

  test("rejects missing and connector-mismatched Behavior connections", () => {
    const crm = defineAgent({ id: "crm" });
    const slack = defineConnection({ slug: "chat", connector: "slack" });
    const behavior = (connection: string) =>
      defineBehavior({
        agent: crm,
        slug: "review-pr",
        triggers: [
          {
            kind: "event",
            connector_key: "github",
            connection,
            event_types: ["pull_request.created"],
            execution: "turn",
            active_run: "queue",
            output: "silent",
          },
        ],
      });

    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [crm], behaviors: [behavior("missing")] })
      )
    ).toThrow(/connection "missing".*not declared/i);
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({
          agents: [crm],
          connections: [slack],
          behaviors: [behavior("chat")],
        })
      )
    ).toThrow(/trigger is github.*uses slack/i);
  });

  test("rejects a Behavior trigger with both connection forms", () => {
    const crm = defineAgent({ id: "crm" });
    const github = defineConnection({
      slug: "github-main",
      connector: "github",
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({
          agents: [crm],
          connections: [github],
          behaviors: [
            defineBehavior({
              agent: crm,
              slug: "review-pr",
              triggers: [
                {
                  kind: "event",
                  connector_key: "github",
                  connection: github,
                  connection_id: 12,
                  event_types: ["pull_request.created"],
                  execution: "turn",
                  active_run: "queue",
                  output: "silent",
                },
              ],
            }),
          ],
        })
      )
    ).toThrow(/either connection or connection_id/i);
  });

  test("maps watcher reactionsGuidance + agentKind", () => {
    const crm = defineAgent({ id: "crm" });
    const watcher = defineBehavior({
      agent: crm,
      slug: "w",
      skills: ["s"],
      reactionsGuidance: "Notify the account owner.",
      agentKind: "notifier",
    });
    const dw = mapProjectToDesiredState(
      defineConfig({ agents: [crm], behaviors: [watcher] })
    ).watchers[0];
    expect(dw?.reactionsGuidance).toBe("Notify the account owner.");
    expect(dw?.agentKind).toBe("notifier");
  });

  test("normalizes keyingConfig camelCase → snake_case for the server", () => {
    const crm = defineAgent({ id: "crm" });
    const watcher = defineBehavior({
      agent: crm,
      slug: "pricing",
      skills: ["s"],
      keyingConfig: {
        entityType: "price",
        entityPath: "prices",
        keyFields: ["sku"],
        keyOutputField: "price_key",
      },
    });
    const dw = mapProjectToDesiredState(
      defineConfig({ agents: [crm], behaviors: [watcher] })
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
    const watcher = defineBehavior({
      agent: "ghost",
      slug: "x",
      skills: ["s"],
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [], behaviors: [watcher] })
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

  test("omitted feed schedule maps to null (manual-only, no platform default)", () => {
    const conn = defineConnection({
      slug: "gh",
      connector: "github",
      feeds: [{ feed: "stars" }],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], connections: [conn] })
    );
    expect(state.connectors.connections[0]?.feeds).toEqual([
      { feedKey: "stars", schedule: null },
    ]);
  });

  test("rejects an invalid cron schedule", () => {
    const crm = defineAgent({ id: "crm" });
    const watcher = defineBehavior({
      agent: crm,
      slug: "w",
      skills: ["s"],
      triggers: [{ kind: "schedule", cron: "not-a-cron" }],
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [crm], behaviors: [watcher] })
      )
    ).toThrow(/invalid schedule/);
  });

  test("rejects a sub-minute cron schedule (parity with TOML/server)", () => {
    const crm = defineAgent({ id: "crm" });
    const watcher = defineBehavior({
      agent: crm,
      slug: "w",
      skills: ["s"],
      triggers: [{ kind: "schedule", cron: "*/30 * * * * *" }],
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [crm], behaviors: [watcher] })
      )
    ).toThrow(/too frequent/);
  });

  test("rejects multiple schedule triggers before apply", () => {
    const crm = defineAgent({ id: "crm" });
    const behavior = defineBehavior({
      agent: crm,
      slug: "w",
      skills: ["s"],
      triggers: [
        { kind: "schedule", cron: "0 8 * * *" },
        { kind: "schedule", cron: "0 9 * * *" },
      ],
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [crm], behaviors: [behavior] })
      )
    ).toThrow(/more than one schedule trigger/i);
  });

  test("requires prompt OR >=1 skill for schedule, window-event, and manual Behaviors", () => {
    const crm = defineAgent({ id: "crm" });
    const map = (behavior: ReturnType<typeof defineBehavior>) => () =>
      mapProjectToDesiredState(
        defineConfig({ agents: [crm], behaviors: [behavior] })
      );
    // Schedule trigger, no skills → rejected.
    expect(
      map(
        defineBehavior({
          agent: crm,
          slug: "sched",
          triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
        })
      )
    ).toThrow(/needs instructions/i);
    // Event trigger with execution "window", no skills → rejected.
    expect(
      map(
        defineBehavior({
          agent: crm,
          slug: "win",
          triggers: [
            {
              kind: "event",
              connector_key: "github",
              event_types: ["pull_request.created"],
              execution: "window",
            },
          ],
        })
      )
    ).toThrow(/needs instructions/i);
    // No triggers (manual-only), no skills → rejected.
    expect(map(defineBehavior({ agent: crm, slug: "manual" }))).toThrow(
      /needs instructions/i
    );
    // EITHER source satisfies the rule on its own: a prompt with no skills is a
    // valid schedule Behavior, and demanding both would reject configs the
    // server accepts.
    expect(
      map(
        defineBehavior({
          agent: crm,
          slug: "prompt-only",
          prompt: "Summarise yesterday's signups.",
          triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
        })
      )
    ).not.toThrow();
  });

  test("event-turn Behaviors may omit skills; mapper carries skills + empty prompt", () => {
    const crm = defineAgent({ id: "crm" });
    const listen = defineBehavior({
      agent: crm,
      slug: "listen",
      triggers: [
        {
          kind: "event",
          connector_key: "slack",
          event_types: ["message.created"],
          // execution omitted → defaults to "turn"
        },
      ],
    });
    const packs = defineBehavior({
      agent: crm,
      slug: "packs",
      skills: ["triage", "sql-style"],
      triggers: [
        {
          kind: "event",
          connector_key: "slack",
          event_types: ["message.created"],
          execution: "turn",
        },
      ],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [crm], behaviors: [listen, packs] })
    );
    // The mapper cannot read skill files — the loader resolves their snapshots.
    expect(state.watchers[0]?.prompt).toBe("");
    expect(state.watchers[0]?.skills).toBeUndefined();
    expect(state.watchers[1]?.skills).toEqual(["triage", "sql-style"]);
  });

  test("rejects duplicate and over-cap Behavior skills", () => {
    const crm = defineAgent({ id: "crm" });
    const map = (skills: string[]) => () =>
      mapProjectToDesiredState(
        defineConfig({
          agents: [crm],
          behaviors: [defineBehavior({ agent: crm, slug: "w", skills })],
        })
      );
    expect(map(["a", "b", "a"])).toThrow(/duplicate skill/i);
    expect(map(["a", "b", "c", "d", "e", "f"])).toThrow(/maximum is 5/i);
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

  test("maps a virtual feed to DesiredFeed.virtual (config-as-constructor, #1899)", () => {
    const conn = defineConnection({
      slug: "warehouse",
      connector: "postgres",
      feeds: [
        {
          feed: "query",
          name: "Churn rollup (live)",
          virtual: true,
          config: { query: "SELECT 1" },
        },
      ],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], connections: [conn] })
    );
    expect(state.connectors.connections[0]?.feeds).toEqual([
      {
        feedKey: "query",
        name: "Churn rollup (live)",
        schedule: null,
        config: { query: "SELECT 1" },
        virtual: true,
      },
    ]);
  });

  test("rejects a virtual feed that also declares a schedule (#1899)", () => {
    const conn = defineConnection({
      slug: "warehouse",
      connector: "postgres",
      feeds: [{ feed: "query", virtual: true, schedule: "0 * * * *" }],
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [], connections: [conn] })
      )
    ).toThrow(/virtual.*cannot have a schedule/);
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

  test("--only agents excludes Behaviors before validating their connections", () => {
    const crm = defineAgent({ id: "crm" });
    const behavior = defineBehavior({
      agent: crm,
      slug: "review-pr",
      triggers: [
        {
          kind: "event",
          connector_key: "github",
          connection: "github-main",
          event_types: ["pull_request.created"],
          execution: "turn",
          active_run: "queue",
          output: "silent",
        },
      ],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [crm], behaviors: [behavior] }),
      env,
      "agents"
    );
    expect(state.watchers).toEqual([]);
  });

  test("--only memory validates Behavior handles without reconciling connections", () => {
    const crm = defineAgent({ id: "crm" });
    const github = defineConnection({
      slug: "github-main",
      connector: "github",
    });
    const behavior = defineBehavior({
      agent: crm,
      slug: "review-pr",
      triggers: [
        {
          kind: "event",
          connector_key: "github",
          connection: github,
          event_types: ["pull_request.created"],
          execution: "turn",
          active_run: "queue",
          output: "silent",
        },
      ],
    });
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [crm],
        behaviors: [behavior],
        connections: [github],
      }),
      env,
      "memory"
    );
    expect(state.watchers[0]?.triggers?.[0]).toMatchObject({
      connectionSlug: "github-main",
    });
    expect(state.connectors.connections).toEqual([]);
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
  });

  test("maps org providers: slug/kind/displayName, RESOLVED key, capabilities", () => {
    const providerEnv: NodeJS.ProcessEnv = {
      ...env,
      ACME_VLLM_KEY: "vllm-real-key",
    };
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [],
        providers: [
          {
            slug: "openai-vllm",
            kind: "openai",
            key: secret("ACME_VLLM_KEY"),
            displayName: "ACME vLLM",
            capabilities: {
              text: {
                base_url: "https://vllm.acme.internal/v1",
                model: "llama-3.3-70b",
                models_endpoint: "/models",
              },
              image: {
                base_url: "https://img.acme.internal/v1",
                model: "sdxl",
              },
            },
          },
        ],
      }),
      providerEnv
    );
    const p = state.providers[0];
    expect(p?.slug).toBe("openai-vllm");
    expect(p?.kind).toBe("openai");
    expect(p?.displayName).toBe("ACME vLLM");
    // secret() resolves to the REAL env value (apply pushes it to the server).
    expect(p?.apiKey).toBe("vllm-real-key");
    expect(p?.capabilities).toEqual({
      text: {
        base_url: "https://vllm.acme.internal/v1",
        model: "llama-3.3-70b",
        models_endpoint: "/models",
      },
      image: { base_url: "https://img.acme.internal/v1", model: "sdxl" },
    });
    // The env-ref is collected so the secrets gate fails loud when unset.
    expect(state.requiredSecrets).toContain("ACME_VLLM_KEY");
  });

  test("resolves a $VAR provider key literal to the env value", () => {
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [],
        providers: [{ slug: "p", kind: "openai", key: "$ACME_VLLM_KEY" }],
      }),
      { ...env, ACME_VLLM_KEY: "from-var" }
    );
    expect(state.providers[0]?.apiKey).toBe("from-var");
    expect(state.requiredSecrets).toContain("ACME_VLLM_KEY");
  });

  test("omits capabilities/displayName when not declared", () => {
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [],
        providers: [{ slug: "p", kind: "openai", key: "literal-key" }],
      }),
      env
    );
    const p = state.providers[0];
    expect(p?.apiKey).toBe("literal-key");
    expect(p?.capabilities).toEqual({});
    expect(p).not.toHaveProperty("displayName");
  });

  test("rejects an invalid provider slug", () => {
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({
          agents: [],
          providers: [{ slug: "Bad_Slug", kind: "openai", key: "k" }],
        }),
        env
      )
    ).toThrow(/provider slug/);
  });

  test("rejects a trailing-hyphen slug (DB CHECK parity)", () => {
    // The DB CHECK rejects a trailing hyphen; the CLI regex MUST match so apply
    // fails up front instead of the server 500ing on the constraint.
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({
          agents: [],
          providers: [{ slug: "myvllm-", kind: "openai", key: "k" }],
        }),
        env
      )
    ).toThrow(/provider slug/);
  });

  test("accepts a single-character slug (DB CHECK parity)", () => {
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [],
        providers: [{ slug: "p", kind: "openai", key: "k" }],
      }),
      env
    );
    expect(state.providers.map((p) => p.slug)).toContain("p");
  });

  test("rejects an unknown modality", () => {
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({
          agents: [],
          providers: [
            {
              slug: "p",
              kind: "openai",
              key: "k",
              capabilities: {
                // @ts-expect-error — exercising the runtime guard for a bad modality
                video: { base_url: "https://x.example/v1" },
              },
            },
          ],
        }),
        env
      )
    ).toThrow(/unknown modality/i);
  });

  test("rejects duplicate provider slugs", () => {
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({
          agents: [],
          providers: [
            { slug: "dup", kind: "openai", key: "a" },
            { slug: "dup", kind: "openai", key: "b" },
          ],
        }),
        env
      )
    ).toThrow(/duplicate provider slug "dup"/i);
  });

  test("skips org providers under --only (no secrets demanded)", () => {
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [defineAgent({ id: "a" })],
        providers: [
          { slug: "p", kind: "openai", key: secret("ACME_VLLM_KEY") },
        ],
      }),
      env,
      "agents"
    );
    expect(state.providers).toEqual([]);
    expect(state.requiredSecrets).not.toContain("ACME_VLLM_KEY");
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

  test("preserves agent network and nix when merging skills", () => {
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
      },
    ]);
    expect(settings.networkConfig?.allowedDomains).toEqual(["agent.com"]);
    expect(settings.networkConfig?.deniedDomains).toEqual(["blocked.com"]);
    expect(settings.nixConfig?.packages).toEqual(["ffmpeg"]);
  });

  test("no markdown / no skills leaves settings untouched", () => {
    const settings: Partial<AgentSettings> = {};
    mergeAgentDirArtifacts(settings, {}, []);
    expect(settings).toEqual({});
  });
});
