import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfigFromFiles } from "../config/file-loader.js";

describe("file-loader provider credential handling", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "lobu-file-loader-providers-"));
    mkdirSync(join(projectDir, "agents", "support"), { recursive: true });
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeToml(providerBlock: string): void {
    writeFileSync(
      join(projectDir, "lobu.toml"),
      `
[agents.support]
name = "support"
dir = "./agents/support"

${providerBlock}
`,
      "utf-8"
    );
  }

  test("accepts a provider with only an id", async () => {
    writeToml(`
[[agents.support.providers]]
id = "openai"
`);

    const agents = await loadAgentConfigFromFiles(projectDir);

    expect(agents).toHaveLength(1);
    expect(agents[0]?.settings.installedProviders).toEqual([
      { providerId: "openai", installedAt: expect.any(Number) },
    ]);
    expect(agents[0]?.credentials).toEqual([]);
  });

  test("accepts a provider with a model but no credentials", async () => {
    writeToml(`
[[agents.support.providers]]
id = "openai"
model = "openai/gpt-5"
`);

    const agents = await loadAgentConfigFromFiles(projectDir);

    expect(agents).toHaveLength(1);
    expect(agents[0]?.settings.installedProviders).toEqual([
      { providerId: "openai", installedAt: expect.any(Number) },
    ]);
    expect(agents[0]?.settings.providerModelPreferences).toEqual({
      openai: "openai/gpt-5",
    });
    expect(agents[0]?.credentials).toEqual([]);
  });

  test("keeps key-based credentials separate from installed providers", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    writeToml(`
[[agents.support.providers]]
id = "openai"
key = "$OPENAI_API_KEY"
`);

    const agents = await loadAgentConfigFromFiles(projectDir);

    expect(agents).toHaveLength(1);
    expect(agents[0]?.settings.installedProviders).toEqual([
      { providerId: "openai", installedAt: expect.any(Number) },
    ]);
    expect(agents[0]?.credentials).toEqual([
      { provider: "openai", key: "sk-openai" },
    ]);
  });

  test("keeps secret-ref credentials separate from installed providers", async () => {
    writeToml(`
[[agents.support.providers]]
id = "openai"
secret_ref = "secret://providers%2Fopenai"
`);

    const agents = await loadAgentConfigFromFiles(projectDir);

    expect(agents).toHaveLength(1);
    expect(agents[0]?.settings.installedProviders).toEqual([
      { providerId: "openai", installedAt: expect.any(Number) },
    ]);
    expect(agents[0]?.credentials).toEqual([
      { provider: "openai", secretRef: "secret://providers%2Fopenai" },
    ]);
  });

  test("supports mixed provider lists with and without credentials", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    writeToml(`
[[agents.support.providers]]
id = "openai"
key = "$OPENAI_API_KEY"

[[agents.support.providers]]
id = "anthropic"
model = "anthropic/claude-sonnet-4"
`);

    const agents = await loadAgentConfigFromFiles(projectDir);

    expect(agents).toHaveLength(1);
    expect(agents[0]?.settings.installedProviders).toEqual([
      { providerId: "openai", installedAt: expect.any(Number) },
      { providerId: "anthropic", installedAt: expect.any(Number) },
    ]);
    expect(agents[0]?.settings.providerModelPreferences).toEqual({
      anthropic: "anthropic/claude-sonnet-4",
    });
    expect(agents[0]?.credentials).toEqual([
      { provider: "openai", key: "sk-openai" },
    ]);
  });

  test("rejects providers that set both key and secret_ref", async () => {
    writeToml(`
[[agents.support.providers]]
id = "openai"
key = "sk-openai"
secret_ref = "secret://providers%2Fopenai"
`);

    const agents = await loadAgentConfigFromFiles(projectDir);
    expect(agents).toHaveLength(0);
  });
});
