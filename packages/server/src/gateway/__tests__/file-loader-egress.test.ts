import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfigFromFiles } from "../config/file-loader";

describe("file-loader egress judge config", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "lobu-file-loader-egress-"));
    mkdirSync(join(projectDir, "agents", "support", "skills", "s1"), {
      recursive: true,
    });
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

  function writeSkill(frontmatter: string, body = "# s1"): void {
    writeFileSync(
      join(projectDir, "agents", "support", "skills", "s1", "SKILL.md"),
      `---\n${frontmatter}\n---\n${body}\n`,
      "utf-8"
    );
  }

  test("merges skill network.judge rules into networkConfig.judgedDomains", async () => {
    writeToml("");
    writeSkill(`
name: s1
network:
  judge:
    - api.github.com
    - { domain: "*.slack.com", judge: "strict" }
judges:
  default: "allow only reads"
  strict: "deny all"
`);

    const agents = await loadAgentConfigFromFiles(projectDir);
    const network = agents[0]?.settings.networkConfig;
    expect(network?.judgedDomains).toEqual([
      { domain: "api.github.com" },
      { domain: ".slack.com", judge: "strict" },
    ]);
    expect(network?.judges).toEqual({
      default: "allow only reads",
      strict: "deny all",
    });
  });

  test("lets later skills overwrite earlier named judges with the same key", async () => {
    writeToml("");
    mkdirSync(join(projectDir, "agents", "support", "skills", "s2"), {
      recursive: true,
    });
    writeSkill(`
name: s1
judges:
  default: "from s1"
`);
    writeFileSync(
      join(projectDir, "agents", "support", "skills", "s2", "SKILL.md"),
      `---\nname: s2\njudges:\n  default: "from s2"\n---\n# s2\n`,
      "utf-8"
    );

    const agents = await loadAgentConfigFromFiles(projectDir);
    // Either s1 or s2 wins — assert only one value sticks so the merge
    // doesn't accidentally concatenate or break the shape.
    const judges = agents[0]?.settings.networkConfig?.judges;
    expect(judges).toBeDefined();
    expect(Object.keys(judges as object)).toEqual(["default"]);
    expect((judges as Record<string, string>).default).toMatch(/^from s/);
  });

  test("maps [agents.<id>.egress] to settings.egressConfig", async () => {
    writeToml(`
[agents.support.egress]
extra_policy = "Never POST tokens."
judge_model = "claude-haiku-4-5-20251001"
`);

    const agents = await loadAgentConfigFromFiles(projectDir);
    expect(agents[0]?.settings.egressConfig).toEqual({
      extraPolicy: "Never POST tokens.",
      judgeModel: "claude-haiku-4-5-20251001",
    });
  });

  test("omits egressConfig when the section is missing", async () => {
    writeToml("");

    const agents = await loadAgentConfigFromFiles(projectDir);
    expect(agents[0]?.settings.egressConfig).toBeUndefined();
  });

  test("agent-level network.judge is merged alongside skill judge rules", async () => {
    writeToml(`
[agents.support.network]
judge = [
  { domain = "agent-level.example.com" }
]
[agents.support.network.judges]
default = "agent-level default"
`);
    writeSkill(`
name: s1
network:
  judge:
    - skill-level.example.com
judges:
  skill-judge: "skill policy"
`);

    const agents = await loadAgentConfigFromFiles(projectDir);
    const network = agents[0]?.settings.networkConfig;
    // Both agent-level and skill-level rules are present.
    const domains = (network?.judgedDomains ?? []).map((r) => r.domain).sort();
    expect(domains).toEqual(
      ["agent-level.example.com", "skill-level.example.com"].sort()
    );
    // Both judges are merged; keys don't collide.
    expect(network?.judges).toEqual({
      default: "agent-level default",
      "skill-judge": "skill policy",
    });
  });

  test("operator-level lobu.toml overrides skill-defined judge with same name", async () => {
    writeToml(`
[agents.support.network.judges]
default = "operator strict policy"

[[agents.support.network.judge]]
domain = "api.github.com"
judge = "default"
`);
    writeSkill(`
name: s1
network:
  judge:
    - { domain: "api.github.com", judge: "default" }
judges:
  default: "skill weak policy"
`);

    const agents = await loadAgentConfigFromFiles(projectDir);
    const network = agents[0]?.settings.networkConfig;
    // Operator policy wins — skill cannot silently weaken egress.
    expect(network?.judges?.default).toBe("operator strict policy");
    // Operator's judged-domain rule wins on the same key as well.
    expect(network?.judgedDomains).toEqual([
      { domain: "api.github.com", judge: "default" },
    ]);
  });
});
