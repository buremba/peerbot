import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOwlettoMemoryEnvFromProject,
  loadAgentConfigFromFiles,
} from "../config/file-loader.js";

const originalMemoryUrl = process.env.MEMORY_URL;

function restoreMemoryUrl(): void {
  if (originalMemoryUrl === undefined) {
    delete process.env.MEMORY_URL;
  } else {
    process.env.MEMORY_URL = originalMemoryUrl;
  }
}

describe("applyOwlettoMemoryEnvFromProject", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "lobu-file-loader-memory-"));
    mkdirSync(join(projectDir, "agents", "support"), { recursive: true });
    delete process.env.MEMORY_URL;
  });

  afterEach(() => {
    restoreMemoryUrl();
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeProject(memoryBlock: string): void {
    writeFileSync(
      join(projectDir, "lobu.toml"),
      `
[agents.support]
name = "support"
dir = "./agents/support"

${memoryBlock}
`,
      "utf-8"
    );
  }

  test("derives a hosted scoped MCP URL from [memory.owletto]", async () => {
    writeProject(
      `[memory.owletto]
enabled = true
org = "careops"
name = "Healthcare"
`
    );

    const memoryUrl = await applyOwlettoMemoryEnvFromProject(projectDir);

    expect(memoryUrl).toBe("https://lobu.ai/mcp/careops");
    expect(process.env.MEMORY_URL).toBe("https://lobu.ai/mcp/careops");
  });

  test("uses MEMORY_URL as the base endpoint before scoping to the project org", async () => {
    process.env.MEMORY_URL = "https://memory.example.com/mcp";
    writeProject(
      `[memory.owletto]
enabled = true
org = "careops"
name = "Healthcare"
`
    );

    const memoryUrl = await applyOwlettoMemoryEnvFromProject(projectDir);

    expect(memoryUrl).toBe("https://memory.example.com/mcp/careops");
    expect(process.env.MEMORY_URL).toBe(
      "https://memory.example.com/mcp/careops"
    );
  });

  test("does nothing when [memory.owletto] is disabled", async () => {
    process.env.MEMORY_URL = "https://memory.example.com/mcp";
    writeProject(
      `[memory.owletto]
enabled = false
org = "careops"
name = "Healthcare"
`
    );

    const memoryUrl = await applyOwlettoMemoryEnvFromProject(projectDir);

    expect(memoryUrl).toBeNull();
    expect(process.env.MEMORY_URL).toBe("https://memory.example.com/mcp");
  });
});

describe("loadAgentConfigFromFiles — local skills only", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "lobu-file-loader-local-skills-"));
    mkdirSync(join(projectDir, "agents", "support"), { recursive: true });
    mkdirSync(join(projectDir, "skills", "research"), { recursive: true });
    writeFileSync(
      join(projectDir, "skills", "research", "SKILL.md"),
      "Research carefully.",
      "utf-8"
    );
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("loads local skills without any bundled skill registry", async () => {
    writeFileSync(
      join(projectDir, "lobu.toml"),
      `
[agents.support]
name = "support"
dir = "./agents/support"

[memory.owletto]
enabled = true
`,
      "utf-8"
    );

    const agents = await loadAgentConfigFromFiles(projectDir);
    const repos =
      agents[0]?.settings.skillsConfig?.skills.map((s) => s.repo) ?? [];

    expect(repos).toEqual(["local/research"]);
  });
});
