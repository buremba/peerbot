import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStablePlatformId, loadDesiredState } from "../desired-state.js";

describe("buildStablePlatformId — keep in sync with file-loader.ts", () => {
  test("two parts when no name", () => {
    expect(buildStablePlatformId("triage", "telegram")).toBe("triage-telegram");
  });
  test("three parts when name provided", () => {
    expect(buildStablePlatformId("triage", "slack", "ops")).toBe(
      "triage-slack-ops"
    );
  });
  test("slugifies non-alphanumeric chars in agent + type + name", () => {
    expect(buildStablePlatformId("Tri Age", "Slack/Ops", "Bot 1")).toBe(
      "tri-age-slack-ops-bot-1"
    );
  });
});

describe("loadDesiredState", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function mkProject(toml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "lobu-apply-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "lobu.toml"), toml);
    return dir;
  }

  test("collects $VAR references from platforms + providers", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
description = ""
dir = "./agents/triage"

[[agents.triage.providers]]
id = "anthropic"
key = "$ANTHROPIC_API_KEY"

[[agents.triage.platforms]]
type = "telegram"
[agents.triage.platforms.config]
botToken = "$TELEGRAM_BOT_TOKEN"
`
    );
    // Provide an empty agent dir so markdown read returns nothing.
    const { state } = await loadDesiredState({
      cwd: dir,
      env: {
        ANTHROPIC_API_KEY: "sk-anth-fake",
        TELEGRAM_BOT_TOKEN: "tg-fake-token",
      },
    });
    expect(state.requiredSecrets).toEqual([
      "ANTHROPIC_API_KEY",
      "TELEGRAM_BOT_TOKEN",
    ]);
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0]!.metadata.agentId).toBe("triage");
    expect(state.agents[0]!.platforms).toHaveLength(1);
    expect(state.agents[0]!.platforms[0]!.stableId).toBe("triage-telegram");
    expect(state.agents[0]!.platforms[0]!.config.botToken).toBe(
      "tg-fake-token"
    );
  });

  test("throws when a platform $VAR ref is unset in the apply env", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[[agents.triage.platforms]]
type = "telegram"
[agents.triage.platforms.config]
botToken = "$TELEGRAM_BOT_TOKEN"
`
    );
    await expect(loadDesiredState({ cwd: dir, env: {} })).rejects.toThrow(
      /\$TELEGRAM_BOT_TOKEN/
    );
  });

  test("rejects duplicate (type, name) platform pairs", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[[agents.triage.platforms]]
type = "slack"
[agents.triage.platforms.config]
botToken = "x"

[[agents.triage.platforms]]
type = "slack"
[agents.triage.platforms.config]
botToken = "y"
`
    );
    await expect(loadDesiredState({ cwd: dir })).rejects.toThrow(
      /multiple "slack" platforms/
    );
  });

  test("carries Slack platform `channels` onto the desired platform", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[[agents.triage.platforms]]
type = "slack"
channels = ["T0ABCDEF/C0123ABCD", "T0ABCDEF/C0456WXYZ"]
[agents.triage.platforms.config]
botToken = "x"
`
    );
    const { state } = await loadDesiredState({ cwd: dir });
    expect(state.agents[0]!.platforms[0]!.channels).toEqual([
      "T0ABCDEF/C0123ABCD",
      "T0ABCDEF/C0456WXYZ",
    ]);
  });

  test("rejects malformed Slack `channels` entries", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[[agents.triage.platforms]]
type = "slack"
channels = ["C0123ABCD"]
[agents.triage.platforms.config]
botToken = "x"
`
    );
    await expect(loadDesiredState({ cwd: dir })).rejects.toThrow(
      /<teamId>\/<channelId>/
    );
  });

  test("rejects `channels` on a non-Slack platform", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[[agents.triage.platforms]]
type = "telegram"
channels = ["T0ABCDEF/C0123ABCD"]
[agents.triage.platforms.config]
botToken = "x"
`
    );
    await expect(loadDesiredState({ cwd: dir })).rejects.toThrow(
      /only supported for Slack/
    );
  });

  test("loads local skills and merges skill network, nix, and MCP declarations", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[agents.triage.network]
allowed = ["api.operator.example.com"]

[agents.triage.worker]
nix_packages = ["git"]
`
    );
    const skillDir = join(dir, "agents", "triage", "skills", "docs-search");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: docs-search
description: Search docs safely
nixPackages: [ripgrep]
network:
  allow: ["*.docs.example.com", "*"]
mcpServers:
  docs:
    url: "https://docs.example.com/mcp"
---
Use the docs MCP before answering.
`
    );

    const { state } = await loadDesiredState({ cwd: dir });
    const settings = state.agents[0]!.settings;
    expect(settings.skillsConfig?.skills[0]?.name).toBe("docs-search");
    expect(settings.networkConfig?.allowedDomains).toEqual([
      "api.operator.example.com",
      ".docs.example.com",
    ]);
    expect(settings.nixConfig?.packages).toEqual(["git", "ripgrep"]);
    expect(settings.mcpServers?.docs?.url).toBe("https://docs.example.com/mcp");
  });

  test("rejects stale nested memory config", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory.lobu]
enabled = false
org = "dev"
models = "./custom-models"
`
    );
    await expect(loadDesiredState({ cwd: dir })).rejects.toThrow(/lobu/);
  });

  test("loads watcher model files into state.watchers", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory]
enabled = true
org = "dev"
models = "./models"
`
    );
    const modelsDir = join(dir, "models");
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(
      join(modelsDir, "digest.yaml"),
      `version: 2
watchers:
  - slug: weekly-digest
    agent: triage
    name: Weekly digest
    description: A short weekly summary.
    schedule: "0 9 * * 1"
    prompt: |
      Produce a short weekly digest.
    extraction_schema:
      type: object
      required: [summary]
      properties:
        summary: { type: string }
    sources:
      - name: content
        query: SELECT * FROM events ORDER BY occurred_at DESC
`
    );

    const { state } = await loadDesiredState({ cwd: dir });
    expect(state.watchers).toHaveLength(1);
    const w = state.watchers[0]!;
    expect(w.slug).toBe("weekly-digest");
    expect(w.agent).toBe("triage");
    expect(w.name).toBe("Weekly digest");
    expect(w.description).toBe("A short weekly summary.");
    expect(w.schedule).toBe("0 9 * * 1");
    expect(w.prompt).toContain("weekly digest");
    expect(w.extractionSchema).toMatchObject({
      type: "object",
      required: ["summary"],
    });
    expect(w.sources).toEqual([
      {
        name: "content",
        query: "SELECT * FROM events ORDER BY occurred_at DESC",
      },
    ]);
  });

  test("loads dbt-style bundled model files recursively", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory]
enabled = true
org = "dev"
models = "./models"
`
    );
    const domainDir = join(dir, "models", "sales");
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(
      join(domainDir, "schema.yml"),
      `version: 2
entities:
  - slug: account
    name: Account
    description: Customer account
    metadata_schema:
      type: object
      required: [tier]
      properties:
        tier: { type: string }
relationships:
  - slug: owns
    name: Owns
    rules:
      - source: account
        target: product
watchers:
  - slug: account-digest
    agent: triage
    name: Account digest
    schedule: "0 9 * * 1"
    prompt: Summarize account changes.
`
    );

    const { state } = await loadDesiredState({ cwd: dir });
    expect(state.memorySchema.entityTypes).toEqual([
      {
        slug: "account",
        name: "Account",
        description: "Customer account",
        required: ["tier"],
        properties: { tier: { type: "string" } },
      },
    ]);
    expect(state.memorySchema.relationshipTypes).toEqual([
      {
        slug: "owns",
        name: "Owns",
        rules: [{ source: "account", target: "product" }],
      },
    ]);
    expect(state.watchers.map((w) => w.slug)).toEqual(["account-digest"]);
  });

  test("loads multiple model YAML documents from one file", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory]
enabled = true
org = "dev"
models = "./models"
`
    );
    const modelsDir = join(dir, "models");
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(
      join(modelsDir, "combined.yaml"),
      `version: 2
entities:
  - slug: product
    name: Product
---
version: 2
relationships:
  - slug: affects
    name: Affects
`
    );

    const { state } = await loadDesiredState({ cwd: dir });
    expect(state.memorySchema.entityTypes.map((e) => e.slug)).toEqual([
      "product",
    ]);
    expect(state.memorySchema.relationshipTypes.map((r) => r.slug)).toEqual([
      "affects",
    ]);
  });

  test("skips empty / comments-only model YAML files", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory]
enabled = true
org = "dev"
models = "./models"
`
    );
    const modelsDir = join(dir, "models");
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(join(modelsDir, "blank.yaml"), "");
    writeFileSync(
      join(modelsDir, "comment-only.yaml"),
      "# placeholder, nothing here yet\n"
    );
    writeFileSync(
      join(modelsDir, "schema.yaml"),
      `version: 2
entities:
  - slug: product
    name: Product
`
    );

    const { state } = await loadDesiredState({ cwd: dir });
    expect(state.memorySchema.entityTypes.map((e) => e.slug)).toEqual([
      "product",
    ]);
  });

  test("rejects the removed inline [memory.schema] block", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory]
enabled = true
org = "dev"

[[memory.schema.entity_types]]
slug = "account"
name = "Account"
`
    );

    await expect(loadDesiredState({ cwd: dir })).rejects.toThrow();
  });

  test("surfaces a YAML syntax error with file context", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory]
enabled = true
org = "dev"
models = "./models"
`
    );
    const modelsDir = join(dir, "models");
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(
      join(modelsDir, "broken.yaml"),
      `version: 2
entities:
  - slug: product
   name: Product
`
    );

    await expect(loadDesiredState({ cwd: dir })).rejects.toThrow(
      /broken\.yaml/
    );
  });

  test("rejects watcher blocks in lobu.toml (apply syncs model-bundle watchers, not toml)", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[[agents.triage.watchers]]
slug = "stale"
`
    );
    await expect(loadDesiredState({ cwd: dir })).rejects.toThrow(/watchers/);
  });

  // ── Connectors ────────────────────────────────────────────────────────────

  const TOML_WITH_MEMORY = `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory]
connectors = "./connectors"
`;

  function mkConnectorsProject(files: Record<string, string>): string {
    const dir = mkProject(TOML_WITH_MEMORY);
    mkdirSync(join(dir, "connectors"));
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, "connectors", name), body);
    }
    return dir;
  }

  test("loads built-in connection + auth_profile + custom .connector.ts", async () => {
    const dir = mkConnectorsProject({
      "acme.connector.ts": "export default class Acme {}\n",
      "hackernews.yaml": `version: 1
type: auth_profile
slug: hn-token
connector: hackernews
kind: env
credentials:
  HN_TOKEN: $HN_TOKEN
---
version: 1
type: connection
slug: hn-frontpage
connector: hackernews
name: HN front page
auth: hn-token
feeds:
  - feed: stories
    schedule: "0 * * * *"
`,
      "x.yaml": `version: 1
type: auth_profile
slug: x-account
connector: x
kind: oauth_account
`,
    });

    const { state } = await loadDesiredState({
      cwd: dir,
      env: { HN_TOKEN: "secret-token" },
    });
    expect(state.connectors.definitions).toHaveLength(1);
    expect(state.connectors.definitions[0]!.sourceCode).toContain("class Acme");
    expect(state.connectors.definitions[0]!.key).toBeNull();
    expect(state.connectors.authProfiles.map((p) => p.slug).sort()).toEqual([
      "hn-token",
      "x-account",
    ]);
    expect(
      state.connectors.authProfiles.find((p) => p.slug === "hn-token")!
        .credentials
    ).toEqual({ HN_TOKEN: "secret-token" });
    const conn = state.connectors.connections[0]!;
    expect(conn.slug).toBe("hn-frontpage");
    expect(conn.authProfileSlug).toBe("hn-token");
    expect(conn.feeds).toEqual([{ feedKey: "stories", schedule: "0 * * * *" }]);
  });

  test("collects $ENV refs from auth_profile credentials and expands them", async () => {
    const dir = mkConnectorsProject({
      "auth.yaml": `version: 1
type: auth_profile
slug: hn-token
connector: hackernews
kind: env
credentials:
  HN_TOKEN: $HN_API_TOKEN
`,
    });
    const { state } = await loadDesiredState({
      cwd: dir,
      env: { HN_API_TOKEN: "abc123" },
    });
    expect(state.requiredSecrets).toContain("HN_API_TOKEN");
    expect(state.connectors.authProfiles[0]!.credentials).toEqual({
      HN_TOKEN: "abc123",
    });
  });

  test("fails loudly when an auth_profile credential references an unset env var", async () => {
    const dir = mkConnectorsProject({
      "auth.yaml": `version: 1
type: auth_profile
slug: hn-token
connector: hackernews
kind: env
credentials:
  HN_TOKEN: $HN_API_TOKEN
`,
    });
    await expect(loadDesiredState({ cwd: dir, env: {} })).rejects.toThrow(
      /references \$HN_API_TOKEN/
    );
  });

  test("rejects credentials on oauth_account auth profiles", async () => {
    const dir = mkConnectorsProject({
      "auth.yaml": `version: 1
type: auth_profile
slug: x-account
connector: x
kind: oauth_account
credentials:
  token: nope
`,
    });
    await expect(loadDesiredState({ cwd: dir, env: {} })).rejects.toThrow(
      /credentials must not be set/
    );
  });

  test("rejects an unknown auth_profile kind", async () => {
    const dir = mkConnectorsProject({
      "auth.yaml": `version: 1
type: auth_profile
slug: x-account
connector: x
kind: bogus
`,
    });
    await expect(loadDesiredState({ cwd: dir, env: {} })).rejects.toThrow(
      /kind.*must be one of/
    );
  });

  test("rejects a connector doc declaring both source_path and source_url", async () => {
    const dir = mkConnectorsProject({
      "acme.yaml": `version: 1
type: connector
key: acme
source_path: ./acme.ts
source_url: https://example.com/acme.ts
`,
    });
    await expect(loadDesiredState({ cwd: dir, env: {} })).rejects.toThrow(
      /exactly one of/
    );
  });

  test("validates connection config against the connector optionsSchema", async () => {
    const { validateConnectionAgainstConnector, resolveConnectorSchemas } =
      await import("../desired-state.js");
    const schemas = resolveConnectorSchemas({
      options_schema: {
        type: "object",
        properties: { limit: { type: "number" } },
        required: ["limit"],
        additionalProperties: false,
      },
      feeds_schema: { stories: { configSchema: { type: "object" } } },
      auth_schema: { methods: [{ type: "env_keys" }] },
    });
    expect(() =>
      validateConnectionAgainstConnector(
        {
          slug: "bad",
          connector: "demo",
          config: { limit: "oops" },
          feeds: [],
          sourceFile: "connectors/demo.yaml",
        },
        new Map(),
        schemas
      )
    ).toThrow(/connection "bad" config/);
  });

  // ── round-2 ──────────────────────────────────────────────────────────────

  test("rejects a non-canonical connection slug", async () => {
    const dir = mkConnectorsProject({
      "x.yaml": `version: 1
type: connection
slug: My_Connection
connector: hackernews
`,
    });
    await expect(loadDesiredState({ cwd: dir, env: {} })).rejects.toThrow(
      /connection slug "My_Connection" must match/
    );
  });

  test("rejects an invalid feed cron schedule", async () => {
    const dir = mkConnectorsProject({
      "x.yaml": `version: 1
type: connection
slug: hn
connector: hackernews
feeds:
  - feed: stories
    schedule: "not a cron"
`,
    });
    await expect(loadDesiredState({ cwd: dir, env: {} })).rejects.toThrow(
      /invalid cron expression/
    );
  });

  test("rejects duplicate connector keys across definitions", async () => {
    const dir = mkConnectorsProject({
      "a.yaml": `version: 1
type: connector
key: dup
source_url: https://example.com/a.ts
---
version: 1
type: connector
key: dup
source_url: https://example.com/b.ts
`,
    });
    await expect(loadDesiredState({ cwd: dir, env: {} })).rejects.toThrow(
      /connector key "dup" is declared (twice|by two)/
    );
  });

  test("rejects duplicate connector keys across separate files", async () => {
    const dir = mkConnectorsProject({
      "a.yaml": `version: 1
type: connector
key: dup2
source_url: https://example.com/a.ts
`,
      "b.yaml": `version: 1
type: connector
key: dup2
source_url: https://example.com/b.ts
`,
    });
    await expect(loadDesiredState({ cwd: dir, env: {} })).rejects.toThrow(
      /connector key "dup2" is declared (twice|by two)/
    );
  });

  test("--only agents skips the connectors dir (no connector-secret expansion)", async () => {
    const dir = mkConnectorsProject({
      "auth.yaml": `version: 1
type: auth_profile
slug: hn-token
connector: hackernews
kind: env
credentials:
  HN_TOKEN: $HN_API_TOKEN
`,
    });
    // $HN_API_TOKEN is unset, but --only agents must not load/expand it.
    const { state } = await loadDesiredState({
      cwd: dir,
      env: {},
      only: "agents",
    });
    expect(state.connectors.authProfiles).toHaveLength(0);
    expect(state.connectors.connections).toHaveLength(0);
    expect(state.requiredSecrets).not.toContain("HN_API_TOKEN");
  });

  // ── round-3 ──────────────────────────────────────────────────────────────

  test("rejects two type:connector docs with the same key (cites both files)", async () => {
    const dir = mkConnectorsProject({
      "a.yaml": `version: 1
type: connector
key: dup3
source_url: https://example.com/a.ts
`,
      "b.yaml": `version: 1
type: connector
key: dup3
source_url: https://example.com/b.ts
`,
    });
    let msg = "";
    await loadDesiredState({ cwd: dir, env: {} }).catch((e) => {
      msg = e instanceof Error ? e.message : String(e);
    });
    expect(msg).toMatch(/connector key "dup3" is declared (twice|by two)/);
    expect(msg).toMatch(/a\.yaml/);
    expect(msg).toMatch(/b\.yaml/);
  });

  test("rejects two type:connector docs with the same key in one file", async () => {
    const dir = mkConnectorsProject({
      "a.yaml": `version: 1
type: connector
key: dup4
source_url: https://example.com/a.ts
---
version: 1
type: connector
key: dup4
source_url: https://example.com/b.ts
`,
    });
    await expect(loadDesiredState({ cwd: dir, env: {} })).rejects.toThrow(
      /connector key "dup4" is declared (twice|by two)/
    );
  });

  test("rejects a non-https connector source_url", async () => {
    const dir = mkConnectorsProject({
      "a.yaml": `version: 1
type: connector
key: insecure
source_url: http://example.com/a.ts
`,
    });
    await expect(loadDesiredState({ cwd: dir, env: {} })).rejects.toThrow(
      /source_url must use https/
    );
  });
});
