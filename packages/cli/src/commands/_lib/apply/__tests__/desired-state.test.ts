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

  test("rejects watcher blocks (v1 doesn't sync watchers)", async () => {
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
});
