import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDesiredStateFromConfig } from "../desired-state.js";

// Fixtures live under the worktree (next to this test) so that the externalized
// `@lobu/cli/config` import in the generated bundle resolves from node_modules.
describe("loadDesiredStateFromConfig", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("bundles + imports lobu.config.ts and maps it to DesiredState", async () => {
    dir = mkdtempSync(join(import.meta.dir, "fixture-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineEntityType } from "@lobu/cli/config";`,
        `const person = defineEntityType({ key: "person" });`,
        `export default defineConfig({`,
        `  org: "test-org",`,
        `  agents: [defineAgent({ id: "crm" })],`,
        `  entities: [person],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state, configPath } = await loadDesiredStateFromConfig({
      cwd: dir,
    });
    expect(configPath).toContain("lobu.config.ts");
    expect(state.memory).toEqual({ org: "test-org" });
    expect(state.agents[0]?.metadata.agentId).toBe("crm");
    expect(state.memorySchema.entityTypes[0]?.slug).toBe("person");
  });

  test("rejects when no lobu.config.ts is present", async () => {
    dir = mkdtempSync(join(import.meta.dir, "empty-"));
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /No lobu\.config\.ts/
    );
  });

  test("rejects a config whose default export is not defineConfig()", async () => {
    dir = mkdtempSync(join(import.meta.dir, "bad-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      `export default { nope: true };\n`
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /defineConfig/
    );
  });

  test("ships a connectorFromFile source referenced by a connection", async () => {
    dir = mkdtempSync(join(import.meta.dir, "connector-"));
    writeFileSync(
      join(dir, "weather.connector.ts"),
      [
        `import { defineConnector } from "@lobu/connector-sdk/define-connector";`,
        `export default defineConnector({`,
        `  key: "weather",`,
        `  feeds: { current: { sync: async () => [] } },`,
        `});`,
        ``,
      ].join("\n")
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { connectorFromFile, defineAgent, defineConfig, defineConnection } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "crm" })],`,
        `  connectors: [connectorFromFile("./weather.connector.ts")],`,
        `  connections: [defineConnection({ slug: "weather", connector: "weather" })],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.connectors.definitions).toHaveLength(1);
    const def = state.connectors.definitions[0];
    expect(def?.key).toBeNull();
    expect(def?.sourceFile).toBe("weather.connector.ts");
    expect(def?.sourcePath).toContain("weather.connector.ts");
    expect(def?.sourceCode).toContain("defineConnector");
    // The connection references the connector by key; the server resolves the
    // null key when it compiles the shipped source.
    expect(state.connectors.connections[0]?.connector).toBe("weather");
  });

  test("--only agents skips connector definitions", async () => {
    dir = mkdtempSync(join(import.meta.dir, "only-"));
    writeFileSync(
      join(dir, "weather.connector.ts"),
      [
        `import { defineConnector } from "@lobu/connector-sdk/define-connector";`,
        `export default defineConnector({ key: "weather", feeds: { current: { sync: async () => [] } } });`,
        ``,
      ].join("\n")
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { connectorFromFile, defineAgent, defineConfig } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "crm" })],`,
        `  connectors: [connectorFromFile("./weather.connector.ts")],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({
      cwd: dir,
      only: "agents",
    });
    expect(state.connectors.definitions).toHaveLength(0);
  });

  test("connector definitions are sorted by sourceFile", async () => {
    dir = mkdtempSync(join(import.meta.dir, "multi-"));
    const src = `import { defineConnector } from "@lobu/connector-sdk/define-connector";\nexport default defineConnector({ key: "x", feeds: {} });\n`;
    writeFileSync(join(dir, "beta.connector.ts"), src);
    writeFileSync(join(dir, "alpha.connector.ts"), src);
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { connectorFromFile, defineAgent, defineConfig } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "crm" })],`,
        `  connectors: [`,
        `    connectorFromFile("./beta.connector.ts"),`,
        `    connectorFromFile("./alpha.connector.ts"),`,
        `  ],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.connectors.definitions.map((d) => d.sourceFile)).toEqual([
      "alpha.connector.ts",
      "beta.connector.ts",
    ]);
  });

  test("connectorFromFile with a missing file fails clearly", async () => {
    dir = mkdtempSync(join(import.meta.dir, "missingconn-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { connectorFromFile, defineAgent, defineConfig } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "crm" })],`,
        `  connectors: [connectorFromFile("./nope.connector.ts")],`,
        `});`,
        ``,
      ].join("\n")
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /connectorFromFile.*does not exist/
    );
  });

  test("connectorFromFile rejects a path escaping the config dir", async () => {
    dir = mkdtempSync(join(import.meta.dir, "escconn-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { connectorFromFile, defineAgent, defineConfig } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "crm" })],`,
        `  connectors: [connectorFromFile("../evil.connector.ts")],`,
        `});`,
        ``,
      ].join("\n")
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /must not contain `\.\.`|resolves outside/
    );
  });

  test("loads agent-dir markdown + a file skill, merging skill network/nix", async () => {
    dir = mkdtempSync(join(import.meta.dir, "agentdir-"));
    const agentDir = join(dir, "agents", "crm");
    mkdirSync(join(agentDir, "skills", "crm-ops"), { recursive: true });
    writeFileSync(join(agentDir, "SOUL.md"), "You are the CRM agent.\n");
    writeFileSync(join(agentDir, "IDENTITY.md"), "CRM identity.\n");
    writeFileSync(
      join(agentDir, "skills", "crm-ops", "SKILL.md"),
      [
        `---`,
        `name: crm-ops`,
        `network:`,
        `  allow: ["api.crm.com"]`,
        `nixPackages: ["jq"]`,
        `---`,
        `Use the CRM API.`,
        ``,
      ].join("\n")
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, skillFromFile } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [`,
        `    defineAgent({`,
        `      id: "crm",`,
        `      network: { allowed: ["github.com"] },`,
        `      skills: [skillFromFile("./agents/crm/skills/crm-ops")],`,
        `    }),`,
        `  ],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    const settings = state.agents[0]?.settings;
    expect(settings?.soulMd).toBe("You are the CRM agent.");
    expect(settings?.identityMd).toBe("CRM identity.");
    expect(settings?.skillsConfig?.skills[0]?.name).toBe("crm-ops");
    // Agent + skill network domains are unioned.
    expect(settings?.networkConfig?.allowedDomains).toEqual([
      "github.com",
      "api.crm.com",
    ]);
    expect(settings?.nixConfig?.packages).toEqual(["jq"]);
  });

  test("an inline defineSkill carries content + network with no files", async () => {
    dir = mkdtempSync(join(import.meta.dir, "inline-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineSkill } from "@lobu/cli/config";`,
        `const greet = defineSkill({`,
        `  name: "greet",`,
        `  description: "Greet someone.",`,
        `  content: "Generate a warm greeting.",`,
        `  network: { allowed: ["api.greet.com"] },`,
        `});`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "a", skills: [greet] })],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    const skill = state.agents[0]?.settings.skillsConfig?.skills[0];
    expect(skill?.name).toBe("greet");
    expect(skill?.content).toBe("Generate a warm greeting.");
    expect(skill?.description).toBe("Greet someone.");
    expect(state.agents[0]?.settings.networkConfig?.allowedDomains).toEqual([
      "api.greet.com",
    ]);
  });

  test("an inline skill MCP server merges into agent mcpServers", async () => {
    dir = mkdtempSync(join(import.meta.dir, "skillmcp-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineSkill } from "@lobu/cli/config";`,
        `const api = defineSkill({`,
        `  name: "api",`,
        `  content: "Use the API.",`,
        `  mcpServers: { "support-api": { url: "https://api.example.com/mcp", type: "sse" } },`,
        `});`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "a", skills: [api] })],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    const mcp = (state.agents[0]?.settings.mcpServers ?? {}) as Record<
      string,
      { url?: string; type?: string }
    >;
    expect(mcp["support-api"]).toEqual({
      url: "https://api.example.com/mcp",
      type: "sse",
    });
  });

  test("two agents: custom + default dirs keep index alignment", async () => {
    dir = mkdtempSync(join(import.meta.dir, "multiagent-"));
    // Agent "a" uses a custom dir; agent "b" uses the default ./agents/b.
    mkdirSync(join(dir, "custom-a"), { recursive: true });
    mkdirSync(join(dir, "agents", "b"), { recursive: true });
    writeFileSync(join(dir, "custom-a", "SOUL.md"), "Agent A soul.\n");
    writeFileSync(join(dir, "agents", "b", "SOUL.md"), "Agent B soul.\n");
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [`,
        `    defineAgent({ id: "a", dir: "./custom-a" }),`,
        `    defineAgent({ id: "b" }),`,
        `  ],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    // Index alignment: agents[0]=a (custom dir), agents[1]=b (default dir).
    expect(state.agents[0]?.metadata.agentId).toBe("a");
    expect(state.agents[0]?.settings.soulMd).toBe("Agent A soul.");
    expect(state.agents[1]?.metadata.agentId).toBe("b");
    expect(state.agents[1]?.settings.soulMd).toBe("Agent B soul.");
  });

  test("a skill shared by two agents via skillFromFile lands on both", async () => {
    dir = mkdtempSync(join(import.meta.dir, "shared-"));
    mkdirSync(join(dir, "skills", "shared"), { recursive: true });
    writeFileSync(
      join(dir, "skills", "shared", "SKILL.md"),
      "---\nname: shared\n---\nShared.\n"
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, skillFromFile } from "@lobu/cli/config";`,
        `const shared = skillFromFile("./skills/shared");`,
        `export default defineConfig({`,
        `  agents: [`,
        `    defineAgent({ id: "a", skills: [shared] }),`,
        `    defineAgent({ id: "b", skills: [shared] }),`,
        `  ],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.agents[0]?.settings.skillsConfig?.skills[0]?.name).toBe(
      "shared"
    );
    expect(state.agents[1]?.settings.skillsConfig?.skills[0]?.name).toBe(
      "shared"
    );
  });

  test("rejects duplicate skill names within an agent", async () => {
    dir = mkdtempSync(join(import.meta.dir, "dup-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineSkill } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "a", skills: [`,
        `    defineSkill({ name: "ops", content: "one" }),`,
        `    defineSkill({ name: "ops", content: "two" }),`,
        `  ] })],`,
        `});`,
        ``,
      ].join("\n")
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /duplicate skill "ops"/
    );
  });

  test("skillFromFile with a missing SKILL.md fails clearly", async () => {
    dir = mkdtempSync(join(import.meta.dir, "missing-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, skillFromFile } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "a", skills: [skillFromFile("./nope")] })],`,
        `});`,
        ``,
      ].join("\n")
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /no SKILL\.md found/
    );
  });

  test("loads a watcher reaction script (raw source) referenced by path", async () => {
    dir = mkdtempSync(join(import.meta.dir, "reaction-"));
    mkdirSync(join(dir, "reactions"));
    writeFileSync(
      join(dir, "reactions", "health.reaction.ts"),
      [
        `import type { ReactionContext, ReactionClient } from "@lobu/connector-sdk";`,
        `export default async (ctx: ReactionContext, client: ReactionClient) => {`,
        `  await client.knowledge.save({ content: "ok", semantic_type: "digest" });`,
        `};`,
        ``,
      ].join("\n")
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineWatcher, reactionFromFile } from "@lobu/cli/config";`,
        `const crm = defineAgent({ id: "crm" });`,
        `export default defineConfig({`,
        `  agents: [crm],`,
        `  watchers: [defineWatcher({`,
        `    agent: crm, slug: "health", prompt: "p",`,
        `    reaction: reactionFromFile("./reactions/health.reaction.ts"),`,
        `  })],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    const rs = state.watchers[0]?.reactionScript;
    expect(rs?.sourcePath).toContain("health.reaction.ts");
    expect(rs?.sourceCode).toContain("client.knowledge.save");
  });

  test("rejects a reaction path that escapes the config dir or is missing", async () => {
    const write = (reaction: string) => {
      dir = mkdtempSync(join(import.meta.dir, "badreaction-"));
      writeFileSync(
        join(dir, "lobu.config.ts"),
        [
          `import { defineAgent, defineConfig, defineWatcher, reactionFromFile } from "@lobu/cli/config";`,
          `const crm = defineAgent({ id: "crm" });`,
          `export default defineConfig({ agents: [crm], watchers: [defineWatcher({`,
          `  agent: crm, slug: "w", prompt: "p", reaction: reactionFromFile(${JSON.stringify(reaction)}),`,
          `})] });`,
          ``,
        ].join("\n")
      );
      return loadDesiredStateFromConfig({ cwd: dir });
    };
    await expect(write("../escape.reaction.ts")).rejects.toThrow(/\.\./);
    rmSync(dir, { recursive: true, force: true });
    await expect(write("/abs/path.reaction.ts")).rejects.toThrow(
      /relative POSIX path/
    );
    rmSync(dir, { recursive: true, force: true });
    await expect(write("./missing.reaction.ts")).rejects.toThrow(
      /does not exist/
    );
    rmSync(dir, { recursive: true, force: true });
    // Present-but-empty must be rejected (not silently skipped) — parity with
    // parseWatcher, which validates whenever the field is present.
    await expect(write("")).rejects.toThrow(/sibling \.ts file/);
    rmSync(dir, { recursive: true, force: true });
    await expect(write("./notes.md")).rejects.toThrow(/must end in `\.ts`/);
  });

  test("rejects a bare-string reaction with a clear reactionFromFile message", async () => {
    // jiti evaluates the config without typechecking, so a stale
    // `reaction: "./x.reaction.ts"` string slips through. It must fail with
    // guidance to use reactionFromFile(), not a downstream TypeError.
    dir = mkdtempSync(join(import.meta.dir, "strreaction-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineWatcher } from "@lobu/cli/config";`,
        `const crm = defineAgent({ id: "crm" });`,
        `export default defineConfig({ agents: [crm], watchers: [defineWatcher({`,
        `  agent: crm, slug: "w", prompt: "p", reaction: "./reactions/x.reaction.ts",`,
        `})] });`,
        ``,
      ].join("\n")
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /reactionFromFile/
    );
  });

  test("attaches the reaction to the right watcher when only one of several has one", async () => {
    dir = mkdtempSync(join(import.meta.dir, "reactionidx-"));
    mkdirSync(join(dir, "reactions"));
    writeFileSync(
      join(dir, "reactions", "second.reaction.ts"),
      `export default async () => {};\n`
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineWatcher, reactionFromFile } from "@lobu/cli/config";`,
        `const a = defineAgent({ id: "a" });`,
        `export default defineConfig({ agents: [a], watchers: [`,
        `  defineWatcher({ agent: a, slug: "first", prompt: "p" }),`,
        `  defineWatcher({ agent: a, slug: "second", prompt: "p", reaction: reactionFromFile("./reactions/second.reaction.ts") }),`,
        `] });`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.watchers[0]?.slug).toBe("first");
    expect(state.watchers[0]?.reactionScript).toBeUndefined();
    expect(state.watchers[1]?.slug).toBe("second");
    expect(state.watchers[1]?.reactionScript?.sourcePath).toContain(
      "second.reaction.ts"
    );
  });

  test("no connectors/ dir → no definitions", async () => {
    dir = mkdtempSync(join(import.meta.dir, "nodir-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig } from "@lobu/cli/config";`,
        `export default defineConfig({ agents: [defineAgent({ id: "crm" })] });`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.connectors.definitions).toHaveLength(0);
  });
});
