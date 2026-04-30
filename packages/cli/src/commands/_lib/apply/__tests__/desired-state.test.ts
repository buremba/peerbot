import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStableConnectionId, loadDesiredState } from "../desired-state.js";

describe("buildStableConnectionId — keep in sync with file-loader.ts:56", () => {
  test("two parts when no name", () => {
    expect(buildStableConnectionId("triage", "telegram")).toBe(
      "triage-telegram"
    );
  });
  test("three parts when name provided", () => {
    expect(buildStableConnectionId("triage", "slack", "ops")).toBe(
      "triage-slack-ops"
    );
  });
  test("slugifies non-alphanumeric chars in agent + type + name", () => {
    expect(buildStableConnectionId("Tri Age", "Slack/Ops", "Bot 1")).toBe(
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

  test("collects $VAR references from connections + providers", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
description = ""
dir = "./agents/triage"

[[agents.triage.providers]]
id = "anthropic"
key = "$ANTHROPIC_API_KEY"

[[agents.triage.connections]]
type = "telegram"
[agents.triage.connections.config]
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
    expect(state.agents[0]!.connections).toHaveLength(1);
    expect(state.agents[0]!.connections[0]!.stableId).toBe("triage-telegram");
    expect(state.agents[0]!.connections[0]!.config.botToken).toBe(
      "tg-fake-token"
    );
  });

  test("throws when a connection $VAR ref is unset in the apply env", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[[agents.triage.connections]]
type = "telegram"
[agents.triage.connections.config]
botToken = "$TELEGRAM_BOT_TOKEN"
`
    );
    await expect(loadDesiredState({ cwd: dir, env: {} })).rejects.toThrow(
      /\$TELEGRAM_BOT_TOKEN/
    );
  });

  test("rejects duplicate (type, name) connection pairs", async () => {
    const dir = mkProject(
      `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[[agents.triage.connections]]
type = "slack"
[agents.triage.connections.config]
botToken = "x"

[[agents.triage.connections]]
type = "slack"
[agents.triage.connections.config]
botToken = "y"
`
    );
    await expect(loadDesiredState({ cwd: dir })).rejects.toThrow(
      /multiple "slack" connections/
    );
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
