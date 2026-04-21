import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDockerCompose, generateLobuToml } from "../commands/init";

describe("init memory scaffolding", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "lobu-init-memory-"));
    mkdirSync(join(projectDir, "agents", "support"), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("generateLobuToml inlines the [memory.owletto] fields when enabled", async () => {
    await generateLobuToml(projectDir, {
      agentName: "support",
      allowedDomains: "github.com,.github.com",
      includeOwlettoMemory: true,
      owlettoOrg: "support",
      owlettoName: "Support",
      owlettoDescription: "Help support teams",
    });

    const content = readFileSync(join(projectDir, "lobu.toml"), "utf-8");

    expect(content).toContain("[memory.owletto]");
    expect(content).toContain('org = "support"');
    expect(content).toContain('name = "Support"');
    expect(content).toContain('description = "Help support teams"');
    expect(content).toContain('models = "./models"');
    expect(content).toContain('data = "./data"');
    expect(content).not.toContain("owletto.yaml");
    expect(existsSync(join(projectDir, "owletto.yaml"))).toBe(false);
  });

  test("generateLobuToml falls back to the agent name when org/name are omitted", async () => {
    await generateLobuToml(projectDir, {
      agentName: "support",
      allowedDomains: "github.com",
      includeOwlettoMemory: true,
    });

    const content = readFileSync(join(projectDir, "lobu.toml"), "utf-8");

    expect(content).toContain('org = "support"');
    expect(content).toContain('name = "Support"');
  });

  test("generateDockerCompose keeps MEMORY_URL as an optional base override", () => {
    const content = generateDockerCompose({
      projectName: "support",
      gatewayPort: "8080",
      dockerfilePath: "./Dockerfile.worker",
      deploymentMode: "embedded",
      includeOwlettoLocal: true,
    });

    expect(content).toContain("Optional Lobu memory base MCP URL override");
    expect(content).toContain("MEMORY_URL: ${MEMORY_URL:-}");
    expect(content).toContain("owletto:");
    expect(content).toContain("owletto-postgres:");
  });
});
