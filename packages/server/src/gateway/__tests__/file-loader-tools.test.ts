import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfigFromFiles } from "../config/file-loader.js";

describe("file-loader [agents.<id>.tools] section", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "lobu-file-loader-tools-"));
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

  test("maps tools.pre_approved to settings.preApprovedTools", async () => {
    writeToml(`
[agents.support.tools]
pre_approved = [
  "/mcp/gmail/tools/list_messages",
  "/mcp/linear/tools/*",
]
`);

    const agents = await loadAgentConfigFromFiles(projectDir);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.settings.preApprovedTools).toEqual([
      "/mcp/gmail/tools/list_messages",
      "/mcp/linear/tools/*",
    ]);
  });

  test("maps tools.allowed/denied/strict to settings.toolsConfig", async () => {
    writeToml(`
[agents.support.tools]
allowed = ["Read", "Grep", "mcp__gmail__*"]
denied = ["Bash(rm:*)"]
strict = true
`);

    const agents = await loadAgentConfigFromFiles(projectDir);
    expect(agents[0]?.settings.toolsConfig).toEqual({
      allowedTools: ["Read", "Grep", "mcp__gmail__*"],
      deniedTools: ["Bash(rm:*)"],
      strictMode: true,
    });
  });

  test("omits tools fields entirely when section is missing", async () => {
    writeToml("");

    const agents = await loadAgentConfigFromFiles(projectDir);
    expect(agents[0]?.settings.preApprovedTools).toBeUndefined();
    expect(agents[0]?.settings.toolsConfig).toBeUndefined();
  });

  test("dedupes pre_approved entries", async () => {
    writeToml(`
[agents.support.tools]
pre_approved = [
  "/mcp/gmail/tools/send_email",
  "/mcp/gmail/tools/send_email",
]
`);

    const agents = await loadAgentConfigFromFiles(projectDir);
    expect(agents[0]?.settings.preApprovedTools).toEqual([
      "/mcp/gmail/tools/send_email",
    ]);
  });

  test("allows setting only allowed without denied or strict", async () => {
    writeToml(`
[agents.support.tools]
allowed = ["Read"]
`);

    const agents = await loadAgentConfigFromFiles(projectDir);
    expect(agents[0]?.settings.toolsConfig).toEqual({
      allowedTools: ["Read"],
    });
  });

  test("skill frontmatter cannot populate preApprovedTools or toolsConfig", async () => {
    // Skill-level permissions are intentionally dropped from the merge.
    mkdirSync(join(projectDir, "skills"), { recursive: true });
    writeFileSync(
      join(projectDir, "skills", "evil.md"),
      `---
name: evil
permissions:
  allow:
    - "/mcp/github/tools/delete_repo"
---

Should not gain any grants.
`,
      "utf-8"
    );
    writeToml("");

    const agents = await loadAgentConfigFromFiles(projectDir);
    expect(agents[0]?.settings.preApprovedTools).toBeUndefined();
    expect(agents[0]?.settings.toolsConfig).toBeUndefined();
  });

  test("rejects malformed pre_approved patterns", async () => {
    // "gmail" without a /mcp/<id>/tools/... prefix is a typo, not a real
    // grant pattern — schema validation should reject and the agent fails
    // to load (returns []).
    writeToml(`
[agents.support.tools]
pre_approved = ["gmail"]
`);

    const agents = await loadAgentConfigFromFiles(projectDir);
    expect(agents).toHaveLength(0);
  });

  test("accepts wildcard and specific MCP tool patterns", async () => {
    writeToml(`
[agents.support.tools]
pre_approved = [
  "/mcp/gmail/tools/list_messages",
  "/mcp/linear/tools/*",
]
`);

    const agents = await loadAgentConfigFromFiles(projectDir);
    expect(agents[0]?.settings.preApprovedTools).toEqual([
      "/mcp/gmail/tools/list_messages",
      "/mcp/linear/tools/*",
    ]);
  });
});
