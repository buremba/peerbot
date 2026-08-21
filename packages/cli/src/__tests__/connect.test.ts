import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConnectPlan,
  CONNECT_TARGET_IDS,
  configureTarget,
  isConnectTargetId,
  upsertMcpServer,
} from "../commands/connect/install-targets";
import { DEFAULT_LOBU_MCP_URL } from "../internal/context";

describe("lobu connect plans", () => {
  test("Claude Code installs the shared hosted plugin non-interactively", () => {
    const plan = buildConnectPlan("claude-code", DEFAULT_LOBU_MCP_URL);

    expect(plan.mode).toBe("automatic");
    expect(plan.commands).toEqual([
      {
        command: "claude",
        args: [
          "plugin",
          "marketplace",
          "add",
          "lobu-ai/lobu",
          // Without a sparse checkout Claude Code clones the whole monorepo
          // to reach two small plugin directories.
          "--sparse",
          ".claude-plugin",
          "claude-plugin",
        ],
        allowAlreadyPresent: true,
      },
      {
        command: "claude",
        args: ["plugin", "install", "lobu@lobu"],
        allowAlreadyPresent: true,
      },
    ]);
    expect(plan.skillDirectory).toBeUndefined();
  });

  test("Codex installs the shared hosted plugin non-interactively", () => {
    const plan = buildConnectPlan("codex", DEFAULT_LOBU_MCP_URL);

    expect(plan.mode).toBe("automatic");
    expect(plan.commands).toEqual([
      {
        command: "codex",
        args: ["plugin", "marketplace", "add", "lobu-ai/lobu"],
        allowAlreadyPresent: true,
      },
      {
        command: "codex",
        args: ["plugin", "add", "lobu@lobu"],
        allowAlreadyPresent: true,
      },
    ]);
    expect(plan.instructions).toContain("fresh Codex session");
  });

  test("custom Codex setup uses native MCP plus the bundled skill", () => {
    const plan = buildConnectPlan(
      "codex",
      "https://example.test/mcp/workspace"
    );

    expect(plan.mode).toBe("automatic");
    expect(plan.commands[0]).toEqual({
      command: "codex",
      args: [
        "mcp",
        "add",
        "lobu-workspace",
        "--url",
        "https://example.test/mcp/workspace",
      ],
      allowAlreadyPresent: true,
    });
    expect(plan.serverName).toBe("lobu-workspace");
    expect(plan.skillDirectory).toEndWith("/skills/lobu");
  });

  test("custom Claude setup is user-wide and avoids the hosted Lobu name", () => {
    const plan = buildConnectPlan(
      "claude-code",
      "http://127.0.0.1:9677/mcp/local-install"
    );

    expect(plan.commands[0]).toEqual({
      command: "claude",
      args: [
        "mcp",
        "add",
        "--scope",
        "user",
        "--transport",
        "http",
        "lobu-local-install",
        "http://127.0.0.1:9677/mcp/local-install",
      ],
      allowAlreadyPresent: true,
    });
    expect(plan.serverName).toBe("lobu-local-install");
    expect(plan.instructions).toContain("lobu-local-install tool");
  });

  test("OpenCode dry-run shows native MCP and skill setup without executing", async () => {
    const plan = buildConnectPlan(
      "opencode",
      "https://example.test/mcp/workspace"
    );
    const result = await configureTarget(plan, { dryRun: true });

    // `opencode mcp add` takes the name and URL as arguments, so setup never
    // hands the terminal to its prompt.
    expect(plan.commands).toEqual([
      {
        command: "opencode",
        args: [
          "mcp",
          "add",
          "lobu-workspace",
          "--url",
          "https://example.test/mcp/workspace",
        ],
        allowAlreadyPresent: true,
      },
    ]);
    expect(result.status).toBe("handoff");
    expect(result.instructions).toContain(
      "opencode mcp add lobu-workspace --url https://example.test/mcp/workspace"
    );
    expect(result.instructions).toContain("opencode/skills/lobu/SKILL.md");
  });

  test("Antigravity uses its current MCP profile and global skill path", () => {
    const plan = buildConnectPlan(
      "antigravity",
      "https://example.test/mcp/workspace"
    );

    expect(plan.mode).toBe("automatic");
    expect(plan.commands).toEqual([]);
    expect(plan.endpoint).toBe("https://example.test/mcp/workspace");
    // Antigravity only discovers skills under a customization root, as
    // `<root>/skills/<name>/SKILL.md`; ~/.gemini/antigravity-cli is app state.
    expect(plan.skillDirectory).toEndWith("/.gemini/config/skills/lobu");
    expect(plan.configUrlKey).toBe("serverUrl");
    expect(plan.serverName).toBe("lobu-workspace");
  });

  test("Cursor installs the shared skill next to its MCP configuration", () => {
    const plan = buildConnectPlan("cursor", DEFAULT_LOBU_MCP_URL);

    expect(plan.configUrlKey).toBe("url");
    expect(plan.skillDirectory).toEndWith("/.cursor/skills/lobu");
  });

  test("MCP config updates preserve existing settings and leave current files untouched", () => {
    const home = mkdtempSync(join(tmpdir(), "lobu-connect-test-"));
    const configDirectory = join(home, ".cursor");
    const configPath = join(configDirectory, "mcp.json");
    const original =
      '{"mcpServers":{"lobu":{"url":"https://old.example/mcp","headers":{"x-test":"kept"},"disabled":true},"other":{"url":"https://other.example/mcp"}}}\n';

    try {
      mkdirSync(configDirectory, { recursive: true });
      writeFileSync(configPath, original);

      const updated = upsertMcpServer(
        configPath,
        "lobu",
        "https://new.example/mcp",
        "url"
      );
      expect(updated).toBe("updated");
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
        mcpServers: {
          lobu: {
            url: "https://new.example/mcp",
            headers: { "x-test": "kept" },
            disabled: true,
          },
          other: { url: "https://other.example/mcp" },
        },
      });

      const current = readFileSync(configPath, "utf8");
      const unchanged = upsertMcpServer(
        configPath,
        "lobu",
        "https://new.example/mcp",
        "url"
      );
      expect(unchanged).toBe("unchanged");
      expect(readFileSync(configPath, "utf8")).toBe(current);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("every documented target has a setup plan", () => {
    for (const id of CONNECT_TARGET_IDS) {
      expect(buildConnectPlan(id, DEFAULT_LOBU_MCP_URL).id).toBe(id);
    }
  });

  test("does not pretend an unknown client can be configured", () => {
    expect(isConnectTargetId("other")).toBe(false);
    expect(isConnectTargetId("gemini-cli")).toBe(false);
  });
});
