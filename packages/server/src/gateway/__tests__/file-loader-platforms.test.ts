import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfigFromFiles } from "../config/file-loader.js";

describe("file-loader platforms key", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "lobu-file-loader-platforms-"));
    mkdirSync(join(projectDir, "agents", "support"), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeToml(body: string): void {
    writeFileSync(
      join(projectDir, "lobu.toml"),
      `
[agents.support]
name = "support"
dir = "./agents/support"

${body}
`,
      "utf-8"
    );
  }

  test("accepts the new [[agents.<id>.platforms]] block", async () => {
    process.env.TEST_TG_TOKEN = "tg-fake";
    try {
      writeToml(`
[[agents.support.platforms]]
type = "telegram"
[agents.support.platforms.config]
botToken = "$TEST_TG_TOKEN"
`);

      const agents = await loadAgentConfigFromFiles(projectDir);
      expect(agents).toHaveLength(1);
      expect(agents[0]?.platforms).toEqual([
        {
          id: "support-telegram",
          type: "telegram",
          config: { botToken: "tg-fake" },
        },
      ]);
    } finally {
      delete process.env.TEST_TG_TOKEN;
    }
  });

  test("rejects the legacy [[agents.<id>.connections]] block with a clear error", async () => {
    writeToml(`
[[agents.support.connections]]
type = "telegram"
[agents.support.connections.config]
botToken = "$TEST_TG_TOKEN"
`);

    await expect(loadAgentConfigFromFiles(projectDir)).rejects.toThrow(
      /\[\[agents\.support\.connections\]\] was renamed to \[\[agents\.support\.platforms\]\]/
    );
  });
});
