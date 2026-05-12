import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";

import { isPortFree } from "../commands/dev";
import { agentScaffoldCommand } from "../commands/agent";
import { evalNewCommand } from "../commands/eval";
import { loadProjectLink, saveProjectLink } from "../internal/project-link";
import { initCommand } from "../commands/init";

describe("isPortFree", () => {
  test("returns true for a port nothing is holding", async () => {
    // Pick a high port, almost certainly free.
    const port = 49152 + Math.floor(Math.random() * 10_000);
    expect(await isPortFree(port)).toBe(true);
  });

  test("returns false when a server is bound", async () => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen({ port: 0, host: "127.0.0.1" }, () => resolve())
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected AddressInfo");
    }
    try {
      expect(await isPortFree(address.port)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("project-link round-trip", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "lobu-link-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("save then load returns the same context+org", async () => {
    const saved = await saveProjectLink(cwd, {
      context: "lobu",
      org: "acme",
    });
    expect(saved.context).toBe("lobu");
    expect(saved.org).toBe("acme");
    expect(saved.linkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const loaded = await loadProjectLink(cwd);
    expect(loaded?.context).toBe("lobu");
    expect(loaded?.org).toBe("acme");
  });

  test("load returns null when no link file exists", async () => {
    expect(await loadProjectLink(cwd)).toBeNull();
  });

  test("save appends `.lobu/` to an existing .gitignore exactly once", async () => {
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
    await saveProjectLink(cwd, { context: "lobu", org: "acme" });
    await saveProjectLink(cwd, { context: "lobu", org: "acme2" });
    const content = readFileSync(join(cwd, ".gitignore"), "utf-8");
    expect(content.match(/^\.lobu\/$/gm)?.length ?? 0).toBe(1);
    expect(content).toContain("node_modules/");
  });
});

describe("lobu init --yes", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "lobu-init-yes-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("scaffolds a non-interactive project with defaults", async () => {
    await initCommand(cwd, "demo", { yes: true });
    const proj = join(cwd, "demo");
    expect(existsSync(join(proj, "lobu.toml"))).toBe(true);
    expect(existsSync(join(proj, ".env"))).toBe(true);
    expect(existsSync(join(proj, "agents", "demo", "IDENTITY.md"))).toBe(true);
    expect(existsSync(join(proj, "agents", "demo", "evals", "ping.yaml"))).toBe(
      true
    );
    const env = readFileSync(join(proj, ".env"), "utf-8");
    expect(env.includes("SENTRY_DSN=")).toBe(false);
  });

  test("--here scaffolds into the current directory", async () => {
    await initCommand(cwd, undefined, { yes: true, here: true });
    expect(existsSync(join(cwd, "lobu.toml"))).toBe(true);
    expect(existsSync(join(cwd, "agents"))).toBe(true);
  });

  test("--sentry writes SENTRY_DSN", async () => {
    await initCommand(cwd, "sentry-on", { yes: true, sentry: true });
    const env = readFileSync(join(cwd, "sentry-on", ".env"), "utf-8");
    expect(env).toMatch(/SENTRY_DSN=/);
  });

  test("--slack-preview writes agent preview config", async () => {
    await initCommand(cwd, "preview-on", { yes: true, slackPreview: true });
    const toml = readFileSync(join(cwd, "preview-on", "lobu.toml"), "utf-8");
    expect(toml).toContain("[agents.preview-on.preview.slack]");
    expect(toml).toContain("enabled = true");
    expect(toml).toContain('provider = "lobu-public"');
    expect(toml).toContain('surfaces = ["dm"]');
  });

  test("--provider with bad id throws before writing files", async () => {
    await expect(
      initCommand(cwd, "bad-provider", {
        yes: true,
        provider: "definitely-not-a-real-provider",
      })
    ).rejects.toThrow(/Unknown provider/);
  });
});

describe("agent scaffold", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "lobu-scaffold-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("appends a new agent block to lobu.toml", async () => {
    writeFileSync(
      join(cwd, "lobu.toml"),
      ["[agents.first]", 'name = "first"', 'dir = "./agents/first"', ""].join(
        "\n"
      )
    );
    await agentScaffoldCommand("second", { cwd, name: "Second" });
    const toml = readFileSync(join(cwd, "lobu.toml"), "utf-8");
    expect(toml).toContain("[agents.second]");
    expect(toml).toContain('name = "Second"');
    expect(toml).toContain('dir = "./agents/second"');
    expect(existsSync(join(cwd, "agents", "second", "IDENTITY.md"))).toBe(true);
    expect(existsSync(join(cwd, "agents", "second", "SOUL.md"))).toBe(true);
    expect(existsSync(join(cwd, "agents", "second", "USER.md"))).toBe(true);
  });

  test("escapes quotes in --name so the TOML stays parseable", async () => {
    writeFileSync(join(cwd, "lobu.toml"), "");
    await agentScaffoldCommand("quoty", {
      cwd,
      name: 'Sales "Bot" v2',
    });
    const toml = readFileSync(join(cwd, "lobu.toml"), "utf-8");
    expect(toml).toContain('name = "Sales \\"Bot\\" v2"');
  });
});

describe("eval new", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "lobu-eval-new-"));
    writeFileSync(
      join(cwd, "lobu.toml"),
      [
        "[agents.demo]",
        'name = "demo"',
        'dir = "./agents/demo"',
        "",
        "[agents.demo.skills]",
        "",
        "[agents.demo.network]",
        "allowed = []",
        "",
      ].join("\n")
    );
    mkdirSync(join(cwd, "agents", "demo"), { recursive: true });
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("creates evals/<name>.yaml with a sane template", async () => {
    await evalNewCommand("smoke", { cwd, description: "smoke test" });
    const file = join(cwd, "agents", "demo", "evals", "smoke.yaml");
    expect(existsSync(file)).toBe(true);
    const yaml = readFileSync(file, "utf-8");
    expect(yaml).toContain("name: smoke");
    expect(yaml).toContain("smoke test");
    expect(yaml).toContain("type: llm-rubric");
  });
});
